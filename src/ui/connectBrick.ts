/**
 * The "Connect a Brick" command (step-2 plan, R18, U9): pick a brick from a list that keeps
 * changing while it is open, then pair it if nobody has, and sign it in.
 *
 * Free of `vscode`, so the flow can be tested over the real discovery and brick layer; the
 * command in `extension.ts` hands it a QuickPick, progress notifications and messages.
 */

import { BrickId, ChannelState, Transport } from '../contracts';
import { BrickUnreachableError, ConnectionAbandonedError, TimeoutError } from '../errors/CockpitError';
import type { BrickManager, PairingStartedEvent } from '../runtime/brickManager';
import type { OneSidedRepair } from '../runtime/forgetReport';
import { brickLabel, transportLabel } from '../runtime/brickLabels';
import type { RuntimeLog } from '../runtime/createRuntime';
import type { PresenceAggregator } from '../runtime/presenceAggregator';
import { PAIRING_CANCELLED } from '../transports/btPairingHelper';
import { BrickPickRow, brickPickRows } from './brickPickRows';

/** The picker as the flow uses it; a `vscode.QuickPick<BrickPickRow>` is one. */
export interface BrickPickerView {
	items: readonly BrickPickRow[];
	activeItems: readonly BrickPickRow[];
	readonly selectedItems: readonly BrickPickRow[];
	busy: boolean;
	onDidAccept(listener: () => void): unknown;
	onDidHide(listener: () => void): unknown;
	show(): void;
	hide(): void;
	dispose(): void;
}

/**
 * Shows the bricks and resolves with the one picked, or undefined when the picker is closed.
 *
 * @param runInquiry Looks for Bluetooth bricks nobody has paired; absent without Bluetooth.
 */
export async function pickBrick(
	picker: BrickPickerView,
	aggregator: Pick<PresenceAggregator, 'getDiscoveryList' | 'onListChanged'>,
	isSignedIn: (brickId: BrickId) => boolean,
	runInquiry?: () => Promise<void>,
): Promise<BrickId | undefined> {
	const render = (): void => {
		const focused = picker.activeItems[0]?.brickId;
		picker.items = brickPickRows(aggregator.getDiscoveryList(), isSignedIn);
		const keep = picker.items.find((item) => item.brickId === focused);
		if (keep) { picker.activeItems = [keep]; }
	};
	const listening = aggregator.onListChanged(render);
	render();

	// Look for new Bluetooth bricks now rather than at the next background round, so one
	// switched on a moment ago shows up while the list is open.
	if (runInquiry) {
		picker.busy = true;
		void runInquiry().finally(() => { picker.busy = false; });
	}

	const picked = await new Promise<BrickId | undefined>((resolve) => {
		picker.onDidAccept(() => resolve(picker.selectedItems[0]?.brickId));
		picker.onDidHide(() => resolve(undefined));
		picker.show();
	});
	listening.dispose();
	picker.hide();
	picker.dispose();
	return picked;
}

/** A notification that stays up while `task` runs; `task` may change its message. */
export type ShowProgress = <T>(title: string, task: (report: (message: string) => void) => Promise<T>) => PromiseLike<T>;

/** What connecting a picked brick needs besides the brick layer. */
export interface ConnectBrickDeps {
	readonly aggregator: Pick<PresenceAggregator, 'getBrick'>;
	readonly bricks: Pick<BrickManager, 'isSignedIn' | 'signIn' | 'routeOf' | 'pair' | 'connectAgain' | 'resumePairing'>;
	readonly log: RuntimeLog;
	readonly progress: ShowProgress;
	readonly showInfo: (message: string) => void;
	readonly showError: (message: string) => void;
}

/**
 * Shows a pairing's progress while it runs, whoever started it: the brick layer announces each
 * pairing, and this tells the person at the brick when to look at its display. A pairing that
 * fails says why, unless it was stopped on purpose by a forget or a clear.
 */
export function followPairing(
	event: PairingStartedEvent,
	deps: {
		readonly aggregator: Pick<PresenceAggregator, 'getBrick'>;
		readonly progress: ShowProgress;
		readonly showError?: (message: string) => void;
	},
): PromiseLike<unknown> {
	let report: ((message: string) => void) | undefined;
	let waiting: string | undefined;
	event.onEvent((pairingEvent) => {
		// Prompt on `found`, not on `pairingRequested`: by the time the brick is asking, whoever
		// is meant to press it has seconds. On `found` they have the whole ceremony.
		if (pairingEvent.type !== 'found' || pairingEvent.alreadyPaired !== false) { return; }
		const message = 'Confirm on the brick\'s display, then accept PIN 1234.';
		if (report) { report(message); } else { waiting = message; }
	});
	const label = deps.aggregator.getBrick(event.brickId)?.name.value ?? event.brickId;
	void event.done.then((result) => {
		if (result.ok || result.reason === PAIRING_CANCELLED) { return; }
		deps.showError?.(`EVƎ Cockpit: could not pair ${label} — ${result.reason ?? 'no reason given.'}`);
	});
	return deps.progress(`EVƎ Cockpit: pairing ${label}`, (reportMessage) => {
		report = reportMessage;
		if (waiting) { reportMessage(waiting); }
		return event.done;
	});
}

/**
 * Connects a brick over every channel that can work (step-4 plan, KTD4). A brick only an inquiry
 * has heard is paired first; one that USB or TCP reaches is signed in over those, and its
 * Bluetooth sighting is paired by the brick layer once it is. A brick already signed in tries
 * every channel that is not connected yet. Either way the user asked, so a pairing they cancelled
 * earlier may be asked again.
 */
