/**
 * Bluetooth transport provider — composes BT adapters + EV3 protocol layer.
 *
 * Two BT backends, in this order:
 * - Winsock2 AF_BTH RFCOMM via koffi — the testlab's chosen runtime, preferred here.
 * - SPP over the paired brick's serial port — fallback, and the only path where the
 *   FFI cannot load.
 *
 * A WinRT StreamSocket backend was once planned and is excluded: it needs a .NET helper
 * process, which the testlab ruled out for extension compatibility. See DESIGN §4.1.1.
 *
 * BT connections are serialized through {@link BtConnectionQueue} to respect
 * the Windows RFCOMM single-channel bottleneck.
 */

import {
	Transport, BrickKey, makeBrickKey, brickKeyId, brickIdOf,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, SendCommandOptions,
	PresenceState, describeAddress, describeChannel, ForgetResidue,
} from '../contracts';
import { TransportError, ConnectionError, BackendUnavailableError } from '../errors/CockpitError';
import { TransportAdapter } from './transportAdapter';
import { BtConnectionQueue } from './btConnectionQueue';
import { BT } from './transportConstants';
import type { PairedPresence, UnpairedSighting } from './btPresence';
import { LifetimeScope, abortableDelay } from './lifetimeScope';

// ── BT backend types ────────────────────────────────────────────────

export type BtBackend = 'winsock' | 'spp' | 'bluez';

/** Factory that creates a transport adapter for a specific BT backend. */
export type BtAdapterFactory = (mac: string) => TransportAdapter;

/** Discovery result for a single BT device. */
export interface BtDiscoveryDevice {
	mac: string;
	name: string;
	connected: boolean;
	remembered: boolean;
	authenticated: boolean;
}

/** Function that discovers BT devices (e.g. via koffi bthprops worker). */
export type BtDiscoveryFunction = () => Promise<BtDiscoveryDevice[]>;

/** What background presence knows, as discovery reads it (`BtPresenceMonitor`). */
export interface BtPresenceSource {
	presenceOf(mac: string): PairedPresence | undefined;
	unpairedBricks(): readonly UnpairedSighting[];
}

// ── Session tracking ────────────────────────────────────────────────

interface BtSession {
	adapter: TransportAdapter;
	backend: BtBackend;
	messageCounter: number;
}

// ── LEGO OUI filter ─────────────────────────────────────────────────

const LEGO_OUI = BT.LEGO_OUI.toLowerCase();

