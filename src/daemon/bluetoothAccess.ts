/**
 * Linux, owner decision D4: BlueZ refused this user, typically a distribution that limits Bluetooth
 * to the `bluetooth` group. The daemon asks a person once to be added, lets polkit run the fix, and
 * checks again only when the person was added and says so.
 *
 * Once asked and answered, a later refusal is not asked about again: BlueZ refuses at every retry
 * until the person logs in again, and each refusal would otherwise reopen the question.
 */

import type { QuestionAnswer, QuestionKind } from '../contract/models';
import type { BluetoothAccessFix } from '../core/transports/bluezAccess';

export interface BluetoothAccessDeps {
	/** Whether a VS Code window or a terminal is connected to ask; with nobody, the refusal is only logged.
	 * A later refusal asks again once someone is there. */
	readonly canAsk: () => boolean;
	/** Asks the person behind a VS Code window or a terminal; `keep` when nobody can be asked. */
	readonly ask: (question: { readonly kind: QuestionKind; readonly text: string; readonly details?: readonly string[] }) => Promise<QuestionAnswer>;
	readonly log: { info(message: string): void; warn(message: string): void };
}

/** Returns what the runtime calls when BlueZ refuses this user (`onBluetoothAccessDenied`). */
export function createBluetoothAccessQuestion(deps: BluetoothAccessDeps): (fix: BluetoothAccessFix) => void {
	const { ask, canAsk, log } = deps;
	let asking = false;
	let answered = false;
	/** Which question is the open one: an earlier one ending must not clear a later one's flag. */
	let current = 0;

	return (fix) => {
		log.warn(`Bluetooth: BlueZ refused this user. The fix: ${fix.command}`);
		if (asking || answered || !canAsk()) { return; }
		asking = true;
		const mine = ++current;
		void (async () => {
			try {
				const result = await fix.offer(async ({ message, command }) =>
					(await ask({ kind: 'bluetoothAccess', text: message, details: [command] })) === 'yes');
				switch (result.kind) {
				case 'added':
					log.info(`Bluetooth: ${result.message}`);
					if ((await ask({ kind: 'bluetoothCheckAgain', text: `${result.message} Check Bluetooth again now?` })) === 'yes') {
						// Not answered, and not asking any more before the check: BlueZ's refusal can come back
						// during it (the login may still be the old one), and that one asks again.
						asking = false;
						await fix.checkAgain();
						return;
					}
					break;
				case 'manual':
					log.warn(`Bluetooth: BlueZ refused this user; run "${result.command}" (${result.reason})`);
					break;
				case 'cancelled':
					log.info('Bluetooth: the system dialog for joining the bluetooth group was dismissed');
					break;
				case 'declined':
					log.info(`Bluetooth: not added to the bluetooth group; to do it later: ${fix.command}`);
					break;
				}
				answered = true;
			} catch (error) {
				answered = true;
				log.warn(`Bluetooth: could not offer the bluetooth group fix: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				if (current === mine) { asking = false; }
			}
		})();
	};
}