export async function connectPickedBrick(picked: BrickId, deps: ConnectBrickDeps): Promise<void> {
	const { aggregator, bricks, log } = deps;
	const brick = aggregator.getBrick(picked);
	const label = brick?.name.value ?? picked;
	bricks.resumePairing(picked);
	if (bricks.isSignedIn(picked)) {
		await connectOver(deps, picked, label, () => bricks.connectAgain(picked), `EVƎ Cockpit: ${label} is the active brick.`);
		return;
	}

	// A brick only an inquiry has heard has nothing to connect over until it is paired. A channel
	// the list still shows lost, a cable pulled since, does not count (U7, 01.11.2026).
	const bt = brick?.channels.find((c) => c.transport === Transport.BT);
	const onlyNewBluetooth = brick && !brick.paired && bt
		&& brick.channels.every((c) => c === bt || c.state === ChannelState.Lost);
	if (onlyNewBluetooth) {
		// The brick layer records a pairing it made at once, so the sign-in below joins the fresh
		// channel without waiting for a scan to read the pairing back from Windows. A failure is
		// shown by the progress that follows every pairing.
		const result = await bricks.pair(picked);
		if (!result.ok) {
			log.warn(`Pairing ${brickLabel(aggregator, picked)} failed: ${result.reason ?? 'no reason given'}`);
			return;
		}
	}

	await connectOver(deps, picked, label, () => bricks.signIn(picked), `EVƎ Cockpit: connected to ${label}.`);
}

/**
 * Whether a failed connect could only have gone over Bluetooth to a paired brick: nothing else
 * that reaches it is there (step-4 plan, R7).
 */
function bluetoothAlone(aggregator: Pick<PresenceAggregator, 'getBrick'>, brickId: BrickId): boolean {
	const brick = aggregator.getBrick(brickId);
	return brick?.paired === true
		&& brick.channels.some((c) => c.transport === Transport.BT)
		&& brick.channels.every((c) => c.transport === Transport.BT
			|| (c.state !== ChannelState.Available && c.state !== ChannelState.Connected));
}

/**
 * What else may be wrong when a paired brick fails over Bluetooth alone (KTD7, R7). Hedged: no
 * error code is known to tell a one-sided pairing from a brick out of reach, so it never says
 * the pairing is broken.
 */
function oneSidedHint(saidInRange: boolean): string {
	return (saidInRange ? '' : ' It may be out of reach.')
		+ ' If it keeps failing while it is in range, its pairing may be one-sided: connect it over USB or TCP'
		+ ' and run "Connect a Brick" again, which repairs it.';
}

async function connectOver(
	deps: ConnectBrickDeps, picked: BrickId, label: string, connect: () => Promise<void>, connected: string,
): Promise<void> {
	const { aggregator, bricks, log } = deps;
	await deps.progress(`EVƎ Cockpit: connecting to ${label}`, async () => {
		try {
			await connect();
			const route = bricks.routeOf(picked);
			log.info(`Connected to ${brickLabel(aggregator, picked)} over ${route ? transportLabel(route) : 'no channel'}`);
			deps.showInfo(connected);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			// The user disconnected it before it was through; nothing failed.
			if (err instanceof ConnectionAbandonedError) {
				log.info(`Connecting to ${brickLabel(aggregator, picked)} stopped: it was disconnected meanwhile`);
				return;
			}
			log.error(`Connecting to ${brickLabel(aggregator, picked)} failed:`, err);
			// The cause of a brick that did not answer is the Winsock code, which says
			// nothing to the person holding the brick; it stays in the log.
			const unanswered = err instanceof BrickUnreachableError || err instanceof TimeoutError;
			deps.showError((unanswered
				? `EVƎ Cockpit: ${label} did not answer. Check that it is switched on and in range, then try again.`
				: `EVƎ Cockpit: could not connect to ${label} — ${err.message}`)
				+ (bluetoothAlone(aggregator, picked) ? oneSidedHint(unanswered) : ''));
		}
	});
}

/**
 * The notification for a pairing found broken on one side (step-4 plan, U7, R6): what was found,
 * what the cockpit did, and, when the brick lists other computers, that "Clear a Brick's
 * Bluetooth List" removes them all.
 *
 * @param label What the user calls the brick.
 * @returns The message, and whether it is a warning: nothing was repaired.
 */
export function describeRepair(repair: OneSidedRepair, label: string): { message: string; warning: boolean } {
	const found = repair.found === 'windows-only'
		? `Windows was paired with ${label}, but ${label} no longer lists this computer.`
		: `${label} still lists this computer, but Windows was not paired with it.`;
	const others = repair.others.length > 0
		? ` ${label} also lists ${repair.others.join(', ')}; "Clear a Brick's Bluetooth List" removes every entry.`
		: '';
	if (repair.repeated) {
		return {
			warning: true,
			message: `EVƎ Cockpit: ${found} It still looks that way after a repair, so the cockpit left it alone. `
				+ `Run "Forget a Brick" on ${label}, then "Connect a Brick".${others}`,
		};
	}
	const half = repair.found === 'windows-only' ? 'Windows\' pairing' : `this computer's entry on ${label}`;
	const removal = repair.removal;
	if (removal?.status !== 'removed' && removal?.status !== 'confirmed') {
		const why = removal?.status === 'refused' ? removal.reason : removal?.detail;
		return {
			warning: true,
			message: `EVƎ Cockpit: ${found} The cockpit could not remove ${half}${why ? ` — ${why}` : '.'} `
				+ `"Forget a Brick" removes both halves.${others}`,
		};
	}
	const next = repair.pairing
		? 'and is pairing again: confirm on the brick\'s display.'
		: '; run "Connect a Brick" to pair again.';
	return { warning: false, message: `EVƎ Cockpit: ${found} The cockpit removed ${half} ${next}${others}` };
}