function normaliseMac(mac: string): string {
	return mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function isLegoMac(mac: string): boolean {
	return mac.replace(/[:-]/g, '').toLowerCase().startsWith(LEGO_OUI);
}

/**
 * What Windows keeps of a brick after `BluetoothRemoveDevice`. Reported, never removed: the
 * key is owned by SYSTEM, and the cockpit does not work around that (step-3 plan, KD3, R6).
 */
function windowsResidue(mac: string): ForgetResidue[] {
	// Twelve hex digits, lower case, no separators: how this host's subkeys under
	// `Parameters\Devices` were spelled when listed 31.10.2026. The hardware session (U7)
	// confirms the casing against the key of a brick it forgets.
	const subkey = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
	return [
		{
			location: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\${subkey}`,
			// Measured: the key survives BluetoothRemoveDevice and Settings' own Remove
			// (IMPLEMENTATION_PLAN 1.11.14, DESIGN §7.3).
			reason: 'Windows keeps this key after unpairing; it is owned by SYSTEM and the cockpit does not change it.',
		},
		{
			location: `Windows' in-memory Bluetooth device record for ${describeAddress(mac)}`,
			reason: 'Windows keeps it until it next restarts; until then a scan may still list the brick, unpaired.',
		},
	];
}

/** What an unpair answers: Windows' synchronously, BlueZ's later (step-7 plan, KTD6). */
export interface UnpairResult {
	ok: boolean;
	reason?: string;
}

/** Configuration for {@link BtTransportProvider}. */
export interface BtTransportProviderOptions {
	/** BT adapter factories keyed by backend name, in priority order. */
	backends?: Map<BtBackend, BtAdapterFactory>;
	/** Discovery function (platform-specific). */
	discoverDevices?: BtDiscoveryFunction;
	/** Connection queue (shared across BT providers). */
	connectionQueue?: BtConnectionQueue;
	/**
	 * Removes the OS-level pairing.
	 *
	 * When present, `forget()` actually forgets, reports what Windows keeps, and
	 * `capabilities.supportsForget` is true. Without it forget only drops the backend
	 * preference, and the brick returns on the next scan as though nothing happened.
	 */
	unpairDevice?: (mac: string) => UnpairResult | Promise<UnpairResult>;
	/**
	 * What the OS keeps of a brick after the unpair, reported to the user (step-7 plan, KTD7).
	 * Default: what Windows keeps. Linux names BlueZ's name cache.
	 */
	forgetResidue?: (mac: string) => ForgetResidue[];
	/**
	 * How long a brick gets after its connection is closed before the next connect to it
	 * (default {@link BT.RECONNECT_GAP_AFTER_CLOSE_MS}). Per brick: other bricks are not held.
	 */
	reconnectGapAfterCloseMs?: number;
	/**
	 * Background presence: whether each paired brick answered its last checks, and the
	 * unpaired bricks recent inquiries heard. Without it discovery lists Windows' records only.
	 */
	presence?: BtPresenceSource;
}

/**
 * Bluetooth transport provider.
 *
 * Supports multiple backends with automatic fallback and per-brick
 * backend preference learning.
 */
export class BtTransportProvider implements TransportProvider {
	readonly transport = Transport.BT;
	/** Below a cable, above Wi-Fi. */
	readonly priority = 20;
	// supportsForget follows whether an unpair hook was supplied: without one, forget()
	// drops this provider's bookkeeping and leaves the OS pairing in place, and a brick
	// that comes straight back is worse than a button that was never offered.
	readonly capabilities: TransportCapabilities;

	private readonly backends: Map<BtBackend, BtAdapterFactory>;
	private readonly discoverDevices?: BtDiscoveryFunction;
	private readonly connectionQueue?: BtConnectionQueue;
	private readonly unpairDevice?: (mac: string) => UnpairResult | Promise<UnpairResult>;
	private readonly forgetResidue: (mac: string) => ForgetResidue[];
	private readonly sessions = new Map<BrickKey, BtSession>();
	private readonly preferredBackend = new Map<string, BtBackend>();
	/** When each brick's last connection was closed, by MAC. */
	private readonly closedAt = new Map<string, number>();
	private readonly reconnectGapAfterCloseMs: number;
	private readonly presence?: BtPresenceSource;
	/** Paired bricks the last discovery listed, by MAC as Windows spells it. */
	private lastPaired: string[] = [];
	/** Everything this provider starts runs here; a dispose aborts it and waits (audit round 4). */
	private readonly scope = new LifetimeScope('BtTransportProvider');
	/** Adapters made and still opening, which a dispose closes too. */
	private readonly opening = new Set<TransportAdapter>();
	/** Connects in flight, so a second connect to the same brick gets the same answer. */
	private readonly connecting = new Map<BrickKey, Promise<SessionHandle>>();
	private disposing?: Promise<void>;

	constructor(options?: BtTransportProviderOptions) {
		this.backends = options?.backends ?? new Map<BtBackend, BtAdapterFactory>();
		this.discoverDevices = options?.discoverDevices;
		this.connectionQueue = options?.connectionQueue;
		this.unpairDevice = options?.unpairDevice;
		this.forgetResidue = options?.forgetResidue ?? windowsResidue;
		this.reconnectGapAfterCloseMs = options?.reconnectGapAfterCloseMs ?? BT.RECONNECT_GAP_AFTER_CLOSE_MS;
		this.presence = options?.presence;
		this.capabilities = {
			supportsSignalInfo: false,
			supportsForget: Boolean(this.unpairDevice),
			supportsTelemetryFrames: true,
			rejoinOnEvidenceOnly: true,
		};
	}

	discover(): Promise<DiscoveryScanResult> {
		return this.scope.run((signal) => this.discoverInScope(signal));
	}

	private async discoverInScope(signal: AbortSignal): Promise<DiscoveryScanResult> {
		const items: DiscoveryItem[] = [];
		const now = Date.now();

		if (!this.discoverDevices) {
			return { transport: Transport.BT, items };
		}

		try {
			const devices = (await this.discoverDevices()).filter((dev) => isLegoMac(dev.mac));
			signal.throwIfAborted();
			this.lastPaired = devices.filter((dev) => dev.remembered).map((dev) => dev.mac);
			for (const dev of devices) {
				const brickKey = makeBrickKey(Transport.BT, dev.mac);
				// Every paired brick stays listed; whether it answered is a flag on it, not its
				// absence. Dropping an unheard brick would hide one the user may still want to
				// try (KD6), and Windows lists it again on the next scan anyway.
				const presence = dev.remembered ? this.presence?.presenceOf(dev.mac) : undefined;
				items.push({
					brickKey,
					// No name: the brick's id, as USB shows one and the brick's own display does.
					displayName: dev.name || brickIdOf(brickKey),
					// Windows' record catches up with a rename only at the next connection.
					nameSource: dev.name ? 'bt-cache' : 'fallback',
					transport: Transport.BT,
					presenceState: PresenceState.Available,
					remembered: dev.remembered,
					paired: dev.remembered,
					connected: this.sessions.has(brickKey),
					favorite: false,
					lastSeenAt: now,
					...(presence ? { heard: presence.heard } : {}),
					...(presence?.heardAt ? { heardAt: presence.heardAt } : {}),
				});
			}
			const listed = new Set(devices.map((dev) => normaliseMac(dev.mac)));
			for (const brick of this.presence?.unpairedBricks() ?? []) {
				if (!isLegoMac(brick.mac) || listed.has(normaliseMac(brick.mac))) { continue; }
				const sightingKey = makeBrickKey(Transport.BT, brick.mac);
				items.push({
					brickKey: sightingKey,
					displayName: brick.name || brickIdOf(sightingKey),
					// The name an inquiry hears is the brick's own, but nothing has confirmed it.
					nameSource: brick.name ? 'bt-cache' : 'fallback',
					transport: Transport.BT,
					presenceState: PresenceState.Available,
					remembered: false,
					paired: false,
					connected: false,
					favorite: false,
					...(brick.signal !== null ? { signalInfo: { rssi: brick.signal } } : {}),
					lastSeenAt: brick.seenAt,
				});
			}
		} catch (error) {
			// Reporting an empty scan here would be a lie the scheduler acts on: it
			// would count a miss against every tracked BT brick and walk them toward
			// Unavailable, while onScanFailed stayed silent. A failed scan is not an
			// empty one.
			throw new TransportError(
				`BT discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}

		return { transport: Transport.BT, items };
	}

	/** The paired bricks the last discovery listed that have no session: what presence checks. */
	pairedWithoutSession(): string[] {
		const inSession = new Set([...this.sessions.keys()].map((key) => normaliseMac(brickKeyId(key) ?? '')));
		return this.lastPaired.filter((mac) => !inSession.has(normaliseMac(mac)));
	}

	connect(brickKey: BrickKey): Promise<SessionHandle> {
		// A second connect to a brick already connecting waits for the same answer: two would each
		// open an adapter, and the second session would orphan the first (audit round 4, #7).
		const inFlight = this.connecting.get(brickKey);
		if (inFlight) { return inFlight; }
		const attempt = this.scope.run((signal) => this.connectInScope(brickKey, signal));
		this.connecting.set(brickKey, attempt);
		const forget = (): void => { if (this.connecting.get(brickKey) === attempt) { this.connecting.delete(brickKey); } };
		attempt.then(forget, forget);
		return attempt;
	}

	private async connectInScope(brickKey: BrickKey, signal: AbortSignal): Promise<SessionHandle> {
		if (this.sessions.has(brickKey)) {
			throw new ConnectionError(`${describeChannel(brickKey)} is already connected.`);
		}

		const mac = this.extractMac(brickKey);
		if (!mac) {
			throw new ConnectionError(`Cannot extract MAC address from brick key: ${brickKey}`);
		}

		// The queue serialises *opening*, not holding. Measured 29.10.2026 on this host's weakest
		// adapter: two sessions to two bricks held at once answered every request, so a session
		// that kept the slot for its whole life only stopped a second brick from connecting at
		// all (step-1 plan, U3.1; scripts/bt-radio-probe.js).
		// The brick needs a moment after a close before it accepts a new link: page scan comes
		// back only once its side of the old one is torn down. Measured 29.10.2026: a connect
		// 0-2 s after a clean close failed at once with WSA 10064, and it was always that
		// sequence that started the blocked-connect collapse the Winsock adapter now avoids.
		// Waited before taking the queue slot, so other bricks are not held up by it.
		const closedAt = this.closedAt.get(mac);
		if (closedAt !== undefined) {
			const wait = closedAt + this.reconnectGapAfterCloseMs - Date.now();
			if (wait > 0) { await abortableDelay(wait, signal); }
		}

		let queueRelease: ((error?: unknown) => void) | undefined;
		if (this.connectionQueue) {
			queueRelease = await this.connectionQueue.acquire(mac);
		}

		try {
			signal.throwIfAborted();
			const { adapter, backend } = await this.connectWithFallback(mac, signal);
			this.sessions.set(brickKey, { adapter, backend, messageCounter: 0 });
			this.preferredBackend.set(mac, backend);
			queueRelease?.();
			return { brickKey, transport: Transport.BT };
		} catch (error) {
			// Tell the queue it failed, so the next attempt waits out the longer recovery
			// rather than the ordinary gap between connections.
			queueRelease?.(error);
			throw error;
		}
	}

	async disconnect(brickKey: BrickKey): Promise<void> {
		const session = this.sessions.get(brickKey);
		if (!session) { return; }
		this.sessions.delete(brickKey);
		try {
			await session.adapter.close();
		} finally {
			const mac = this.extractMac(brickKey);
			if (mac) { this.closedAt.set(mac, Date.now()); }
		}
	}

	async sendPacket(
		brickKey: BrickKey,
		packet: Uint8Array,
		options?: SendCommandOptions & { expectedMessageCounter?: number },
	): Promise<Uint8Array> {
		this.assertNotDisposed();
		const session = this.sessions.get(brickKey);
		if (!session) {
			throw new TransportError(`${describeChannel(brickKey)} is not connected.`);
		}
		return session.adapter.send(packet, options);
	}

	async recover(brickKey: BrickKey): Promise<SessionHandle> {
		await this.disconnect(brickKey);
		return this.connect(brickKey);
	}

	/**
	 * Disconnects and removes the pairing, when this provider was given a way to, and drops
	 * everything this provider remembers about the brick (step-3 plan, KTD7).
	 *
	 * @returns What Windows keeps after the unpair: the brick's `BTHPORT` registry key and
	 *   Windows' in-memory device record. Empty when there was no unpair hook, because then
	 *   nothing reached Windows.
	 * @throws {TransportError} When the OS refused to remove the pairing. Reported rather
	 *   than swallowed: a forget that silently left the pairing in place is what made this
	 *   capability false in the first place.
	 */
	async forget(brickKey: BrickKey): Promise<readonly ForgetResidue[]> {
		await this.disconnect(brickKey);
		const mac = this.extractMac(brickKey);
		if (!mac) { return []; }

		this.preferredBackend.delete(mac);
		if (!this.unpairDevice) { return []; }

		const result = await this.unpairDevice(mac);
		if (!result.ok) {
			throw new TransportError(
				`Could not forget ${describeAddress(mac)}: ${result.reason ?? 'the operating system refused.'}`
			);
		}

		// After the disconnect above, which is what set the close time. Until the next scan the
		// paired list would still feed this brick to the presence checks.
		this.closedAt.delete(mac);
		const forgotten = normaliseMac(mac);
		this.lastPaired = this.lastPaired.filter((paired) => normaliseMac(paired) !== forgotten);

		return this.forgetResidue(mac);
	}

	dispose(): void {
		void this.disposeAsync();
	}

	/**
	 * Aborts every operation, closes every link, and resolves once all of it has settled.
	 *
	 * Abort first, so a connect waiting out the gap, the queue or an open stops at its next wait;
	 * the queue's dispose ends the waits for a slot; then the sessions and the adapters still
	 * opening are closed, and the operations — which close what they own — are waited for.
	 */
	disposeAsync(): Promise<void> {
		if (!this.disposing) { this.disposing = this.disposeAll(); }
		return this.disposing;
	}

	private async disposeAll(): Promise<void> {
		const operations = this.scope.dispose();
		this.connectionQueue?.dispose();
		const closes: Promise<void>[] = [];
		for (const [, session] of this.sessions) {
			closes.push(session.adapter.close().catch(() => { /* disposing */ }));
		}
		this.sessions.clear();
		for (const adapter of this.opening) {
			closes.push(adapter.close().catch(() => { /* disposing */ }));
		}
		this.opening.clear();
		await operations;
		// A connect may have adopted its link just before it saw the abort; close what is left.
		for (const [, session] of this.sessions) {
			closes.push(session.adapter.close().catch(() => { /* disposing */ }));
		}
		this.sessions.clear();
		await Promise.all(closes);
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Opens the first backend that can serve this host.
	 *
	 * Falling through is **only** for a backend that could not run at all — no radio, an
	 * FFI that will not load, the wrong platform. Those never touch the air, so the next
	 * one may go immediately.
	 *
	 * A backend that did touch the air and failed ends the attempt. Windows carries one
	 * RFCOMM channel and a failed connection leaves it settling for tens of seconds, so a
	 * second backend arriving straight afterwards is the impatient retry that was deleted
	 * from `BtSppAdapter`, wearing a different name. The caller waits out the queue's error
	 * cooldown and tries again, which is where that recovery belongs.
	 */
	private async connectWithFallback(mac: string, signal: AbortSignal): Promise<{ adapter: TransportAdapter; backend: BtBackend }> {
		if (this.backends.size === 0) {
			throw new ConnectionError('No BT backends configured.');
		}

		const ordered = this.getOrderedBackends(this.preferredBackend.get(mac));
		const unavailable: string[] = [];

		for (const [backend, factory] of ordered) {
			let adapter: TransportAdapter | undefined;
			try {
				adapter = factory(mac);
				// Tracked from the moment it exists, so a dispose reaches it mid-open (review of 6955f22).
				this.opening.add(adapter);
				await adapter.open({ signal });
				if (signal.aborted) {
					// Landed as the dispose came: give it back, adopt nothing.
					await adapter.close().catch(() => { /* disposing */ });
					throw signal.reason;
				}
				return { adapter, backend };
			} catch (error) {
				if (!(error instanceof BackendUnavailableError)) {
					throw error;
				}
				unavailable.push(`${backend}: ${error.message}`);
			} finally {
				if (adapter) { this.opening.delete(adapter); }
			}
		}

		throw new ConnectionError(
			`No BT backend can run on this host for ${describeAddress(mac)}: ${unavailable.join('; ')}`
		);
	}

	private getOrderedBackends(preferred?: BtBackend): Array<[BtBackend, BtAdapterFactory]> {
		const entries = [...this.backends.entries()];
		if (!preferred) {
			return entries;
		}

		// Move preferred to front
		const idx = entries.findIndex(([name]) => name === preferred);
		if (idx > 0) {
			const [entry] = entries.splice(idx, 1);
			entries.unshift(entry);
		}
		return entries;
	}

	private extractMac(brickKey: BrickKey): string | undefined {
		const mac = brickKeyId(brickKey);
		return mac && mac.replace(/[:-]/g, '').length >= 12 ? mac : undefined;
	}

	private assertNotDisposed(): void {
		if (this.scope.disposed) {
			throw new TransportError('BtTransportProvider has been disposed.');
		}
	}
}
