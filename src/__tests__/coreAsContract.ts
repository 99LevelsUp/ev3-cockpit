/**
 * The Node core's brick layer, seen the way the extension's commands now see the daemon: bricks,
 * pairings, repairs and failures in the contract's shapes, failures carrying `data.code`.
 *
 * The extension talks to the native daemon only. The core's own behaviour tests (scan races,
 * pairings, repairs over USB) used to drive the core through the extension's connect flow; this
 * adapter keeps them doing so until the core goes.
 */

import type {
	ContractBrick, ContractChannel, ErrorCode, OneSidedRepair as ContractRepair, PairingResult as ContractPairingResult, Transport,
} from '../contract/generated';
import type { BrickEntry, BrickId } from '../core/contracts';
import {
	BrickUnreachableError, CockpitError, ConnectionAbandonedError, TimeoutError,
} from '../core/errors/CockpitError';
import type { BrickManager, PairingStartedEvent as CorePairingStarted } from '../core/runtime/brickManager';
import type { OneSidedRepair } from '../core/runtime/forgetReport';
import type { PresenceAggregator } from '../core/runtime/presenceAggregator';
import type { PairingResult } from '../core/transports/btClassicDiscovery';
import { PAIRING_CANCELLED } from '../core/transports/btPairingHelper';
import type { BrickList } from '../vscode/ui/commandTypes';
import type { ConnectBricks, PairingStartedEvent } from '../vscode/ui/connectBrick';

type CoreBricks = Pick<BrickManager, 'isSignedIn' | 'signIn' | 'connectAgain' | 'resumePairing' | 'pair'>;

export function contractOf(entry: BrickEntry, signedIn: boolean): ContractBrick {
	return {
		brickId: entry.brickId,
		name: entry.name.value,
		nameConfirmed: entry.name.confirmed,
		connected: signedIn,
		paired: entry.paired,
		channels: entry.channels.map((c) => ({ transport: c.transport as Transport, state: c.state as ContractChannel['state'] })),
		holders: [],
	};
}

/** The aggregator's list as the commands read it. */
export function coreList(aggregator: Pick<PresenceAggregator, 'getDiscoveryList' | 'getBrick' | 'onListChanged'>, bricks: Pick<BrickManager, 'isSignedIn'>): BrickList {
	return {
		bricks: () => aggregator.getDiscoveryList().map((e) => contractOf(e, bricks.isSignedIn(e.brickId))),
		brick: (brickId) => {
			const entry = aggregator.getBrick(brickId as BrickId);
			return entry ? contractOf(entry, bricks.isSignedIn(entry.brickId)) : undefined;
		},
		onListChanged: (listener) => aggregator.onListChanged(listener),
	};
}

/** The code the daemon puts on the wire for a core failure. */
function codeOf(error: unknown): ErrorCode | undefined {
	if (error instanceof BrickUnreachableError) { return 'brick_unreachable'; }
	if (error instanceof TimeoutError) { return 'timeout'; }
	if (error instanceof ConnectionAbandonedError) { return 'connection_abandoned'; }
	return error instanceof CockpitError ? error.code as ErrorCode : undefined;
}

/** A core failure as the client library raises it: the same message, with `data.code`. */
function asContractError(error: unknown): unknown {
	const code = codeOf(error);
	if (!code || !(error instanceof Error)) { return error; }
	return Object.assign(new Error(error.message), { data: { code } });
}

export function contractPairing(brickId: string, result: PairingResult): ContractPairingResult {
	const outcome = result.ok ? 'paired' : result.reason === PAIRING_CANCELLED ? 'cancelled' : 'failed';
	return { brickId, outcome, ...(result.reason ? { message: result.reason } : {}) };
}

/** Connecting and pairing as the daemon does them for a client: a pairing cancelled before may be asked again. */
export function coreConnect(aggregator: Pick<PresenceAggregator, 'getBrick'>, bricks: CoreBricks): ConnectBricks {
	return {
		connect: async (brickId) => {
			const id = brickId as BrickId;
			bricks.resumePairing(id);
			try {
				await (bricks.isSignedIn(id) ? bricks.connectAgain(id) : bricks.signIn(id));
			} catch (error) {
				throw asContractError(error);
			}
			const entry = aggregator.getBrick(id);
			if (!entry) { throw new Error(`${brickId} left the list`); }
			return contractOf(entry, bricks.isSignedIn(id));
		},
		pair: async (brickId) => {
			bricks.resumePairing(brickId as BrickId);
			return contractPairing(brickId, await bricks.pair(brickId as BrickId));
		},
	};
}

/** A core pairing announcement as the bridge hands it to the commands. */
export function contractPairingStarted(event: CorePairingStarted): PairingStartedEvent {
	return {
		brickId: event.brickId,
		done: event.done.then((result) => contractPairing(event.brickId, result)),
		onProgress: (listener) => event.onEvent((e) => {
			if (e.type === 'found') {
				const found = e as { name: string; alreadyPaired: boolean };
				listener({ phase: 'found', name: found.name, alreadyPaired: found.alreadyPaired });
			}
			if (e.type === 'pairingRequested') { listener({ phase: 'pairingRequested' }); }
		}),
	};
}

/** A core repair as the daemon reports it, and whether a pairing followed. */
export function contractRepair(repair: OneSidedRepair): { repair: ContractRepair; pairingAgain: boolean } {
	return {
		repair: {
			brickId: repair.brickId,
			found: repair.found === 'windows-only' ? 'computer-only' : 'brick-only',
			...(repair.removal ? { removal: { ...repair.removal } } : {}),
			others: [...repair.others],
			...(repair.repeated ? { repeated: true } : {}),
		},
		pairingAgain: repair.pairing !== undefined,
	};
}
