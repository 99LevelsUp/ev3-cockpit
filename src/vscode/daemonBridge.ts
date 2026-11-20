/**
 * The extension's commands run on the daemon through the client library, with the same shapes the
 * commands used when the cockpit ran inside VS Code: a list of bricks that changes while a picker is
 * open, and a brick layer that connects, pairs, forgets and clears (U11). The commands and their
 * tests stay as they were; only what they talk to changed.
 *
 * Free of `vscode`, so it can be tested over a real daemon.
 *
 * A forget or a clearing the person confirmed in VS Code is not asked about again: the daemon's
 * question for that brick, from this window's own call, is answered from the confirmation already
 * given. Every other question goes to `askPerson`.
 */

import type { CockpitClient } from '../client';
import { ContractError } from '../client/connection';
import type { ContractBrick, Question, QuestionAnswer } from '../contract/models';
import {
	BrickEntry, BrickId, BrickKey, BrickChannelSnapshot, ChannelState, Transport, makeBrickKey,
} from '../core/contracts';
import { BrickUnreachableError, ConnectionAbandonedError, NotConnectedError, TimeoutError } from '../core/errors/CockpitError';
import type { ClearListConfirm, PairingStartedEvent } from '../core/runtime/brickManager';
import type { ClearListReport, ForgetReport, OneSidedRepair } from '../core/runtime/forgetReport';
import type { PairingResult } from '../core/transports/btClassicDiscovery';
import type { BtPairingEvent } from '../core/transports/btPairingHelper';

interface Disposable { dispose(): void }

const STATE: Record<string, ChannelState> = {
	available: ChannelState.Available,
	connected: ChannelState.Connected,
	lost: ChannelState.Lost,
};

/** A brick of the daemon's list as the commands' list rows read it. */
export function toEntry(brick: ContractBrick): BrickEntry {
	const channels: BrickChannelSnapshot[] = brick.channels.map((c, index) => ({
		brickKey: makeBrickKey(c.transport as Transport, brick.brickId),
		transport: c.transport as Transport,
		priority: brick.channels.length - index,
		state: STATE[c.state] ?? ChannelState.Lost,
		lastSeenAt: 0,
	}));
	return {
		brickId: brick.brickId as BrickId,
		name: { value: brick.name, source: brick.nameConfirmed ? 'brick' : 'fallback', confirmed: brick.nameConfirmed },
		channels,
		paired: brick.paired,
		remembered: false,
		favorite: false,
		lastSeenAt: 0,
	};
}

/** A daemon failure as the core error the commands tell apart. */
function asCoreError(error: unknown): unknown {
	if (!(error instanceof ContractError)) { return error; }
	switch (error.kind) {
	case 'BrickUnreachableError': return new BrickUnreachableError(error.message);
	case 'TimeoutError': return new TimeoutError(error.message);
	case 'ConnectionAbandonedError': return new ConnectionAbandonedError(error.message);
	case 'NotConnectedError': return new NotConnectedError(error.message);
	default: return error;
	}
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw asCoreError(error);
	}
}

export interface DaemonBridgeOptions {
	/** Every question the bridge does not answer itself; without it, `keep`. */
	readonly askPerson?: (question: Question) => Promise<QuestionAnswer> | QuestionAnswer;
}

export class DaemonBridge implements Disposable {
	private readonly listeners = new Set<() => void>();
	private readonly pairingListeners = new Set<(event: PairingStartedEvent) => void>();
	private readonly repairListeners = new Set<(repair: OneSidedRepair) => void>();
	/** Forgets this window confirmed and is running, by brick. */
	private readonly confirmedForgets = new Set<string>();
	/** Clearings running from this window, with the confirmation the command asks. */
	private readonly clearings = new Map<string, ClearListConfirm>();
	private readonly subscriptions: Disposable[] = [];

	constructor(private readonly client: CockpitClient, private readonly options: DaemonBridgeOptions = {}) {
		client.onQuestion((question) => this.answer(question));
		this.subscriptions.push(client.onBricksChanged(() => { for (const l of [...this.listeners]) { l(); } }));
		this.subscriptions.push(client.onReconnected(() => { for (const l of [...this.listeners]) { l(); } }));
		this.followPairings();
		this.subscriptions.push(client.on('bricks/oneSidedRepair', (n) => {
			if (!n.repair) { return; }
			for (const l of [...this.repairListeners]) { l(n.repair as OneSidedRepair); }
		}));
	}

	dispose(): void {
		for (const s of this.subscriptions.splice(0)) { s.dispose(); }
		this.listeners.clear();
	}

