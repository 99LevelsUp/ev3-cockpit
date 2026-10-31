/**
 * The "Connect a Brick" command (step-2 plan, R18, U9): pick a brick from a list that keeps
 * changing while it is open, then pair it if nobody has, and sign it in.
 *
 * Free of `vscode`, so the flow can be tested over the real discovery and brick layer; the
 * command in `extension.ts` hands it a QuickPick, progress notifications and messages.
 */

import { BrickId, Transport, brickKeyId } from '../contracts';
import { BrickUnreachableError, ConnectionAbandonedError, TimeoutError } from '../errors/CockpitError';
import type { BrickManager } from '../runtime/brickManager';
import { brickLabel, transportLabel } from '../runtime/brickLabels';
import type { RuntimeLog } from '../runtime/createRuntime';
import type { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import type { PresenceAggregator } from '../runtime/presenceAggregator';
import type { PairingResult } from '../transports/btClassicDiscovery';
import type { BtPairingEvent } from '../transports/btPairingHelper';
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

/** What connecting a picked brick needs besides the brick layer. */
export interface ConnectBrickDeps {
	readonly aggregator: Pick<PresenceAggregator, 'getBrick'>;
	readonly bricks: Pick<BrickManager, 'isSignedIn' | 'setActiveBrick' | 'signIn' | 'routeOf'>;
	readonly scheduler: Pick<DiscoveryScheduler, 'scanOnce'>;
	/** Pairs a brick over Bluetooth; absent without Bluetooth. */
	readonly pair?: (mac: string, onEvent?: (event: BtPairingEvent) => void) => Promise<PairingResult>;
	readonly log: RuntimeLog;
	/** A notification that stays up while `task` runs; `task` may change its message. */
	readonly progress: <T>(title: string, task: (report: (message: string) => void) => Promise<T>) => PromiseLike<T>;
	readonly showInfo: (message: string) => void;
	readonly showError: (message: string) => void;
}

/**
 * Makes a signed-in brick the active one; otherwise pairs a brick only an inquiry has heard,
 * and signs the brick in over every channel it is available on (KD1).
 */
export async function connectPickedBrick(picked: BrickId, deps: ConnectBrickDeps): Promise<void> {
	const { aggregator, bricks, scheduler, log } = deps;
	const brick = aggregator.getBrick(picked);
	const label = brick?.name.value ?? picked;
	if (bricks.isSignedIn(picked)) {
		bricks.setActiveBrick(picked);
		deps.showInfo(`EVƎ Cockpit: ${label} is the active brick.`);
		return;
	}

	// A brick only an inquiry has heard has nothing to connect over until it is paired.
	const bt = brick?.channels.find((c) => c.transport === Transport.BT);
	const onlyNewBluetooth = brick && !brick.paired && bt && brick.channels.length === 1;
	if (onlyNewBluetooth && deps.pair) {
		const pair = deps.pair;
		const mac = brickKeyId(bt.brickKey) ?? '';
		const paired = await deps.progress(`EVƎ Cockpit: pairing ${label}`, async (report) => {
			const result = await pair(mac, (event: BtPairingEvent) => {
				log.debug(`Pairing ${brickLabel(aggregator, picked)}: ${JSON.stringify(event)}`);
				// Prompt on `found`, not on `pairingRequested`: by the time the brick is
				// asking, whoever is meant to press it has seconds. On `found` they have
				// the whole ceremony.
				if (event.type === 'found' && event.alreadyPaired === false) {
					report('Confirm on the brick\'s display, then accept PIN 1234.');
				}
			});
			if (!result.ok) {
				log.warn(`Pairing ${brickLabel(aggregator, picked)} failed: ${result.reason ?? 'no reason given'}`);
				deps.showError(`EVƎ Cockpit: could not pair ${label} — ${result.reason ?? 'no reason given.'}`);
			}
			return result.ok;
		});
		if (!paired) { return; }
	}

	await deps.progress(`EVƎ Cockpit: connecting to ${label}`, async () => {
		// A freshly paired brick is not in the discovery list as paired yet — the OS knows
		// the pairing immediately, the next scheduled scan is up to a poll interval away.
		await scheduler.scanOnce().catch(() => { /* connect is what matters here */ });
		try {
			await bricks.signIn(picked);
			const route = bricks.routeOf(picked);
			log.info(`Connected to ${brickLabel(aggregator, picked)} over ${route ? transportLabel(route) : 'no channel'}`);
			deps.showInfo(`EVƎ Cockpit: connected to ${label}.`);
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
			deps.showError(unanswered
				? `EVƎ Cockpit: ${label} did not answer. Check that it is switched on and in range, then try again.`
				: `EVƎ Cockpit: could not connect to ${label} — ${err.message}`);
		}
	});
}
