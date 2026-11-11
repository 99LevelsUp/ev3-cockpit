/**
 * Brick manager — the cockpit's bricks, each over whichever channels reach it.
 *
 * The session manager below keeps one session per channel (`usb:…`, `bt:…`) and knows nothing
 * of bricks. This layer signs bricks in and out, joins every channel a signed-in brick is
 * reachable on, and sends each command over the best channel that is connected at that
 * moment — by the priority each transport declares, USB → Bluetooth → TCP (step-2 plan, KD1,
 * KD2, KTD5). A pulled cable moves traffic to Bluetooth on the first failed command; the cable
 * back in moves it back.
 */

import * as vscode from 'vscode';
import {
	BrickCommand, BrickId, BrickKey, BrickPeer, BrickPeerList, BrickResponse, ChannelState, ConnectionState, ForgetResidue,
	PresenceState, SendCommandOptions, Transport, brickIdOf, brickKeyId, brickKeyTransport, describeChannel, makeBrickKey,
} from '../contracts';
import {
	ChannelChangedError, ConnectionAbandonedError, ConnectionError, NotConnectedError, ProtocolError, TimeoutError,
	TransportError,
} from '../errors/CockpitError';
import { PinnedLink } from '../fs/fileTransferService';
import { isBlankPeerName } from '../protocol/ev3Commands';
import { PacketCommandChannel } from '../commands/commandChannel';
import type { TelemetryHost } from '../telemetry/telemetryService';
import { FIRMWARE_SAFETY } from '../transports/transportConstants';
import type { PairingResult } from '../transports/btClassicDiscovery';
import { PAIRING_CANCELLED, type BtPairingEvent } from '../transports/btPairingHelper';
import { ProviderRegistry } from '../transports/providerRegistry';
import { formatMac } from '../transports/btSppDiscovery';
import { brickLabel, channelLabel } from './brickLabels';
import type { DiscoveryScheduler } from './discoveryScheduler';
import type {
	BrickSideOutcome, ClearListReport, ClearPairingSkip, ClearSkip, ClearedEntry, ForgetReport, MemoryOutcome,
	OneSidedRepair, PairingOutcome, PeerRemoval,
} from './forgetReport';
import { PresenceAggregator } from './presenceAggregator';
import { ReconnectStrategy } from './reconnectStrategy';
import { SessionManager } from './sessionManager';

// ── Events ──────────────────────────────────────────────────────────

/** The channel a brick's traffic goes over changed. */
export interface RouteChangeEvent {
	readonly brickId: BrickId;
	readonly previous: BrickKey | undefined;
	readonly current: BrickKey | undefined;
}

export interface ActiveBrickIdChangeEvent {
	readonly previous: BrickId | undefined;
	readonly current: BrickId | undefined;
}

/** A pairing started, whoever started it; the brick shows its pairing dialog shortly. */
export interface PairingStartedEvent {
	readonly brickId: BrickId;
	/** Settles with the pairing's outcome. */
	readonly done: Promise<PairingResult>;
	/** Hear this pairing's progress from now on: the pairing helper's events, in order. */
	onEvent(listener: (event: BtPairingEvent) => void): void;
}

/** The brick's list of paired Bluetooth devices was read and differs, or was dropped with the brick. */
export interface PeerListChangeEvent {
	readonly brickId: BrickId;
	/** Undefined once the brick is forgotten. */
	readonly current: BrickPeerList | undefined;
}

// ── Options ─────────────────────────────────────────────────────────

export interface BrickManagerOptions {
	readonly sessionManager: SessionManager;
	readonly aggregator: PresenceAggregator;
	readonly providerRegistry: ProviderRegistry;
	/** Backoff for retrying a failed join on a transport that allows timed retries. */
	readonly rejoinBaseMs?: number;
	readonly rejoinMaxMs?: number;
	/** Where a name that could not be read is reported, once per channel. */
	readonly log?: { warn(message: string): void };
	/**
	 * Discovery, for {@link BrickManager.forget}: it stops tracking the brick's channels, drops
	 * what a scan older than that lists for them, and scans once afterwards (step-3 plan, KTD1,
	 * KTD7). Absent, a forget does none of that.
	 */
	readonly discovery?: Pick<DiscoveryScheduler, 'forget' | 'scanOnce'>;
	/**
	 * Bluetooth presence, which a forget tells to drop the brick's address (KTD7), and a pairing
	 * to drop the checks from before it. Absent: nothing to drop.
	 */
	readonly btPresence?: { forget(mac: string): void; notePaired?(mac: string): void };
	/**
	 * Pairs a brick over Bluetooth, by address; an aborted signal stops it. Absent without
	 * Bluetooth, and then {@link BrickManager.pair} answers that it cannot.
	 */
	readonly pair?: (
		mac: string, onEvent?: (event: BtPairingEvent) => void, signal?: AbortSignal,
	) => Promise<PairingResult>;
	/**
	 * This computer's Bluetooth name, the only key to its entry on a brick (KTD3). Absent, or
	 * returning undefined, when it cannot be read; a forget then leaves the brick's list alone.
	 */
	readonly radioName?: () => string | undefined;
	/**
	 * Where the one-sided check learns whether Windows has a brick paired (step-4 plan, KTD6):
	 * discovery's tracked Bluetooth items, which the cockpit's own pairings and unpairs fence
	 * (step-3 plan, KTD11), not the list's sticky `paired` flag. Absent, no check runs.
	 */
	readonly windowsPairing?: Pick<DiscoveryScheduler, 'getTrackedBricks' | 'hasScanned'>;
}

/**
 * Asked once the brick's list is read and before anything is removed from it (R16).
 *
 * @param names Every entry it will remove, in the list's order; a name held twice is here twice.
 * @param includesThisComputer Whether one of them carries this computer's exact Bluetooth name
 *   or, when only Bluetooth reaches the brick, is the entry the brick marks connected: the one
 *   it holds the link the list was read over under.
 * @param thisComputer This computer's Bluetooth name; undefined when it is unknown, and then
 *   only an entry marked connected tells whether this computer is among `names`.
 * @returns True to go ahead.
 */
export type ClearListConfirm = (
	names: readonly string[], includesThisComputer: boolean, thisComputer: string | undefined,
) => PromiseLike<boolean>;

// ── Per-brick sign-in state ─────────────────────────────────────────

interface SignIn {
	/** Joins in flight, by channel. */
	readonly pending: Set<BrickKey>;
	/** Failed joins that wait for the brick to be seen again before another try, with when they failed. */
	readonly awaitingEvidence: Map<BrickKey, number>;
	/** Failed joins waiting out a backoff. */
	readonly retryTimers: Map<BrickKey, NodeJS.Timeout>;
	readonly backoff: Map<BrickKey, ReconnectStrategy>;
}

/**
 * Whether an error means the channel's link is in trouble, as opposed to this one command.
 *
 * A transport, timeout or connection error is; so is a degraded channel, which the guard
 * reports as a transport error. A caller's own abort is not, even though an adapter may
 * report it as a transport error, and neither is the guard's rate limit or a queue drained
 * by a disconnect — failing over on those would move traffic off a link that works.
 */
