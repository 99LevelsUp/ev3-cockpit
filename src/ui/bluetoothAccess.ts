/**
 * The extension's side of owner decision D4 (step-7 plan, U8 review #11): BlueZ refused this user,
 * because the distribution limits it to the `bluetooth` group. Ask, run the fix on a yes (polkit
 * asks for the password, nothing passes through the cockpit), then offer to check again; where it
 * cannot run, show the command.
 *
 * Asked once. The bus refuses every call, so the refusal comes back on each start and reconnect; a
 * question that came back with it would be nagging. Only "check again" opens the question again,
 * for the case where the user joined the group and BlueZ still refuses until they log in anew.
 */

import type { BluetoothAccessFix } from '../transports/bluezAccess';

/** What the extension shows. */
export interface BluetoothAccessUi {
	/** A modal question showing the exact command; true only for an explicit yes. */
	confirm(message: string, command: string): Promise<boolean>;
	/** The user was added: says it applies after logging in anew; true when they choose to check again. */
	added(message: string): Promise<boolean>;
	/** It could not run here: the command to run, and why. */
	manual(command: string, reason: string): Promise<void>;
}

export interface BluetoothAccessLog {
	info(message: string): void;
	warn(message: string): void;
}

/** Returns what the runtime calls when BlueZ refuses this user (`onBluetoothAccessDenied`). */
export function createBluetoothAccessOffer(ui: BluetoothAccessUi, log: BluetoothAccessLog): (fix: BluetoothAccessFix) => void {
	let asking = false;
	let answered = false;

	return (fix) => {
		if (asking || answered) { return; }
		asking = true;
		void (async () => {
			try {
				const result = await fix.offer(({ message, command }) => ui.confirm(message, command));
				switch (result.kind) {
				case 'added':
					log.info(`Bluetooth: ${result.message}`);
					if (await ui.added(result.message)) {
						// Not answered, and not asking any more before the restart: BlueZ's refusal can come
						// back during it (the login may still be the old one), and that one asks again.
						asking = false;
						await fix.checkAgain();
						return;
					}
					break;
				case 'manual':
					log.warn(`Bluetooth: BlueZ refused this user; run "${result.command}" (${result.reason})`);
					await ui.manual(result.command, result.reason);
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
				asking = false;
			}
		})();
	};
}
