/**
 * The "Connect a Brick" command: pick a brick from a list that keeps changing while it is open,
 * then pair it if nobody has, and connect it as this window's active brick.
 *
 * Free of `vscode`, so the flow can be tested over a stand-in for the daemon; the command in
 * `extension.ts` hands it a QuickPick, progress notifications, messages and the bridge.
 */

import type { ContractBrick, OneSidedRepair, PairingProgress, PairingResult } from '../../contract/generated';
import { brickLabel, preferredOrder, transportLabel } from './brickLabels';
import { BrickPickRow, brickPickRows } from './brickPickRows';
import { BrickList, CommandLog, asError, errorCode } from './commandTypes';

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
 * @param runInquiry Looks for Bluetooth bricks nobody has paired.
 */
export async function pickBrick(
	picker: BrickPickerView,
	list: Pick<BrickList, 'bricks' | 'onListChanged'>,
	runInquiry?: () => Promise<void>,
): Promise<string | undefined> {
	const render = (): void => {
		const focused = picker.activeItems[0]?.brickId;
		picker.items = brickPickRows(list.bricks());
		const keep = picker.items.find((item) => item.brickId === focused);
		if (keep) { picker.activeItems = [keep]; }
	};
	const listening = list.onListChanged(render);
	render();

	// Look for new Bluetooth bricks now rather than at the next background round, so one
	// switched on a moment ago shows up while the list is open.
	if (runInquiry) {
		picker.busy = true;
		void runInquiry().catch(() => undefined).finally(() => { picker.busy = false; });
	}

	const picked = await new Promise<string | undefined>((resolve) => {
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

/** A pairing the daemon runs, whoever started it: its steps, and how it ended. */
export interface PairingStartedEvent {
	readonly brickId: string;
	readonly done: Promise<PairingResult>;
	onProgress(listener: (progress: PairingProgress) => void): void;
}

/** The brick layer as connecting uses it: each call a request to the daemon. */
export interface ConnectBricks {
	/** Connects the brick over every channel that can work and makes it this window's active brick. */
	connect(brickId: string): Promise<ContractBrick>;
	pair(brickId: string): Promise<PairingResult>;
}

/** What connecting a picked brick needs. */
export interface ConnectBrickDeps {
	readonly list: BrickList;
	readonly bricks: ConnectBricks;
	readonly log: CommandLog;
	readonly progress: ShowProgress;
	readonly showInfo: (message: string) => void;
	readonly showError: (message: string) => void;
}

/**
 * Shows a pairing's progress while it runs, whoever started it: the daemon announces each
 * pairing, and this tells the person at the brick when to look at its display. A pairing that
 * fails says why; one cancelled, on the brick or by a forget or a clear, says nothing.
 */
export function followPairing(
	event: PairingStartedEvent,
	deps: {
		readonly list: Pick<BrickList, 'brick'>;
		readonly progress: ShowProgress;
		readonly showError?: (message: string) => void;
	},
): PromiseLike<unknown> {
	let report: ((message: string) => void) | undefined;
	let waiting: string | undefined;
	event.onProgress((progress) => {
		// Prompt on `found`, not on `pairingRequested`: by the time the brick is asking, whoever
		// is meant to press it has seconds. On `found` they have the whole ceremony.
		if (progress.phase !== 'found' || progress.alreadyPaired) { return; }
		const message = 'Confirm on the brick\'s display, then accept PIN 1234.';
		if (report) { report(message); } else { waiting = message; }
	});
	const label = deps.list.brick(event.brickId)?.name ?? event.brickId;
	void event.done.then((result) => {
		if (result.outcome !== 'failed') { return; }
		deps.showError?.(`EVƎ Cockpit: could not pair ${label} — ${result.message ?? 'no reason given.'}`);
	});
	return deps.progress(`EVƎ Cockpit: pairing ${label}`, (reportMessage) => {
		report = reportMessage;
		if (waiting) { reportMessage(waiting); }
		return event.done;
	});
}

/**
 * Connects a brick over every channel that can work. A brick only an inquiry has heard is paired
 * first; one that USB or TCP reaches is connected over those, and the daemon pairs its Bluetooth
 * sighting once it is. A brick already connected tries every channel that is not connected yet.
 */
export async function connectPickedBrick(picked: string, deps: ConnectBrickDeps): Promise<void> {
	const { list, bricks, log } = deps;
	const brick = list.brick(picked);
	const label = brick?.name ?? picked;
	if (brick?.connected) {
		await connectOver(deps, picked, label, `EVƎ Cockpit: ${label} is the active brick.`);
		return;
	}

	// A brick only an inquiry has heard has nothing to connect over until it is paired. A channel
	// the list still shows lost, a cable pulled since, does not count.
	const bt = brick?.channels.find((c) => c.transport === 'bt');
	const onlyNewBluetooth = brick && !brick.paired && bt
		&& brick.channels.every((c) => c === bt || c.state === 'lost');
	if (onlyNewBluetooth) {
		// A failure is shown by the progress that follows every pairing.
		const result = await bricks.pair(picked);
		if (result.outcome !== 'paired') {
			log.warn(`Pairing ${brickLabel(list, picked)} ended ${result.outcome}: ${result.message ?? 'no reason given'}`);
			return;
		}
	}

	await connectOver(deps, picked, label, `EVƎ Cockpit: connected to ${label}.`);
}

/**
 * Whether a failed connect could only have gone over Bluetooth to a paired brick: nothing else
 * that reaches it is there.
 */
function bluetoothAlone(list: Pick<BrickList, 'brick'>, brickId: string): boolean {
	const brick = list.brick(brickId);
	return brick?.paired === true
		&& brick.channels.some((c) => c.transport === 'bt')
		&& brick.channels.every((c) => c.transport === 'bt' || c.state === 'lost');
}

/**
 * What else may be wrong when a paired brick fails over Bluetooth alone. Hedged: no error code is
 * known to tell a one-sided pairing from a brick out of reach, so it never says the pairing is
 * broken.
 */
function oneSidedHint(saidInRange: boolean): string {
	return (saidInRange ? '' : ' It may be out of reach.')
		+ ' If it keeps failing while it is in range, its pairing may be one-sided: connect it over USB or TCP'
		+ ' and run "Connect a Brick" again, which repairs it.';
}

async function connectOver(deps: ConnectBrickDeps, picked: string, label: string, connected: string): Promise<void> {
	const { list, bricks, log } = deps;
	await deps.progress(`EVƎ Cockpit: connecting to ${label}`, async () => {
		try {
			const brick = await bricks.connect(picked);
			const route = preferredOrder(brick.channels).find((c) => c.state === 'connected');
			log.info(`Connected to ${brickLabel(list, picked)} over ${route ? transportLabel(route.transport) : 'no channel'}`);
			deps.showInfo(connected);
		} catch (error) {
			const err = asError(error);
			const code = errorCode(error);
			// The user disconnected it before it was through; nothing failed.
			if (code === 'connection_abandoned') {
				log.info(`Connecting to ${brickLabel(list, picked)} stopped: it was disconnected meanwhile`);
				return;
			}
			log.error(`Connecting to ${brickLabel(list, picked)} failed:`, err);
			// The cause of a brick that did not answer is the transport's own code, which says
			// nothing to the person holding the brick; it stays in the log.
			const unanswered = code === 'brick_unreachable' || code === 'timeout';
			deps.showError((unanswered
				? `EVƎ Cockpit: ${label} did not answer. Check that it is switched on and in range, then try again.`
				: `EVƎ Cockpit: could not connect to ${label} — ${err.message}`)
				+ (bluetoothAlone(list, picked) ? oneSidedHint(unanswered) : ''));
		}
	});
}

/**
 * The notification for a pairing found broken on one side: what was found, what the cockpit
 * did, and, when the brick lists other computers, that "Clear a Brick's Bluetooth List" removes
 * them all.
 *
 * @param label What the user calls the brick.
 * @param pairingAgain The daemon started pairing the brick again after the repair.
 * @returns The message, and whether it is a warning: nothing was repaired.
 */
export function describeRepair(repair: OneSidedRepair, label: string, pairingAgain: boolean): { message: string; warning: boolean } {
	const found = repair.found === 'computer-only'
		? `This computer has ${label} paired, but ${label} no longer lists this computer.`
		: `${label} still lists this computer, but this computer does not have it paired.`;
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
	// Not "Windows": the same check runs over BlueZ on Linux.
	const half = repair.found === 'computer-only' ? 'this computer\'s pairing' : `this computer's entry on ${label}`;
	const removal = repair.removal;
	if (removal?.status !== 'removed' && removal?.status !== 'confirmed') {
		const why = removal?.status === 'refused' ? removal.reason : removal?.detail;
		return {
			warning: true,
			message: `EVƎ Cockpit: ${found} The cockpit could not remove ${half}${why ? ` — ${why}` : '.'} `
				+ `"Forget a Brick" removes both halves.${others}`,
		};
	}
	const next = pairingAgain
		? 'and is pairing again: confirm on the brick\'s display.'
		: '; run "Connect a Brick" to pair again.';
	return { warning: false, message: `EVƎ Cockpit: ${found} The cockpit removed ${half} ${next}${others}` };
}