function isLinkFailure(error: unknown, options: SendCommandOptions | undefined): boolean {
	if (options?.signal?.aborted) { return false; }
	return error instanceof TransportError
		|| error instanceof TimeoutError
		|| error instanceof ConnectionError;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const namesOf = (peers: readonly BrickPeer[]): string[] => peers.map((peer) => peer.name);

const samePeers = (a: readonly BrickPeer[], b: readonly BrickPeer[]): boolean =>
	a.length === b.length && a.every((peer, i) => peer.name === b[i].name && peer.connected === b[i].connected);

/** The Bluetooth channel of a brick whose id is its hardware address, as a pairing addresses it. */
const bluetoothKeyOf = (brickId: BrickId): BrickKey | undefined =>
	/^[0-9A-F]{12}$/.test(brickId) ? makeBrickKey(Transport.BT, formatMac(brickId)) : undefined;

/** How many entries of a brick's Bluetooth list carry exactly `name`; the brick tells entries apart by nothing else. */
const countOf = (names: readonly string[], name: string): number => names.filter((n) => n === name).length;

export class BrickManager implements vscode.Disposable {
	private readonly sessionManager: SessionManager;
	private readonly aggregator: PresenceAggregator;
	private readonly registry: ProviderRegistry;
	private readonly rejoinBaseMs: number;
	private readonly rejoinMaxMs: number;

	private readonly signedIn = new Map<BrickId, SignIn>();
	/** Channels taken out of routing by a link failure, until they answer again. */
	private readonly dropped = new Set<BrickKey>();
	private readonly routes = new Map<BrickId, BrickKey>();
	private activeBrickId?: BrickId;
	private disposed = false;
	private readonly log?: { warn(message: string): void };
	/** Channels being asked their name without a session, so one sighting asks once. */
	private readonly probing = new Set<BrickKey>();
	/** Channels whose name probe has failed and been reported, so it is reported once. */
	private readonly probeFailuresReported = new Set<BrickKey>();
	/**
	 * Bricks being forgotten or having their list cleared, with how many such operations run:
	 * nothing opens, reopens or probes a link to them (KTD4, KTD10). Counted, so the one that
	 * ends first does not lift the guards from under the other.
	 */
	private readonly forgetting = new Map<BrickId, number>();
	/** The forget running for each brick, so a second call joins it. */
	private readonly forgets = new Map<BrickId, Promise<ForgetReport>>();
	/** Bricks whose list is being cleared, so a second clear is refused rather than interleaved. */
	private readonly clearing = new Set<BrickId>();
	private readonly discovery?: BrickManagerOptions['discovery'];
	private readonly btPresence?: BrickManagerOptions['btPresence'];
	private readonly radioName?: BrickManagerOptions['radioName'];
	private readonly pairDevice?: BrickManagerOptions['pair'];
	/** The pairing running for each brick, so a second caller joins it rather than showing a second dialog. */
	private readonly pairings = new Map<BrickId, { readonly done: Promise<PairingResult>; readonly abort: AbortController }>();
	/**
	 * How many forgets and clears have held a brick's guards. A pairing that began before one of
	 * them records nothing when it ends: the brick it would record was forgotten under it.
	 */
	private readonly guardHolds = new Map<BrickId, number>();
	/**
	 * Bricks that are not paired by themselves until the user runs "Connect a Brick" on them
	 * again: a pairing failed or was cancelled on the brick, or a forget or a clear ran. Windows'
	 * cache relists a brick unpaired for minutes after one; without this the brick would show its
	 * pairing dialog again and again. Keyed by brick, so it outlives a forgotten brick's record.
	 */
	private readonly pairingSuspended = new Set<BrickId>();
	/** Each brick's list of paired Bluetooth devices as last read, kept for the panel (KTD8). */
	private readonly peerLists = new Map<BrickId, BrickPeerList>();
	/** How many reads of a list have been kept, and the number of the one each brick's list came from. */
	private peerReadsKept = 0;
	private readonly peerListNumber = new Map<BrickId, number>();
	private readonly windowsPairing?: BrickManagerOptions['windowsPairing'];
	/**
	 * Bricks waiting for the one-sided check since a USB or TCP channel joined, with the number of
	 * list reads kept by then: the check needs a list read after the join, and automatic pairing
	 * waits for the check (KTD3), so a stale half is removed before any dialog.
	 */
	private readonly oneSidedPending = new Map<BrickId, number>();
	/** Whether Windows had each signed-in brick paired at the last list change (step-4 U13). */
	private readonly pairedBefore = new Map<BrickId, boolean>();
	/** Bricks whose one-sided pairing is being repaired now. */
	private readonly repairing = new Set<BrickId>();
	/** Bluetooth joins waiting for the one-sided check, by brick (step-4 U10). */
	private readonly bluetoothWaiters = new Map<BrickId, Set<() => void>>();
	/**
	 * Bricks repaired since the user last ran "Connect a Brick" on them. A brick that stores this
	 * computer under a name that is not byte-exact looks one-sided after every repair; a second
	 * finding is reported instead of showing the dialog again and again.
	 */
	private readonly repaired = new Set<BrickId>();

	private readonly _onRouteChange = new vscode.EventEmitter<RouteChangeEvent>();
	/** Fired when the channel a brick's traffic goes over changes, including to none. */
	readonly onRouteChange = this._onRouteChange.event;

	private readonly _onActiveBrickChange = new vscode.EventEmitter<ActiveBrickIdChangeEvent>();
	readonly onActiveBrickChange = this._onActiveBrickChange.event;

	private readonly _onPairingStarted = new vscode.EventEmitter<PairingStartedEvent>();
	/** Fired when a pairing starts, so whoever shows progress can tell the user to look at the brick. */
	readonly onPairingStarted = this._onPairingStarted.event;

	private readonly _onPeerListChange = new vscode.EventEmitter<PeerListChangeEvent>();
	/** Fired when a read of a brick's list finds it changed, and when the brick is forgotten. */
	readonly onPeerListChange = this._onPeerListChange.event;

	private readonly _onOneSidedRepair = new vscode.EventEmitter<OneSidedRepair>();
	/** Fired when a pairing broken on one side is found over USB or TCP, with what was done (R6). */
	readonly onOneSidedRepair = this._onOneSidedRepair.event;

	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(options: BrickManagerOptions) {
		this.sessionManager = options.sessionManager;
		this.aggregator = options.aggregator;
		this.registry = options.providerRegistry;
		this.rejoinBaseMs = options.rejoinBaseMs ?? FIRMWARE_SAFETY.RECONNECT_BASE_MS;
		this.rejoinMaxMs = options.rejoinMaxMs ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;
		this.log = options.log;
		this.discovery = options.discovery;
		this.btPresence = options.btPresence;
		this.radioName = options.radioName;
		this.pairDevice = options.pair;
		this.windowsPairing = options.windowsPairing;

		this.subscriptions.push(
			this.sessionManager.onSessionStateChange((e) => {
				// Before the list follows: a list change starts a reconcile, which must not pair the
				// brick before the check of a USB or TCP channel that has just joined (KTD3).
				this.noteCheckableChannel(e.brickKey, e.newState);
				// The list's channel state follows its session.
				this.aggregator.updateChannelSession(e.brickKey, e.newState);
				if (e.newState === ConnectionState.Connected) { this.dropped.delete(e.brickKey); }
				const brickId = brickIdOf(e.brickKey);
				this.recomputeRoute(brickId);
				// A channel whose session ended while its brick stays signed in joins again once
				// it is available — whatever ended it.
				if (e.newState === ConnectionState.Disconnected) { this.reconcile(brickId); }
				// A channel that has just connected, by a join or by the session manager's own
				// reconnect, is when the brick's list may have changed (KTD8) and is checked (KTD6).
				if (e.newState === ConnectionState.Connected && this.signedIn.has(brickId)) {
					this.readPeerListAfter(brickId, 'connecting');
				}
			}),
			this.aggregator.onPresenceChanged((e) => {
				if (e.currentState !== PresenceState.Available) { return; }
				// A brick that has just become visible again is the evidence a reconnecting
				// session is waiting for. Measured before this existed: a brick that boots in
				// about 40 s took 121 s to be picked up, because the backoff had reached 30 s
				// steps and waited them out beside a brick that was ready.
				// Not for a brick being forgotten: either would open a link the forget is closing (KTD4).
				const forgetting = this.forgetting.has(brickIdOf(e.brickKey));
				if (!forgetting) {
					this.sessionManager.notifyBrickAvailable(e.brickKey);
					this.probeName(e.brickKey);
				}
				const signIn = this.signedIn.get(brickIdOf(e.brickKey));
				if (signIn?.awaitingEvidence.delete(e.brickKey)) {
					this.reconcile(brickIdOf(e.brickKey));
				}
			}),
			this.aggregator.onListChanged(() => {
				for (const brickId of this.signedIn.keys()) {
					this.takeAnswersAsEvidence(brickId);
					// Before reconcile: it would pair the brick on the stale check (step-4 U13).
					this.checkAgainWhenUnpaired(brickId);
					this.reconcile(brickId);
				}
			}),
		);
	}

	// ── Sign-in ─────────────────────────────────────────────────────

	/**
	 * Sign a brick in: join every channel it is available on now, and every one that becomes
	 * available later while it stays signed in.
	 *
	 * Resolves once the first channel connects; the rest keep joining in the background, so a
	 * cable that opens in 30 ms does not wait out a 5 s Bluetooth attempt. Makes the brick the
	 * active one.
	 *
	 * @throws When no channel is available, or every join fails. The brick is then not signed in.
	 */
	async signIn(brickId: BrickId): Promise<void> {
		// The forget is closing every channel of this brick; a sign-in would reopen one under it
		// (step-3 plan, KTD4). The forget opens its own channel without coming through here.
		if (this.forgetting.has(brickId)) {
			throw new NotConnectedError(
				`Brick ${brickId} is being forgotten or its Bluetooth list cleared; sign it in once that has finished.`);
		}
		if (this.signedIn.has(brickId)) {
			this.setActiveBrick(brickId);
			return;
		}
		const candidates = this.joinCandidates(brickId);
		if (candidates.length === 0) {
			throw new NotConnectedError(`Brick ${brickId} is not available on any channel.`);
		}

		const signIn: SignIn = {
			pending: new Set(), awaitingEvidence: new Map(), retryTimers: new Map(), backoff: new Map(),
		};
		const abandoned = (): ConnectionAbandonedError =>
			new ConnectionAbandonedError(`Brick ${brickId} was disconnected while it was connecting.`);
		this.signedIn.set(brickId, signIn);
		try {
			await Promise.any(candidates.map((key) => this.join(brickId, key)));
		} catch (error) {
			// Signed out meanwhile, whatever the other channels failed with before that; a newer
			// sign-in is not this one's to end.
			if (this.signedIn.get(brickId) !== signIn) { throw abandoned(); }
			// A channel found after the sign-in started has joined meanwhile (step-4 U14): the brick
			// is connected, so the sign-in stands. On hardware a cable plugged in just after "Connect a
			// Brick" joined while the only first candidate, Bluetooth, failed: the user was told the
			// brick did not answer, and the brick was signed out with its USB session still open.
			if (this.hasConnectedChannel(brickId)) {
				this.setActiveBrick(brickId);
				return;
			}
			this.forgetSignIn(brickId);
			const first: unknown = error instanceof AggregateError ? error.errors[0] : error;
			throw first instanceof Error ? first : new Error(String(first));
		}
		if (this.signedIn.get(brickId) !== signIn) { throw abandoned(); }
		this.setActiveBrick(brickId);
	}

	/**
	 * Connect a signed-in brick again over every channel that is not connected (step-4 plan,
	 * KTD4): what the user asks for by running "Connect a Brick" on it.
	 *
	 * Joins every available channel now, whatever a failed join was waiting for, and the paired
	 * Bluetooth channel the presence checks lost too; and pairs a Bluetooth sighting nobody has
	 * paired. Waits for the joins and makes the brick the active one, or
	 * rejects with the first failure when no channel ends up connected. A brick not signed in is
	 * signed in.
	 */
	async connectAgain(brickId: BrickId): Promise<void> {
		const signIn = this.signedIn.get(brickId);
		if (!signIn || this.forgetting.has(brickId)) {
			await this.signIn(brickId);
			return;
		}
		const lost = this.unheardBluetooth(brickId);
		const keys = [...this.joinCandidates(brickId), ...(lost ? [lost] : [])].filter((key) => !signIn.pending.has(key));
		// The user asks now (KTD4): what a failed join was waiting for goes, and so does its backoff,
		// or the old retry timer would run beside the one a failure here sets.
		for (const key of keys) {
			clearTimeout(signIn.retryTimers.get(key));
			signIn.retryTimers.delete(key);
			signIn.awaitingEvidence.delete(key);
			signIn.backoff.delete(key);
		}
		const joins = keys.map((key) => this.join(brickId, key));
		// The user asks now: a USB or TCP channel already connected is checked again (KTD4, KTD6).
		if (this.windowsPairing && this.checkableChannelConnected(brickId)) {
			this.oneSidedPending.set(brickId, this.peerReadsKept);
			this.readPeerListAfter(brickId, 'Connect a Brick');
		}
		this.pairSighting(brickId);
		const outcomes = await Promise.allSettled(joins);
		if (this.signedIn.get(brickId) !== signIn) {
			throw new ConnectionAbandonedError(`Brick ${brickId} was disconnected while it was connecting.`);
		}
		const connected = this.sessionManager.getAllSessions().some((s) => brickIdOf(s.brickKey) === brickId
			&& s.connectionState === ConnectionState.Connected);
		if (!connected) {
			const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
			if (!failure) { throw new NotConnectedError(`Brick ${brickId} is not available on any channel.`); }
			throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
		}
		this.setActiveBrick(brickId);
	}

	/**
	 * Let the brick pair by itself again (step-4 plan, KTD2): the user ran "Connect a Brick" on
	 * it, so a pairing they cancelled, or a forget or clear, no longer holds automatic pairing back.
	 */
	resumePairing(brickId: BrickId): void {
		this.pairingSuspended.delete(brickId);
		this.repaired.delete(brickId);
	}

	/** Sign a brick out: close every channel; it does not reconnect until signed in again. */
	async signOut(brickId: BrickId): Promise<void> {
		// Cleared first, so nothing that fires while the channels close joins them again.
		this.forgetSignIn(brickId);
		const keys = this.sessionManager.getAllSessions()
			.map((s) => s.brickKey)
			.filter((key) => brickIdOf(key) === brickId);
		await Promise.all(keys.map((key) => this.sessionManager.disconnect(key)));
		for (const key of keys) { this.dropped.delete(key); }
		this.recomputeRoute(brickId);
		if (this.activeBrickId === brickId) { this.clearActiveBrick(); }
	}

	// ── Pairing ─────────────────────────────────────────────────────

	/**
	 * Pair a brick over its Bluetooth channel, the one way into pairing (step-4 plan, KTD1).
	 *
	 * One pairing per brick: a second call while one runs gets the same outcome, and the brick
	 * shows one dialog. A pairing that succeeds is recorded at once (step-3 plan, KTD11): the list
	 * says paired and the channel available, and the presence checks from before it are dropped.
	 * One that ends after the brick was forgotten or its list cleared, or after this layer was
	 * disposed, records nothing and answers that it did not pair.
	 */
	pair(brickId: BrickId): Promise<PairingResult> {
		return this.pairOver(brickId, this.aggregator.getBrick(brickId)?.channels.find((c) => c.transport === Transport.BT)?.brickKey);
	}

	/** {@link pair}, over a Bluetooth channel the list may no longer hold: a repair forgot it first. */
	private pairOver(brickId: BrickId, btKey: BrickKey | undefined): Promise<PairingResult> {
		const running = this.pairings.get(brickId);
		if (running) { return running.done; }
		// A clear waiting on its confirmation holds no guards yet, and would not see a pairing that
		// started now (KTD5).
		if (this.disposed || this.peerListBusy(brickId)) {
			return Promise.resolve({ ok: false, reason: PAIRING_CANCELLED });
		}
		const mac = btKey ? brickKeyId(btKey) : undefined;
		const pairDevice = this.pairDevice;
		if (!pairDevice || !btKey || !mac) {
			return Promise.resolve({ ok: false, reason: `Brick ${brickId} has no Bluetooth channel to pair.` });
		}

		const abort = new AbortController();
		const listeners: ((event: BtPairingEvent) => void)[] = [];
		const holdsAtStart = this.guardHolds.get(brickId) ?? 0;
		const done = (async (): Promise<PairingResult> => {
			// After the event below, so whoever shows progress hears the pairing from its start.
			await Promise.resolve();
			const result = await pairDevice(mac, (event) => { for (const listener of listeners) { listener(event); } }, abort.signal)
				.catch((error: unknown): PairingResult => ({ ok: false, reason: messageOf(error) }));
			if (!result.ok) {
				this.pairingSuspended.add(brickId);
				return result;
			}
			if (this.disposed || this.forgetting.has(brickId) || (this.guardHolds.get(brickId) ?? 0) !== holdsAtStart) {
				// Stopped by a forget or a clear, or by disposal: nobody asked to be told.
				return { ok: false, reason: PAIRING_CANCELLED };
			}
			this.aggregator.markPaired(btKey);
			this.btPresence?.notePaired?.(mac);
			this.readPeerListAfter(brickId, 'pairing');
			return result;
		})().finally(() => {
			if (this.pairings.get(brickId)?.abort === abort) { this.pairings.delete(brickId); }
		});
		this.pairings.set(brickId, { done, abort });
		this._onPairingStarted.fire({ brickId, done, onEvent: (listener) => { listeners.push(listener); } });
		return done;
	}

	// ── Forget ──────────────────────────────────────────────────────

	/**
	 * Make this computer forget a brick on every channel (step-3 plan, KD1, KTD1).
	 *
	 * In this order, each part running even when an earlier one failed, and each recorded in
	 * the report:
	 * 1. mark the brick as being forgotten, so nothing opens, reopens or probes a link to it
	 *    (KTD4);
	 * 2. remove this computer's entry from the brick's own Bluetooth list, over a live channel
	 *    when there is one (KTD5);
	 * 3. sign the brick out, which closes every channel, the one opened for step 2 too;
	 * 4. have each channel's provider forget it where the provider can: the operating-system
	 *    pairing (KTD6);
	 * 5. clear the cockpit's memory of it (KTD7); a discovery scan in flight read Windows' list
	 *    before the unpair, and what it lists for the brick is dropped when it lands;
	 * 6. lift the mark and start a scan, so a brick still in reach comes back as a stranger (R4).
	 *    The report does not wait for it: a scan can hang in the operating system.
	 *
	 * Shows nothing; the caller builds the message from the report (KTD8). A second call while
	 * one runs gets the same report rather than a second run, whose end would lift the guards
	 * while the first still works.
	 */
	forget(brickId: BrickId): Promise<ForgetReport> {
		let running = this.forgets.get(brickId);
		if (!running) {
			running = this.runForget(brickId).finally(() => { this.forgets.delete(brickId); });
			this.forgets.set(brickId, running);
		}
		return running;
	}

	/**
	 * Remove every entry from a brick's own Bluetooth list, whatever its name (step-3 plan, KD7,
	 * KTD9, KTD10, R15–R18).
	 *
	 * One operation, so the list the user is asked about is the list that gets cleared:
	 * 1. take the channel forget would (KTD5), opening one when none is connected;
	 * 2. read the list and ask `confirm` with every name it will remove (R16); declined, nothing
	 *    is sent, a channel this opened is closed, and it resolves undefined;
	 * 3. remove each named entry until the list is empty or a pass removes nothing (KTD9). Over
	 *    USB or TCP the brick's Bluetooth sessions are closed first; over Bluetooth alone this
	 *    computer's entry — the one the brick marks connected, or the one carrying the radio
	 *    name — goes last, because its removal cuts the link, and the brick is then signed out,
	 *    as nothing else reaches it;
	 * 4. when this computer's entry went and the brick was paired, forget its Bluetooth channel
	 *    only: the pairing and the cockpit's memory of that channel (KTD10). Its other channels
	 *    stay as they are, a USB session too (R18).
	 *
	 * From step 3 on, the guards of a forget hold for the brick (KTD4). Shows nothing; the caller
	 * builds the message from the report.
	 *
	 * @throws {NotConnectedError} While the brick is being forgotten, or its list is being
	 *   cleared already.
	 */
	async clearBluetoothList(brickId: BrickId, confirm: ClearListConfirm): Promise<ClearListReport | undefined> {
		if (this.forgets.has(brickId) || this.clearing.has(brickId)) {
			throw new NotConnectedError(`Brick ${brickId} is being forgotten or its Bluetooth list cleared already.`);
		}
		this.clearing.add(brickId);
		try {
			return await this.runClear(brickId, confirm);
		} finally {
			this.clearing.delete(brickId);
		}
	}

	// ── The brick's list of paired computers ────────────────────────

	/** The brick's list of paired Bluetooth devices as last read; undefined until it has been read. */
	peerListOf(brickId: BrickId): BrickPeerList | undefined {
		return this.peerLists.get(brickId);
	}

	/**
	 * Read the brick's list of paired Bluetooth devices now (step-4 plan, KTD8), over the connected
	 * channel a forget would use (KTD5 of step 3). Opens no channel for it.
	 *
	 * @returns The list read; undefined when a forget or a clear ran meanwhile, whose own reading
	 *   is the list from then on.
	 * @throws {NotConnectedError} When no channel to the brick is connected, or a forget or a clear
	 *   is running.
	 */
	async refreshPeerList(brickId: BrickId): Promise<BrickPeerList | undefined> {
		const key = this.peerListBusy(brickId) ? undefined : this.connectedPeerListChannel(brickId);
		if (!key) {
			throw new NotConnectedError(`Brick ${brickId} has no connected channel to read its Bluetooth list over.`);
		}
		const holdsAtStart = this.guardHolds.get(brickId) ?? 0;
		const peers = await this.readPeers(key);
		if (this.disposed || this.peerListBusy(brickId) || (this.guardHolds.get(brickId) ?? 0) !== holdsAtStart) {
			return undefined;
		}
		return this.recordPeers(brickId, key, peers);
	}

	isSignedIn(brickId: BrickId): boolean {
		return this.signedIn.has(brickId);
	}

	/** The bricks currently signed in. */
	signedInBricks(): BrickId[] {
		return [...this.signedIn.keys()];
	}

	// ── Routing ─────────────────────────────────────────────────────

	/** The channel a brick's traffic goes over now, or undefined when none is connected. */
	routeOf(brickId: BrickId): BrickKey | undefined {
		return this.routes.get(brickId);
	}

	/**
	 * Send a command to a brick over its best connected channel.
	 *
	 * A command that fails on a link fault is not resent: its caller hears the failure. The
	 * channel leaves routing at once, so the next command goes over the next channel, and is
	 * probed straight away — back in routing if it answers, reconnecting if not.
	 */
	async send(brickId: BrickId, command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> {
		const route = this.routes.get(brickId);
		if (!route) {
			throw new NotConnectedError(`Brick ${brickId} has no connected channel.`);
		}
		let response: BrickResponse;
		try {
			response = await this.sessionManager.send(route, command, options);
		} catch (error) {
			if (isLinkFailure(error, options)) { this.dropFromRouting(route); }
			throw error;
		}
		// The brick answers a rename with a bare status, and rejects a bad name in silence; the
		// only proof it took is to read the name back.
		if (command.kind === 'brick:setName') { void this.readNameOverSession(route); }
		return response;
	}

	/**
	 * Hold the brick's current channel for a multi-step operation (step-2 plan, KD9).
	 *
	 * Every step goes over that channel even if traffic moves meanwhile, so a transfer that
	 * started over Bluetooth finishes there when a cable is plugged in; a step fails with
	 * {@link ChannelChangedError} only once that channel is lost. A link fault on a step
	 * fails over for everyone else as an ordinary send would.
	 */
	pin(brickId: BrickId): PinnedLink {
		const key = this.routes.get(brickId);
		if (!key) {
			throw new NotConnectedError(`Brick ${brickId} has no connected channel.`);
		}
		return {
			maxPacketBytes: this.sessionManager.maxPacketBytes(key),
			send: async (command) => {
				if (this.sessionManager.getSession(key)?.connectionState !== ConnectionState.Connected
					|| this.dropped.has(key)) {
					throw new ChannelChangedError(
						`The channel ${describeChannel(key)} this operation started on was lost; start it again.`);
				}
				try {
					return await this.sessionManager.send(key, command);
				} catch (error) {
					if (isLinkFailure(error, undefined)) { this.dropFromRouting(key); }
					throw error;
				}
			},
		};
	}

	/** Largest packet the brick's current channel carries, or undefined for the firmware's own. */
	maxPacketBytes(brickId: BrickId): number | undefined {
		const route = this.routes.get(brickId);
		return route ? this.sessionManager.maxPacketBytes(route) : undefined;
	}

	/** The transport a brick's traffic goes over now, or undefined when none is connected. */
	transportOfBrick(brickId: BrickId): Transport | undefined {
		const route = this.routes.get(brickId);
		return route ? this.transportOf(route) : undefined;
	}

	/**
	 * This layer as a telemetry host: the active brick's loop runs over whichever channel
	 * carries its traffic, at that channel's cadence, and restarts when the route moves.
	 *
	 * A brick counts as connected while it has a route and as reconnecting while it is
	 * signed in without one, which is what the loop needs to know to run or wait.
	 */
	telemetryHost(): TelemetryHost {
		const asBrick = (key: string): BrickId => key as BrickId;
		return {
			send: (key, command, options) => this.send(asBrick(key), command, options),
			maxPacketBytes: (key) => this.maxPacketBytes(asBrick(key)),
			transportOf: (key) => this.transportOfBrick(asBrick(key)),
			getActiveBrickKey: () => this.activeBrickId,
			getSession: (key) => {
				if (this.routes.has(asBrick(key))) { return { connectionState: ConnectionState.Connected }; }
				return this.signedIn.has(asBrick(key))
					? { connectionState: ConnectionState.Reconnecting }
					: undefined;
			},
			onSessionStateChange: (listener, thisArgs, disposables) => this.onRouteChange(
				(e) => {
					listener.call(thisArgs, {
						brickKey: e.brickId,
						newState: e.current ? ConnectionState.Connected : ConnectionState.Reconnecting,
					});
				}, undefined, disposables),
			onActiveBrickChange: (listener, thisArgs, disposables) => this.onActiveBrickChange(
				(e) => { listener.call(thisArgs, { previousBrickKey: e.previous, newBrickKey: e.current }); },
				undefined, disposables),
			onRouteChange: (listener, thisArgs, disposables) => this.onRouteChange(
				(e) => { listener.call(thisArgs, { brickKey: e.brickId }); }, undefined, disposables),
		};
	}

	// ── Active brick ────────────────────────────────────────────────

	getActiveBrickId(): BrickId | undefined {
		return this.activeBrickId;
	}

	/** Make a signed-in brick the active one. */
	setActiveBrick(brickId: BrickId): void {
		if (!this.signedIn.has(brickId)) {
			throw new NotConnectedError(`Brick ${brickId} is not signed in.`);
		}
		const previous = this.activeBrickId;
		this.activeBrickId = brickId;
		this.followRouteInSessionManager(brickId);
		if (previous !== brickId) {
			this._onActiveBrickChange.fire({ previous, current: brickId });
		}
	}

	clearActiveBrick(): void {
		const previous = this.activeBrickId;
		if (!previous) { return; }
		this.activeBrickId = undefined;
		this.sessionManager.clearActiveBrick();
		this._onActiveBrickChange.fire({ previous, current: undefined });
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		this.disposed = true;
		for (const brickId of [...this.signedIn.keys()]) { this.forgetSignIn(brickId); }
		// A pairing would otherwise keep the radio and the brick's dialog after nobody listens.
		for (const pairing of this.pairings.values()) { pairing.abort.abort(); }
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.subscriptions.length = 0;
		this._onRouteChange.dispose();
		this._onActiveBrickChange.dispose();
		this._onPairingStarted.dispose();
		this._onPeerListChange.dispose();
		this._onOneSidedRepair.dispose();
	}

	// ── Internal: joining ───────────────────────────────────────────

	/**
	 * Channels of a brick that are available, have no session yet, and can be connected over —
	 * the one list {@link signIn}, {@link reconcile} and {@link peerListChannel} all join from.
	 *
	 * A Bluetooth channel of a brick nobody has paired is left out (step-3 KTD12): it is a
	 * sighting — an inquiry, or Windows' cache relisting the brick unpaired after a forget or a
	 * cleared list — not a link. It joins once it is paired: by "Connect a Brick", or, for a
	 * signed-in brick, by the pairing {@link pairSighting} starts by itself, with the brick's
	 * dialog as the consent (step-4 KD1, KD2).
	 */
	private joinCandidates(brickId: BrickId): BrickKey[] {
		const entry = this.aggregator.getBrick(brickId);
		if (!entry) { return []; }
		return entry.channels
			.filter((c) => c.state === ChannelState.Available && (c.transport !== Transport.BT || entry.paired))
			.map((c) => c.brickKey)
			.filter((key) => !this.sessionManager.getSession(key));
	}

	/** Join every channel of a signed-in brick that can be joined now. Idempotent. */
	private reconcile(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		// A brick being forgotten loses its channels on purpose; none joins again (KTD4). A
		// rejoin that `scheduleRejoin` set up runs through here too, so it needs no check of its own.
		if (!signIn || this.disposed || this.forgetting.has(brickId)) { return; }
		for (const key of this.joinCandidates(brickId)) {
			if (signIn.pending.has(key) || signIn.awaitingEvidence.has(key) || signIn.retryTimers.has(key)) {
				continue;
			}
			this.join(brickId, key).catch(() => { /* recorded by join; retried per transport */ });
		}
		this.checkOneSided(brickId);
		this.pairSighting(brickId);
	}

	/**
	 * Pair a signed-in brick's Bluetooth channel when it is a sighting nobody has paired (step-4
	 * plan, KTD3): connecting means every channel that can work, and the brick's own dialog is
	 * the consent. The success's list change joins the channel.
	 *
	 * Runs on nearly every list change, so it is cheap and starts at most one pairing: `pair`
	 * joins one in flight, and none starts while the brick is suspended, which a clear does from
	 * its start; `reconcile` already skips a brick being forgotten. A sighting nothing hears any
	 * more is not paired: the pairing would only fail and suspend the brick.
	 */
	private pairSighting(brickId: BrickId): void {
		if (this.pairingSuspended.has(brickId) || this.oneSidedPending.has(brickId) || this.repairing.has(brickId)) { return; }
		const entry = this.aggregator.getBrick(brickId);
		const bt = entry?.channels.find((c) => c.transport === Transport.BT);
		if (!entry || entry.paired || bt?.state !== ChannelState.Available) { return; }
		this.pair(brickId).catch(() => { /* a failed pairing suspends the brick and is announced */ });
	}

	private async join(brickId: BrickId, key: BrickKey): Promise<void> {
		const signIn = this.signedIn.get(brickId);
		if (!signIn) { throw new NotConnectedError(`Brick ${brickId} is not signed in.`); }
		const transport = this.transportOf(key);
		signIn.pending.add(key);
		try {
			// Only where the check can run: anywhere else a Bluetooth join starts as it always did.
			if (transport === Transport.BT && this.windowsPairing && this.pairDevice) {
				await this.awaitOneSidedCheck(brickId, signIn);
			}
			// A connect from an earlier sign-in can still be inside the provider, a Bluetooth one
			// for seconds in the connection queue; the session manager makes this one wait its
			// turn, and rejects it if the brick is signed out meanwhile.
			const name = this.aggregator.getBrick(brickId)?.name.value;
			await this.sessionManager.connect(key, transport, name);
			signIn.backoff.delete(key);
			void this.readNameOverSession(key);
			// Signed out once the connect was through: the user asked for nothing to stay open.
			// A newer sign-in keeps the channel; it is the one it would have opened.
			if (!this.signedIn.has(brickId)) {
				await this.sessionManager.disconnect(key);
			}
		} catch (error) {
			// Nothing to say or retry for a join its sign-in no longer wants.
			if (error instanceof ConnectionAbandonedError || this.signedIn.get(brickId) !== signIn) { throw error; }
			// Said, because a channel that will not join is otherwise invisible: the brick works
			// over its other channels and nothing explains why this one stays unused.
			this.log?.warn(`Joining ${channelLabel(this.aggregator, key)} failed: `
				+ `${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRejoin(brickId, signIn, key, transport);
			throw error;
		} finally {
			signIn.pending.delete(key);
			// A USB or TCP join that ends may have been what held Bluetooth back.
			if (transport !== Transport.BT) { this.wakeBluetooth(brickId); }
		}
	}

	/**
	 * Hold a Bluetooth join until the one-sided check has run (step-4 U10), so every way into a join
	 * — sign-in, "Connect a Brick", a rejoin — waits at this one place. A connect over a pairing
	 * broken on the brick's side only fails, after holding the radio for 15 s and arming the queue's
	 * recovery pause, which on hardware starved the repair's own pairing.
	 *
	 * One microtask first, so USB and TCP joins started in the same pass are counted and a check
	 * released in the same pass is seen. Woken ({@link wakeBluetooth}) after each read of the list,
	 * whether it was read or failed (a USB channel that goes fails the read in flight), by a USB or
	 * TCP join that ends, by a repair that ends, and by a sign-out; a wake only makes the join look
	 * again.
	 *
	 * A join whose sign-in ended, whose brick is being forgotten or cleared, or whose pairing the
	 * repair removed (KD4) is abandoned and not retried: the pairing that follows makes the channel
	 * a candidate again.
	 */
	private async awaitOneSidedCheck(brickId: BrickId, signIn: SignIn): Promise<void> {
		await Promise.resolve();
		while (this.holdsBluetooth(brickId) && this.signedIn.get(brickId) === signIn && !this.disposed) {
			await new Promise<void>((resolve) => {
				const waiters = this.bluetoothWaiters.get(brickId) ?? new Set<() => void>();
				waiters.add(resolve);
				this.bluetoothWaiters.set(brickId, waiters);
			});
		}
		if (this.signedIn.get(brickId) !== signIn || this.disposed || this.forgetting.has(brickId)
			|| this.aggregator.getBrick(brickId)?.paired !== true) {
			throw new ConnectionAbandonedError(`Bluetooth of ${brickId} is no longer wanted after the pairing check.`);
		}
	}

	/**
	 * Whether the brick's Bluetooth joins wait for the one-sided check (step-4 U10): a USB or TCP
	 * channel is joining, is connected and waits to be checked, or a repair is removing a half. A
	 * USB or TCP join that is a retry after a failure holds nothing: a cable that keeps failing
	 * would otherwise keep Bluetooth out for good.
	 */
	private holdsBluetooth(brickId: BrickId): boolean {
		if (this.oneSidedPending.has(brickId) || this.repairing.has(brickId)) { return true; }
		const signIn = this.signedIn.get(brickId);
		return signIn !== undefined && [...signIn.pending]
			.some((key) => this.transportOf(key) !== Transport.BT && !signIn.backoff.has(key));
	}

	/** Let the Bluetooth joins held for this brick look again; spurious wakes cost nothing. */
	private wakeBluetooth(brickId: BrickId): void {
		const waiters = this.bluetoothWaiters.get(brickId);
		if (!waiters) { return; }
		this.bluetoothWaiters.delete(brickId);
		for (const wake of waiters) { wake(); }
	}

	private scheduleRejoin(brickId: BrickId, signIn: SignIn, key: BrickKey, transport: Transport): void {
		if (this.registry.get(transport)?.capabilities.rejoinOnEvidenceOnly) {
			signIn.awaitingEvidence.set(key, Date.now());
			return;
		}
		let backoff = signIn.backoff.get(key);
		if (!backoff) {
			backoff = new ReconnectStrategy({ baseMs: this.rejoinBaseMs, maxMs: this.rejoinMaxMs });
			signIn.backoff.set(key, backoff);
		}
		const delay = backoff.nextDelay() ?? this.rejoinMaxMs;
		const timer = setTimeout(() => {
			signIn.retryTimers.delete(key);
			this.reconcile(brickId);
		}, delay);
		timer.unref();
		signIn.retryTimers.set(key, timer);
	}

	/**
	 * A presence check answered after a join failed is the evidence that join was waiting for:
	 * the brick is there now, whatever stopped the last attempt.
	 */
	private takeAnswersAsEvidence(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		if (!signIn || signIn.awaitingEvidence.size === 0) { return; }
		for (const channel of this.aggregator.getBrick(brickId)?.channels ?? []) {
			const failedAt = signIn.awaitingEvidence.get(channel.brickKey);
			if (failedAt !== undefined && (channel.heardAt ?? 0) > failedAt) {
				signIn.awaitingEvidence.delete(channel.brickKey);
			}
		}
	}

	private forgetSignIn(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		if (!signIn) { return; }
		for (const timer of signIn.retryTimers.values()) { clearTimeout(timer); }
		this.signedIn.delete(brickId);
		this.oneSidedPending.delete(brickId);
		this.pairedBefore.delete(brickId);
		// A Bluetooth join held for the check belongs to the sign-in that just ended: it gives up.
		this.wakeBluetooth(brickId);
	}

	// ── Internal: forgetting ────────────────────────────────────────

	/** Hold the guards of a forget for a brick (KTD4); each hold needs its own {@link releaseGuards}. */
	private holdGuards(brickId: BrickId): void {
		this.forgetting.set(brickId, (this.forgetting.get(brickId) ?? 0) + 1);
		this.guardHolds.set(brickId, (this.guardHolds.get(brickId) ?? 0) + 1);
	}

	/**
	 * Suspend the brick's automatic pairing and stop a pairing in flight, waiting until it has
	 * ended: a forget or clear that went on beside it could have a pairing finish behind it and
	 * leave this computer's entry on the brick, or Windows paired, after the user asked otherwise.
	 * Called before the brick's list is read.
	 */
	private async stopPairing(brickId: BrickId): Promise<void> {
		this.pairingSuspended.add(brickId);
		// What a forget or clear reads is not checked (KTD6): it is about to change both halves.
		this.oneSidedPending.delete(brickId);
		const pairing = this.pairings.get(brickId);
		if (!pairing) { return; }
		pairing.abort.abort();
		await pairing.done.catch(() => undefined);
	}

	private releaseGuards(brickId: BrickId): void {
		const left = (this.forgetting.get(brickId) ?? 1) - 1;
		if (left > 0) { this.forgetting.set(brickId, left); } else { this.forgetting.delete(brickId); }
	}

	private async runForget(brickId: BrickId): Promise<ForgetReport> {
		this.holdGuards(brickId);
		let report: ForgetReport;
		try {
			await this.stopPairing(brickId);
			// Read before anything is forgotten: the list is where the channels and the Bluetooth
			// address come from, and step 5 deletes it.
			const keys = this.channelKeysOf(brickId);
			const { outcome: brickSide, peers } = await this.removeOwnEntry(brickId).catch((error: unknown) => ({
				outcome: { status: 'skipped', reason: 'error', detail: messageOf(error) } as BrickSideOutcome,
				peers: undefined,
			}));
			try {
				await this.signOut(brickId);
			} catch (error) {
				// The providers' forget below closes their links again; the rest still runs.
				this.log?.warn(`Signing ${brickId} out to forget it failed: ${messageOf(error)}`);
			}
			const { pairing, residue } = await this.forgetPairings(keys);
			const memory = this.forgetMemory(brickId, keys);
			report = { brickId, brickSide, ...(peers ? { peers } : {}), pairing, memory, residue };
		} finally {
			this.releaseGuards(brickId);
		}
		// Not awaited: the report does not depend on it, and a scan can hang in the operating system.
		this.discovery?.scanOnce().catch(() => { /* a failed scan is the scheduler's to report */ });
		return report;
	}

	/** Every channel the list or a session holds for a brick. */
	private channelKeysOf(brickId: BrickId): BrickKey[] {
		const keys = new Set<BrickKey>(this.aggregator.getBrick(brickId)?.channels.map((c) => c.brickKey) ?? []);
		for (const session of this.sessionManager.getAllSessions()) {
			if (brickIdOf(session.brickKey) === brickId) { keys.add(session.brickKey); }
		}
		return [...keys];
	}

	/**
	 * Remove this computer's entry from the brick's Bluetooth list (KTD5, R7, R8).
	 *
	 * The entry is found by an exact match on this computer's radio name, the name the brick
	 * stored it under and compares with `strcmp` (KTD3, `c_bt.c` 2215). No name, no channel, no
	 * list or no match: nothing is sent, and the outcome says which.
	 */
	private async removeOwnEntry(brickId: BrickId): Promise<{ outcome: BrickSideOutcome; peers?: string[] }> {
		const name = this.radioName?.();
		if (!name) { return { outcome: { status: 'skipped', reason: 'radio-name-unknown' } }; }

		const channel = await this.peerListChannel(brickId);
		if (!channel.key) {
			return {
				outcome: {
					status: 'skipped', reason: 'not-reachable', ...(channel.failure ? { detail: channel.failure } : {}),
				},
			};
		}
		let peers: string[];
		try {
			peers = namesOf(await this.readPeers(channel.key));
		} catch (error) {
			return { outcome: { status: 'skipped', reason: 'list-unreadable', detail: messageOf(error) } };
		}
		const held = countOf(peers, name);
		if (held === 0) { return { outcome: { status: 'skipped', reason: 'no-match' }, peers }; }
		return { outcome: await this.removePeer(brickId, channel.key, name, held), peers };
	}

	/**
	 * The channel the brick's list is read and changed over (KTD5): a connected one if there is
	 * one, otherwise the best available one, opened for this alone through the session manager
	 * — not through {@link signIn}, which would join every available channel. A failed open
	 * means the brick is not reachable (R8); step 3 of the forget closes what this opened.
	 *
	 * Bluetooth comes last, below what the providers' priorities say (USB 30, Bluetooth 20, TCP
	 * 10): only a channel the removal does not cut can read the list back and confirm it. The
	 * same order holds among connected channels, so a brick connected over TCP and Bluetooth
	 * is changed over TCP although its traffic goes over Bluetooth.
	 *
	 * Without one available, a paired Bluetooth channel the presence checks did not hear is tried
	 * as well: the checks miss bricks right next to the computer (step-3 U7, 01.11.2026), and a
	 * brick that is there should lose this computer's entry too (KD2). A brick that is really off
	 * costs one failed connect, and the report says why.
	 *
	 * `opened` says the channel was opened here, so whoever asked closes it when done.
	 */
	private async peerListChannel(brickId: BrickId): Promise<{ key?: BrickKey; failure?: string; opened?: boolean }> {
		const connected = this.connectedPeerListChannel(brickId);
		if (connected) { return { key: connected }; }

		const available = this.bestForPeerList(this.joinCandidates(brickId)) ?? this.unheardBluetooth(brickId);
		if (!available) { return {}; }
		try {
			await this.sessionManager.connect(available, this.transportOf(available),
				this.aggregator.getBrick(brickId)?.name.value);
			return { key: available, opened: true };
		} catch (error) {
			return { failure: messageOf(error) };
		}
	}

	private connectedPeerListChannel(brickId: BrickId): BrickKey | undefined {
		return this.bestForPeerList(this.sessionManager.getAllSessions()
			.filter((s) => brickIdOf(s.brickKey) === brickId
				&& s.connectionState === ConnectionState.Connected
				&& !this.dropped.has(s.brickKey))
			.map((s) => s.brickKey));
	}

	/** This computer's Bluetooth name; undefined when it cannot be read, whatever the reason. */
	private readRadioName(): string | undefined {
		try {
			return this.radioName?.() || undefined;
		} catch {
			return undefined;
		}
	}

	private bestForPeerList(keys: BrickKey[]): BrickKey | undefined {
		return keys.sort((a, b) => this.peerListRank(b) - this.peerListRank(a))[0];
	}

	/** A forget or a clear is reading or changing the brick's list, and its reading is the one that counts. */
	private peerListBusy(brickId: BrickId): boolean {
		return this.forgetting.has(brickId) || this.clearing.has(brickId);
	}

	/**
	 * Keep a read of the brick's list, and say so when it differs from the last one (KTD8). A read
	 * that returns the same list replaces the last one silently: only when and over what changed.
	 */
	private recordPeers(brickId: BrickId, over: BrickKey, peers: readonly BrickPeer[]): BrickPeerList {
		const previous = this.peerLists.get(brickId);
		const list: BrickPeerList = { peers: [...peers], over, readAt: Date.now() };
		this.peerLists.set(brickId, list);
		this.peerListNumber.set(brickId, ++this.peerReadsKept);
		if (!previous || !samePeers(previous.peers, peers)) { this._onPeerListChange.fire({ brickId, current: list }); }
		return list;
	}

	/**
	 * Read the brick's list after something that may have changed it (a join, a pairing), over a
	 * channel already connected; with none, or while a forget or a clear runs, there is nothing to
	 * do. A failed read keeps the last list and is said in the log; it fails nothing else.
	 */
	private readPeerListAfter(brickId: BrickId, what: string): void {
		if (this.disposed || this.peerListBusy(brickId) || !this.connectedPeerListChannel(brickId)) { return; }
		this.refreshPeerList(brickId).then(() => {
			this.checkOneSided(brickId);
			this.wakeBluetooth(brickId);
		}, (error: unknown) => {
			this.log?.warn(`Reading the list of paired computers of ${brickLabel(this.aggregator, brickId)} after `
				+ `${what} failed: ${messageOf(error)}`);
			// Nothing to check against: automatic pairing and Bluetooth go on rather than wait for a
			// read that may never come.
			if (this.oneSidedPending.delete(brickId)) { this.pairSighting(brickId); }
			this.wakeBluetooth(brickId);
		});
	}

	// ── Internal: a pairing broken on one side ──────────────────────

	/**
	 * Windows stopped listing a signed-in brick as paired, outside the cockpit (Settings), while
	 * USB or TCP is connected: read the brick's list and check again before anything pairs it
	 * (KTD6: the check runs before any pairing). The check that ran when the channel joined saw
	 * both halves; the brick still lists this computer, so pairing beside that entry would leave
	 * it to the brick, where the repair removes it first. Not during a repair, a forget or a clear:
	 * they unpair Windows themselves.
	 */
	private checkAgainWhenUnpaired(brickId: BrickId): void {
		const paired = this.aggregator.getBrick(brickId)?.paired === true;
		const before = this.pairedBefore.get(brickId);
		this.pairedBefore.set(brickId, paired);
		if (before !== true || paired || !this.windowsPairing || this.repairing.has(brickId) || this.peerListBusy(brickId)
			|| !this.checkableChannelConnected(brickId)) {
			return;
		}
		this.oneSidedPending.set(brickId, this.peerReadsKept);
		this.readPeerListAfter(brickId, 'Windows unpaired it');
	}

	/** A USB or TCP channel of a signed-in brick joined or ended: the brick waits for the check, or no longer can. */
	private noteCheckableChannel(key: BrickKey, state: ConnectionState): void {
		if (!this.windowsPairing || this.transportOf(key) === Transport.BT) { return; }
		const brickId = brickIdOf(key);
		if (state === ConnectionState.Connected && this.signedIn.has(brickId) && !this.peerListBusy(brickId)) {
			this.oneSidedPending.set(brickId, this.peerReadsKept);
		} else if (state === ConnectionState.Disconnected && !this.checkableChannelConnected(brickId)) {
			// Over Bluetooth alone the check does not run (KTD6); the brick pairs as before. A held
			// Bluetooth join is woken by the read in flight, which the disconnect fails; with no read
			// in flight the check has already run.
			this.oneSidedPending.delete(brickId);
		}
	}

	/** Whether any channel of the brick is connected. */
	private hasConnectedChannel(brickId: BrickId): boolean {
		return this.sessionManager.getAllSessions().some((s) => brickIdOf(s.brickKey) === brickId
			&& s.connectionState === ConnectionState.Connected);
	}

	/** Whether a USB or TCP channel of the brick is connected: the only ones its list is checked over. */
	private checkableChannelConnected(brickId: BrickId): boolean {
		return this.sessionManager.getAllSessions().some((s) => brickIdOf(s.brickKey) === brickId
			&& s.connectionState === ConnectionState.Connected && this.transportOf(s.brickKey) !== Transport.BT);
	}

	/**
	 * The one-sided check (step-4 plan, KTD6, R6): once the brick's list has been read over USB or
	 * TCP since such a channel joined, compare it, by this computer's exact radio name, with
	 * Windows' pairing as discovery tracks it, and repair the half that is left.
	 *
	 * Held, and run again by what ends the wait, while a pairing of the brick is in flight (the
	 * read after it), while a forget or clear runs (they drop the wait), before any Bluetooth scan
	 * has answered (the first that does: the list is rebuilt after every scan, which reconciles),
	 * and until the list is read. A list read over Bluetooth is not checked even then: with the USB
	 * channel out of routing, a removal over Bluetooth would cut the link it goes over. Released without a check
	 * when there is nothing to check with — no radio name, no pairing — and automatic pairing goes
	 * on as it did before. A suspended brick gets nothing but a line in the log (KD2); a brick
	 * repaired since the last "Connect a Brick" gets a report and nothing else.
	 */
	private checkOneSided(brickId: BrickId): void {
		const since = this.oneSidedPending.get(brickId);
		if (since === undefined || this.repairing.has(brickId)) { return; }
		if (!this.pairDevice || !this.windowsPairing) {
			this.oneSidedPending.delete(brickId);
			this.pairSighting(brickId);
			return;
		}
		if (this.pairings.has(brickId) || this.peerListBusy(brickId) || !this.windowsPairing.hasScanned(Transport.BT)) { return; }
		const list = this.peerLists.get(brickId);
		if (!list || this.transportOf(list.over) === Transport.BT || (this.peerListNumber.get(brickId) ?? 0) <= since) { return; }
		this.oneSidedPending.delete(brickId);
		// Read last: a native call, and this runs on every list change while the brick waits.
		const name = this.readRadioName();
		if (!name) {
			this.pairSighting(brickId);
			return;
		}

		const tracked = [...this.windowsPairing.getTrackedBricks().values()]
			.find((item) => item.transport === Transport.BT && brickIdOf(item.brickKey) === brickId);
		// Paired as Windows lists it now: a pairing removed elsewhere leaves the item marked paired
		// until the scans that miss it expire it.
		const windowsPaired = tracked?.paired === true && tracked.presenceState === PresenceState.Available;
		const onBrick = list.peers.some((peer) => peer.name === name);
		if (windowsPaired === onBrick) {
			this.pairSighting(brickId);
			return;
		}

		const found = windowsPaired ? 'windows-only' : 'brick-only';
		const others = namesOf(list.peers).filter((entry) => entry !== name && !isBlankPeerName(entry));
		const label = brickLabel(this.aggregator, brickId);
		if (this.pairingSuspended.has(brickId)) {
			this.log?.warn(`The pairing with ${label} looks one-sided (${found}); "Connect a Brick" repairs it.`);
			return;
		}
		if (this.repaired.has(brickId)) {
			this.log?.warn(`The pairing with ${label} still looks one-sided (${found}) after a repair; left alone.`);
			this._onOneSidedRepair.fire({ brickId, found, others, repeated: true });
			return;
		}
		void this.repairOneSided(brickId, found, name, list, tracked?.brickKey, others);
	}

	/**
	 * Remove the half of a one-sided pairing that is left, keeping the brick's other channels, then
	 * pair again: the brick's dialog is the consent (KD5). Nothing pairs when the removal did not
	 * take, or when the brick was signed out or is being forgotten meanwhile.
	 */
	private async repairOneSided(
		brickId: BrickId, found: OneSidedRepair['found'], name: string, list: BrickPeerList,
		trackedKey: BrickKey | undefined, others: readonly string[],
	): Promise<void> {
		this.repairing.add(brickId);
		this.repaired.add(brickId);
		try {
			const btKey = trackedKey
				?? this.aggregator.getBrick(brickId)?.channels.find((c) => c.transport === Transport.BT)?.brickKey
				?? bluetoothKeyOf(brickId);
			let removal: PairingOutcome | PeerRemoval;
			if (found === 'windows-only' && btKey) {
				const { pairing } = await this.forgetBluetoothChannel(brickId, btKey);
				removal = pairing[0] ?? { status: 'refused', channel: btKey, reason: 'No provider can unpair it.' };
			} else {
				removal = await this.removePeer(brickId, list.over, name, countOf(namesOf(list.peers), name));
			}
			const removed = removal.status === 'removed' || removal.status === 'confirmed';
			// A forget or a clear that began during the removal suspended the brick (KD2).
			const pairing = removed && btKey && this.signedIn.has(brickId) && !this.pairingSuspended.has(brickId)
				? this.pairOver(brickId, btKey)
				: undefined;
			this._onOneSidedRepair.fire({ brickId, found, removal, others, ...(pairing ? { pairing } : {}) });
		} catch (error) {
			this.log?.warn(`Repairing the pairing of ${brickLabel(this.aggregator, brickId)} failed: ${messageOf(error)}`);
		} finally {
			this.repairing.delete(brickId);
			// A Bluetooth join held for the repair looks again: a pairing that fails or is cancelled,
			// or a removal that did not take, reads no list afterwards to wake it.
			this.wakeBluetooth(brickId);
		}
	}

	/** The brick's paired Bluetooth channel when the presence checks lost it and nothing holds it open. */
	private unheardBluetooth(brickId: BrickId): BrickKey | undefined {
		const entry = this.aggregator.getBrick(brickId);
		const bt = entry?.channels.find((c) => c.transport === Transport.BT);
		if (!entry?.paired || bt?.state !== ChannelState.Lost || this.sessionManager.getSession(bt.brickKey)) { return undefined; }
		return bt.brickKey;
	}

	private peerListRank(key: BrickKey): number {
		return (this.transportOf(key) === Transport.BT ? 0 : 1000) + this.priorityOf(key);
	}

	/**
	 * The brick's Bluetooth list over one channel, names untrimmed: the count, then each index
	 * below it, because the firmware does not bounds-check the index (KTD2, `c_bt.c` 3561–3567).
	 */
	private async readPeers(key: BrickKey): Promise<BrickPeer[]> {
		const count = await this.sessionManager.send(key, { kind: 'brick:bluetoothPeerCount' });
		if (count.kind !== 'brick:bluetoothPeerCount') {
			throw new ProtocolError(`Expected the Bluetooth peer count, got ${count.kind}.`);
		}
		const peers: BrickPeer[] = [];
		for (let index = 0; index < count.count; index++) {
			const peer = await this.sessionManager.send(key, { kind: 'brick:bluetoothPeer', index });
			if (peer.kind !== 'brick:bluetoothPeer') {
				throw new ProtocolError(`Expected Bluetooth peer ${index}, got ${peer.kind}.`);
			}
			peers.push({ name: peer.name, connected: peer.connected });
		}
		return peers;
	}

	/**
	 * Remove one entry from the brick's list over `key`, and find out whether it went (KTD5, R9).
	 *
	 * Over USB or TCP the brick's Bluetooth sessions are closed first, explicitly: the removal
	 * cuts the link of the peer it removes (`c_bt.c` 3609–3612), and the session manager would
	 * otherwise reconnect it to a brick that has just dropped this computer. Over Bluetooth the
	 * removal is the last command on its link, so a drop or a timeout is all that comes back
	 * and it counts as sent. A normal reply means the firmware did not run it — its Bluetooth
	 * is off or busy (`c_bt.c` 3594–3656) — and the list read back says so.
	 *
	 * Sent once, with the normal timeout, and through the session manager rather than
	 * {@link send}, so a failure here is not a failover. The brick's VM waits on BlueZ while it
	 * removes; a retry would only wait again.
	 *
	 * `held` is how many entries carried the name in the list read before. The firmware removes
	 * only the first that matches (`c_bt.c` 2215, 3603–3622), so the read-back is judged by count,
	 * not by whether the name is still there: one fewer is confirmed, and any still held under
	 * the name are reported as remaining.
	 */
	private async removePeer(brickId: BrickId, key: BrickKey, name: string, held: number): Promise<PeerRemoval> {
		if (this.transportOf(key) !== Transport.BT) { await this.closeBluetoothSessions(brickId); }
		try {
			await this.sessionManager.send(key, { kind: 'brick:removeBluetoothPeer', name });
		} catch (error) {
			return isLinkFailure(error, undefined)
				? { status: 'sent', name, over: key, detail: messageOf(error) }
				: { status: 'failed', name, over: key, detail: messageOf(error) };
		}
		let after: string[];
		try {
			after = namesOf(await this.readPeers(key));
		} catch (error) {
			return { status: 'sent', name, over: key, detail: messageOf(error) };
		}
		const remaining = countOf(after, name);
		if (remaining >= held) {
			return { status: 'failed', name, over: key, detail: 'The list read back still holds the entry.' };
		}
		return { status: 'confirmed', name, over: key, ...(remaining > 0 ? { remaining } : {}) };
	}

	/** Close every Bluetooth session of a brick explicitly, so the session manager reopens none. */
	private async closeBluetoothSessions(brickId: BrickId): Promise<void> {
		const keys = this.sessionManager.getAllSessions()
			.map((s) => s.brickKey)
			.filter((key) => brickIdOf(key) === brickId && this.transportOf(key) === Transport.BT);
		await Promise.all(keys.map((key) => this.sessionManager.disconnect(key)));
	}

	/**
	 * Each channel's provider forgets the brick where it can (KTD6, R5). One provider at a time;
	 * a refusal is recorded with the provider's reason and the next still runs.
	 */
	private async forgetPairings(keys: readonly BrickKey[]): Promise<{
		pairing: PairingOutcome[]; residue: ForgetResidue[];
	}> {
		const pairing: PairingOutcome[] = [];
		const residue: ForgetResidue[] = [];
		for (const key of keys) {
			const provider = this.registry.get(this.transportOf(key));
			if (!provider?.capabilities.supportsForget || !provider.forget) { continue; }
			try {
				residue.push(...await provider.forget(key));
				pairing.push({ status: 'removed', channel: key });
			} catch (error) {
				pairing.push({ status: 'refused', channel: key, reason: messageOf(error) });
			}
		}
		return { pairing, residue };
	}

	/**
	 * Clear every layer's memory of the brick (KTD7) in one synchronous block: an await between
	 * two of these would let a scan finish in the gap and rebuild the brick from a layer not yet
	 * cleared. Discovery goes before the list, which a scan rebuilds from it.
	 */
	private forgetMemory(brickId: BrickId, keys: readonly BrickKey[]): MemoryOutcome {
		const outcome = this.forgetLayers(keys, () => this.aggregator.forget(brickId));
		if (this.peerLists.delete(brickId)) { this._onPeerListChange.fire({ brickId, current: undefined }); }
		this.peerListNumber.delete(brickId);
		this.repaired.delete(brickId);
		// Sign-out already did these; a sign-out that failed part-way may not have.
		this.forgetSignIn(brickId);
		this.recomputeRoute(brickId);
		return outcome;
	}

	/**
	 * Every layer forgets these channels, and `forgetInList` drops them from the list (KTD7);
	 * synchronous, for the reason {@link forgetMemory} gives.
	 */
	private forgetLayers(keys: readonly BrickKey[], forgetInList: () => void): MemoryOutcome {
		const failures: string[] = [];
		const attempt = (step: () => void): void => {
			try { step(); } catch (error) { failures.push(messageOf(error)); }
		};
		if (this.discovery) {
			attempt(() => this.discovery?.forget(keys));
		} else {
			// The list is rebuilt from discovery's tracked channels, so without this the next scan
			// brings the brick back as it was.
			failures.push('Discovery was not reachable, so it still tracks the brick\'s channels.');
		}
		attempt(forgetInList);
		for (const key of keys) {
			const mac = brickKeyTransport(key) === Transport.BT ? brickKeyId(key) : undefined;
			if (mac) { attempt(() => this.btPresence?.forget(mac)); }
			this.dropped.delete(key);
			this.probing.delete(key);
			this.probeFailuresReported.delete(key);
		}
		return failures.length > 0 ? { status: 'failed', detail: failures.join('; ') } : { status: 'cleared' };
	}

	// ── Internal: clearing a brick's list ───────────────────────────

	private async runClear(brickId: BrickId, confirm: ClearListConfirm): Promise<ClearListReport | undefined> {
		// Before the list is read: a pairing that finished while the list was being read would add
		// an entry for this computer that the clear never shows or removes.
		await this.stopPairing(brickId);
		const thisComputer = this.readRadioName();
		// Read before anything changes: whether Windows has the brick paired decides KTD10.
		const wasPaired = this.aggregator.getBrick(brickId)?.paired ?? false;
		const btKey = this.channelKeysOf(brickId).find((key) => this.transportOf(key) === Transport.BT);
		const base = { brickId, ...(thisComputer ? { thisComputer } : {}), paired: wasPaired, pairing: [], residue: [] };
		const skipped = (reason: ClearSkip, detail?: string): ClearListReport => ({
			...base, skipped: { reason, ...(detail ? { detail } : {}) }, entries: [],
			pairingLeft: reason === 'radio-name-unknown' ? 'radio-name-unknown' : 'not-removed',
		});

		const channel = await this.peerListChannel(brickId);
		if (!channel.key) { return skipped('not-reachable', channel.failure); }
		const key = channel.key;
		const overBt = this.transportOf(key) === Transport.BT;
		// A brick signed in meanwhile keeps it: it is a channel the sign-in would have joined.
		const closeOpened = async (): Promise<void> => {
			if (channel.opened && !this.signedIn.has(brickId)) { await this.sessionManager.disconnect(key); }
		};

		let list: BrickPeer[];
		try {
			list = await this.readPeers(key);
		} catch (error) {
			await closeOpened();
			return { ...skipped('list-unreadable', messageOf(error)), over: key };
		}
		this.recordPeers(brickId, key, list);
		const peers = namesOf(list);
		const read = { over: key, peers };
		const names = peers.filter((name) => !isBlankPeerName(name));
		const unnamed = peers.filter(isBlankPeerName).map((name): ClearedEntry => ({ status: 'not-removable', name, reason: 'blank-name' }));
		if (names.length === 0) {
			await closeOpened();
			return { ...skipped('nothing-to-remove'), ...read, entries: unnamed };
		}
		// Over Bluetooth alone, the entry the brick holds this link under reads connected
		// (`c_bt.c` 3566) — under whatever name this computer had when it paired, an earlier one
		// too. Its removal is the one that cuts the link (`c_bt.c` 3609–3612), so the entries
		// marked connected go last, after any carrying the radio name. Over USB or Wi-Fi the mark
		// may be another computer's link, so it says nothing about this computer there.
		const linked = overBt ? namesOf(list.filter((peer) => peer.connected && !isBlankPeerName(peer.name))) : [];
		// This computer's entry is what decides the Windows pairing (KTD10), so it is the one
		// entry that must not be mistaken: the entries carrying the radio name; without any, the
		// one entry marked connected; with two marked, neither — either may be another computer's
		// link, and its removal would unpair Windows while this computer's entry stays.
		const named = thisComputer && names.includes(thisComputer) ? [thisComputer] : [];
		const ours: ReadonlySet<string> = new Set(named.length > 0 ? named : linked.length === 1 ? linked : []);
		// Over Bluetooth alone no order is safe when nothing tells which entry is this link's: any
		// removal may be the one that cuts it, leaving the entries after it and a pairing nothing
		// can tell is one-sided.
		if (overBt && ours.size === 0) {
			await closeOpened();
			return { ...skipped(thisComputer ? 'link-entry-unknown' : 'radio-name-unknown'), ...read };
		}
		// The brick removes the first entry a name matches (`c_bt.c` 2215). Over Bluetooth alone,
		// with a name that goes last held twice, that may be the copy holding this link: its
		// removal cuts the link before the other copy is sent.
		const goLast = [...(thisComputer ? [thisComputer] : []), ...linked];
		if (overBt && goLast.some((name) => countOf(names, name) > 1)) {
			await closeOpened();
			return { ...skipped('duplicate-link-entry'), ...read };
		}
		const includesThisComputer = ours.size > 0;
		if (!await confirm(names, includesThisComputer, thisComputer)) {
			await closeOpened();
			return undefined;
		}

		this.holdGuards(brickId);
		try {
			// The removal of this computer's entry cuts its Bluetooth link (KTD5); closed first, so
			// nothing reconnects it to a brick that has just dropped this computer.
			if (!overBt) { await this.closeBluetoothSessions(brickId); }
			const last = overBt ? { named: new Set(thisComputer ? [thisComputer] : []), linked: new Set(linked) } : undefined;
			const { entries, linkCut, left: leftPeers } = await this.removeEntries(key, list, last);
			this.recordPeers(brickId, key, leftPeers);
			const left = namesOf(leftPeers);
			if (overBt && linkCut) {
				// The link the list went over is gone, and nothing else reached the brick.
				if (this.signedIn.has(brickId)) { await this.signOut(brickId); } else { await this.sessionManager.disconnect(key); }
			}

			// Gone only when no entry under this computer's name is left: with the name held twice
			// and one copy kept, the brick still knows this computer.
			const thisComputerWent = includesThisComputer && [...ours].every((name) => !left.includes(name));
			let pairingLeft: ClearPairingSkip | undefined;
			if (!includesThisComputer) { pairingLeft = thisComputer ? 'not-on-brick' : 'radio-name-unknown'; }
			else if (!thisComputerWent) { pairingLeft = 'not-removed'; }
			else if (!btKey || !wasPaired) { pairingLeft = 'not-paired'; }

			const bluetooth = btKey && !pairingLeft ? await this.forgetBluetoothChannel(brickId, btKey) : undefined;
			await closeOpened();
			return {
				...base, ...read, entries, left,
				...(bluetooth ?? {}),
				...(pairingLeft ? { pairingLeft } : {}),
			};
		} finally {
			this.releaseGuards(brickId);
		}
	}

	/**
	 * Remove every named entry of `peers` from the brick's list over `key`, each confirmed by
	 * reading the list back (KTD9, R17).
	 *
	 * What it removes is the names the user was shown, so an entry that appears meanwhile is not
	 * removed unseen (R16). A pass sends each name still to go once and reads the list back after
	 * each; a name held twice goes once per pass. It stops when every name has gone, when a pass
	 * removes nothing, so an entry the brick keeps cannot loop, or after as many passes as the
	 * list had entries. `last`, over Bluetooth alone, holds this computer's radio name and the
	 * names of the entries marked connected: those go only after every other, because the
	 * removal of the link's entry cuts the link (KTD5), and of the two the marked ones go last —
	 * the link is held under a marked one, so one carrying only the radio name sent after it
	 * would never be sent.
	 *
	 * A link lost on a removal, or a list that cannot be read back after one, ends it: that
	 * removal counts as sent, and the entries not yet removed as not sent. `left` is the list as
	 * last read back, less the one entry whose removal counts as sent.
	 */
	private async removeEntries(key: BrickKey, list: readonly BrickPeer[], last: {
		readonly named: ReadonlySet<string>; readonly linked: ReadonlySet<string>;
	} | undefined): Promise<{
		entries: ClearedEntry[]; linkCut: boolean; left: BrickPeer[];
	}> {
		const peers = namesOf(list);
		const toGo = new Map<string, number>();
		for (const name of peers) { if (!isBlankPeerName(name)) { toGo.set(name, (toGo.get(name) ?? 0) + 1); } }
		const removed = new Map<string, number>();
		const lastFailure = new Map<string, string>();
		let current: readonly BrickPeer[] = list;
		let sent: { name: string; detail: string } | undefined;

		const phases: ((name: string) => boolean)[] = last === undefined
			? [() => true]
			: [
				(name) => !last.named.has(name) && !last.linked.has(name),
				(name) => last.named.has(name) && !last.linked.has(name),
				(name) => last.linked.has(name),
			];
		for (const inPhase of phases) {
			for (let pass = 0; pass < peers.length && !sent; pass++) {
				const names = [...toGo].filter(([name, left]) => left > 0 && inPhase(name)).map(([name]) => name);
				if (names.length === 0) { break; }
				let progress = false;
				for (const name of names) {
					const before = countOf(namesOf(current), name);
					try {
						await this.sessionManager.send(key, { kind: 'brick:removeBluetoothPeer', name });
					} catch (error) {
						if (isLinkFailure(error, undefined)) { sent = { name, detail: messageOf(error) }; break; }
						lastFailure.set(name, messageOf(error));
						continue;
					}
					try {
						current = await this.readPeers(key);
					} catch (error) {
						sent = { name, detail: messageOf(error) };
						break;
					}
					if (countOf(namesOf(current), name) < before) {
						removed.set(name, (removed.get(name) ?? 0) + 1);
						toGo.set(name, (toGo.get(name) ?? 1) - 1);
						progress = true;
					} else {
						lastFailure.set(name, 'The list read back still holds it.');
					}
				}
				if (!progress) { break; }
			}
		}

		let sentShown = false;
		const entries = peers.map((name): ClearedEntry => {
			if (isBlankPeerName(name)) { return { status: 'not-removable', name, reason: 'blank-name' }; }
			const confirmed = removed.get(name) ?? 0;
			if (confirmed > 0) {
				removed.set(name, confirmed - 1);
				return { status: 'confirmed', name };
			}
			if (sent && !sentShown && sent.name === name) {
				sentShown = true;
				return { status: 'sent', name, detail: sent.detail };
			}
			return {
				status: 'failed', name,
				detail: lastFailure.get(name) ?? (sent ? `Not sent: ${sent.detail}` : 'Not sent.'),
			};
		});
		const left = current.slice();
		const sentName = sent?.name;
		const sentAt = sentName === undefined ? -1 : left.findIndex((peer) => peer.name === sentName);
		if (sentAt !== -1) { left.splice(sentAt, 1); }
		return { entries, linkCut: sent !== undefined, left };
	}

	/**
	 * Forget the brick's Bluetooth channel and keep the brick (KTD10): the pairing through the
	 * provider (KTD6), then the cockpit's memory of that channel alone (KTD7). Every Bluetooth
	 * session of the brick is closed by now. A scan in flight read Windows' list before the
	 * unpair; discovery drops what it lists for the channel.
	 */
	private async forgetBluetoothChannel(brickId: BrickId, btKey: BrickKey): Promise<{
		pairing: PairingOutcome[]; residue: ForgetResidue[]; memory: MemoryOutcome;
	}> {
		await this.closeBluetoothSessions(brickId);
		const { pairing, residue } = await this.forgetPairings([btKey]);
		const memory = this.forgetLayers([btKey], () => this.aggregator.forgetChannel(btKey));
		const signIn = this.signedIn.get(brickId);
		if (signIn) {
			clearTimeout(signIn.retryTimers.get(btKey));
			signIn.retryTimers.delete(btKey);
			signIn.awaitingEvidence.delete(btKey);
			signIn.backoff.delete(btKey);
		}
		this.recomputeRoute(brickId);
		return { pairing, residue, memory };
	}

	// ── Internal: names ─────────────────────────────────────────────

	/** Ask a channel's session for the brick's name and record it as confirmed. */
	private async readNameOverSession(key: BrickKey): Promise<void> {
		try {
			const reply = await this.sessionManager.send(key, { kind: 'info' });
			if (reply.kind === 'info') { this.aggregator.confirmName(brickIdOf(key), reply.displayName); }
		} catch {
			// The name stays what discovery said; the heartbeat deals with the link.
		}
	}

	/**
	 * Ask a brick that has just appeared for its name, without signing it in.
	 *
	 * Only where the transport offers a probe (USB), and only for a brick nobody is signed
	 * into: a signed-in brick's join reads the name itself, and a probe would hold the device
	 * the join is about to open.
	 */
	private probeName(key: BrickKey): void {
		const provider = this.registry.get(this.transportOf(key));
		if (!provider?.openProbe || this.probing.has(key)) { return; }
		if (this.signedIn.has(brickIdOf(key)) || this.sessionManager.getSession(key)) { return; }

		this.probing.add(key);
		void (async () => {
			try {
				const link = await provider.openProbe!(key);
				try {
					const channel = new PacketCommandChannel(
						(packet, options) => link.sendPacket(packet, options), provider.transport);
					const reply = await channel.execute({ kind: 'info' });
					if (reply.kind === 'info') { this.aggregator.confirmName(brickIdOf(key), reply.displayName); }
				} finally {
					await link.close();
				}
			} catch (error) {
				if (!this.probeFailuresReported.has(key)) {
					this.probeFailuresReported.add(key);
					this.log?.warn(`Could not read the name of ${channelLabel(this.aggregator, key)} without connecting; showing `
						+ `the USB descriptor's until it connects: ${error instanceof Error ? error.message : String(error)}`);
				}
			} finally {
				this.probing.delete(key);
			}
		})();
	}

	// ── Internal: routing ───────────────────────────────────────────

	private dropFromRouting(key: BrickKey): void {
		// A brick being forgotten loses its links on purpose, and the probe below would put a
		// lost one into reconnecting (KTD4).
		if (this.dropped.has(key) || this.forgetting.has(brickIdOf(key))) { return; }
		this.dropped.add(key);
		const brickId = brickIdOf(key);
		this.recomputeRoute(brickId);
		void this.sessionManager.probeNow(key).then((answered) => {
			if (answered && this.dropped.delete(key)) { this.recomputeRoute(brickId); }
		});
	}

	/** The connected, undropped channel with the highest priority its provider declares. */
	private recomputeRoute(brickId: BrickId): void {
		const best = this.sessionManager.getAllSessions()
			.filter((s) => brickIdOf(s.brickKey) === brickId
				&& s.connectionState === ConnectionState.Connected
				&& !this.dropped.has(s.brickKey))
			.map((s) => s.brickKey)
			.sort((a, b) => this.priorityOf(b) - this.priorityOf(a))[0];

		const previous = this.routes.get(brickId);
		if (best === previous) { return; }
		if (best) { this.routes.set(brickId, best); } else { this.routes.delete(brickId); }
		if (this.activeBrickId === brickId) { this.followRouteInSessionManager(brickId); }
		this._onRouteChange.fire({ brickId, previous, current: best });
	}

	/** The session manager's foreground follows the active brick's route channel. */
	private followRouteInSessionManager(brickId: BrickId): void {
		const route = this.routes.get(brickId);
		if (route) { this.sessionManager.setActiveBrick(route); }
	}

	private priorityOf(key: BrickKey): number {
		return this.registry.get(this.transportOf(key))?.priority ?? 0;
	}

	private transportOf(key: BrickKey): Transport {
		// Every key this layer handles came from discovery or a session, so it is well formed.
		return this.sessionManager.getSession(key)?.transport ?? brickKeyTransport(key) as Transport;
	}
}