	/** The list as the pickers read it. */
	readonly aggregator = {
		getDiscoveryList: (): BrickEntry[] => this.client.bricks().map(toEntry),
		getBrick: (brickId: BrickId): BrickEntry | undefined => {
			const brick = this.client.bricks().find((b) => b.brickId === brickId);
			return brick ? toEntry(brick) : undefined;
		},
		onListChanged: (listener: () => void): Disposable => {
			this.listeners.add(listener);
			return { dispose: () => { this.listeners.delete(listener); } };
		},
	};

	/** The brick layer as the commands use it, each call a request to the daemon. */
	readonly bricks = {
		isSignedIn: (brickId: BrickId): boolean => this.client.brick(brickId)?.connected === true,
		signedInBricks: (): BrickId[] => this.client.bricks().filter((b) => b.connected).map((b) => b.brickId as BrickId),
		signIn: (brickId: BrickId): Promise<void> => mapped(async () => {
			await this.client.request('bricks/connect', { brick: brickId });
			await this.client.setActiveBrick(brickId);
		}),
		/** Connected already: the daemon tries every channel that is not connected yet. */
		connectAgain: (brickId: BrickId): Promise<void> => this.bricks.signIn(brickId),
		/** The daemon resumes a cancelled pairing itself on every connect. */
		resumePairing: (_brickId: BrickId): void => undefined,
		routeOf: (brickId: BrickId): BrickKey | undefined => {
			const brick = this.client.brick(brickId);
			const channel = brick?.channels.find((c) => c.state === 'connected');
			return brick && channel ? makeBrickKey(channel.transport as Transport, brick.brickId) : undefined;
		},
		pair: (brickId: BrickId): Promise<PairingResult> => mapped(async () => {
			const result = await this.client.request('bricks/pair', { brick: brickId });
			return { ok: result.paired, ...(result.message ? { reason: result.message } : {}) };
		}),
		forget: (brickId: BrickId): Promise<ForgetReport> => mapped(async () => {
			this.confirmedForgets.add(brickId);
			try {
				const result = await this.client.request('bricks/forget', { brick: brickId });
				return result.details as ForgetReport;
			} finally {
				this.confirmedForgets.delete(brickId);
			}
		}),
		clearBluetoothList: (brickId: BrickId, confirm: ClearListConfirm): Promise<ClearListReport | undefined> => mapped(async () => {
			this.clearings.set(brickId, confirm);
			try {
				const result = await this.client.request('bricks/clearBluetoothList', { brick: brickId });
				return result.details as ClearListReport | undefined;
			} finally {
				this.clearings.delete(brickId);
			}
		}),
		onPairingStarted: (listener: (event: PairingStartedEvent) => void): Disposable => {
			this.pairingListeners.add(listener);
			return { dispose: () => { this.pairingListeners.delete(listener); } };
		},
		onOneSidedRepair: (listener: (repair: OneSidedRepair) => void): Disposable => {
			this.repairListeners.add(listener);
			return { dispose: () => { this.repairListeners.delete(listener); } };
		},
	};

	private async answer(question: Question): Promise<QuestionAnswer> {
		const brickId = question.brickId;
		if (question.kind === 'forget' && brickId && this.confirmedForgets.has(brickId)) { return 'yes'; }
		if (question.kind === 'clearBluetoothList' && brickId) {
			const confirm = this.clearings.get(brickId);
			if (confirm) {
				return (await confirm(question.details ?? [], question.includesThisComputer === true, question.thisComputer)) ? 'yes' : 'no';
			}
		}
		return this.options.askPerson ? this.options.askPerson(question) : 'keep';
	}

	/** Every pairing the daemon runs, whoever started it, as the event the progress follows. */
	private followPairings(): void {
		const running = new Map<string, { emit: (e: BtPairingEvent) => void; settle: (r: PairingResult) => void }>();
		this.subscriptions.push(this.client.on('bricks/pairingStarted', ({ brickId }) => {
			const listeners: ((e: BtPairingEvent) => void)[] = [];
			let settle: (r: PairingResult) => void = () => undefined;
			const done = new Promise<PairingResult>((resolve) => { settle = resolve; });
			running.set(brickId, { emit: (e) => { for (const l of listeners) { l(e); } }, settle });
			const event: PairingStartedEvent = { brickId: brickId as BrickId, done, onEvent: (l) => { listeners.push(l); } };
			for (const l of [...this.pairingListeners]) { l(event); }
		}));
		this.subscriptions.push(this.client.on('bricks/pairingEvent', ({ brickId, message }) => {
			if (!message) { return; }
			try { running.get(brickId)?.emit(JSON.parse(message) as BtPairingEvent); } catch { /* not an event */ }
		}));
		this.subscriptions.push(this.client.on('bricks/pairingDone', ({ brickId, paired, message }) => {
			running.get(brickId)?.settle({ ok: paired, ...(message ? { reason: message } : {}) });
			running.delete(brickId);
		}));
	}
}
