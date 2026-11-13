/**
 * Pairing a brick through BlueZ, with an agent the cockpit owns (step-7 plan, U5, KTD5).
 *
 * Measured on HOSTC (U0, 13.11.2026): an agent registered by the calling connection — without
 * `RequestDefaultAgent` — is the one BlueZ asks, even with the desktop panel's own agent running,
 * so the desktop's agent is never displaced. The brick shows a connection request, then a PIN
 * keyboard; BlueZ asks our agent `RequestPinCode` and gets 1234; an unanswered brick dialog ends
 * after 60 s with `AuthenticationRejected` and stays open on the brick.
 *
 * The returned function has the shape of `BtClassicDiscovery`'s `pairDevice`, so it drops into the
 * same seam the Windows helper fills, and its events are `BtPairingEvent`s the log already reads.
 */

import { DBusError, type CallOptions, type ExportedMethod } from './dbus/connection';
import { Variant, type DBusValue } from './dbus/wire';
import type { BluezAdapter, BluezDevice } from './bluezObjects';
import { BLUEZ } from './bluezObjects';
import { macToBdaddr } from './linuxBluetoothSocket';
import { PAIRING_CANCELLED, type BtPairingEvent, type HelperPairingResult } from './btPairingHelper';
import { EV3_PAIRING_PIN } from './windowsBluetooth';

/** What pairing needs of the bus. */
export interface PairingBus {
	call(options: CallOptions): Promise<DBusValue[]>;
	exportObject(path: string, iface: string, methods: Record<string, ExportedMethod>): () => void;
}

/** What pairing needs of the object cache. */
export interface PairingCache {
	devices(): BluezDevice[];
	adapter(): BluezAdapter | undefined;
	onChange(handler: () => void): () => void;
}

export interface BluezPairingOptions {
	bus: PairingBus;
	cache: PairingCache;
	/** Where the agent is exported (default `/ev3cockpit/agent`). */
	agentPath?: string;
	/** How long a search for a brick BlueZ does not know may take (default 40 s, as the Windows helper). */
	searchMs?: number;
	/** How long Pair may take; BlueZ itself gives up on the brick's dialog after 60 s (default 90 s). */
	pairTimeoutMs?: number;
	/** BlueZ's unique bus name; with this option the agent answers no other caller, and nobody while it is unknown. */
	bluezOwner?: () => string | undefined;
}

const AGENT = 'org.bluez.Agent1';
const AGENT_MANAGER = 'org.bluez.AgentManager1';
const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';

/** What BlueZ's pairing errors mean to someone at the brick. */
const REASONS: Record<string, string> = {
	'org.bluez.Error.AuthenticationRejected': 'The brick rejected the pairing, often because its dialog was not confirmed in time; it may still be showing on the brick.',
	'org.bluez.Error.AuthenticationCanceled': 'The pairing was cancelled on the brick.',
	'org.bluez.Error.AuthenticationFailed': 'The brick refused the PIN.',
	'org.bluez.Error.AuthenticationTimeout': 'The brick did not answer in time.',
	'org.bluez.Error.ConnectionAttemptFailed': 'The brick did not answer: check that it is on and its Bluetooth is on.',
	'org.bluez.Error.InProgress': 'Another pairing with this brick is already in progress.',
	'org.bluez.Error.NotReady': 'Bluetooth on this computer is off: turn it on and try again.',
	'org.bluez.Error.AlreadyExists': 'Another pairing agent of the cockpit is still registered with BlueZ.',
};

type PairingFunction = (mac: string, onEvent?: (event: BtPairingEvent) => void, signal?: AbortSignal) => Promise<HelperPairingResult>;

/** The bus call outlives the local deadline, so a slow brick is a Timeout, not a bus error. */
const PAIR_BUS_MARGIN_MS = 5_000;

/** Pair ran longer than this side waits. */
class PairTimeout extends Error {}

export function createBluezPairing(options: BluezPairingOptions): PairingFunction {
	const agentPath = options.agentPath ?? '/ev3cockpit/agent';
	const searchMs = options.searchMs ?? 40_000;
	const pairTimeoutMs = options.pairTimeoutMs ?? 90_000;
	const { bus, cache } = options;
	const cancelled = (): HelperPairingResult => ({ ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });

	// BlueZ takes one agent per connection, and there is one agent path: one pairing at a time.
	let tail: Promise<void> = Promise.resolve();

	return async (mac, onEvent, signal) => {
		const previous = tail;
		let release = (): void => { /* set below */ };
		tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
		// The turn is ours once `previous` settles and `release` is set; an abort stops the wait.
		const ourTurn = previous.then(() => true);
		try {
			if (!(await untilAborted(ourTurn, signal))) { return cancelled(); }
			return await pairOne(mac, onEvent, signal);
		} finally {
			// A caller that gave up waiting still lets those behind it through, after `previous`.
			void ourTurn.then(() => release());
		}
	};

	async function pairOne(mac: string, onEvent: ((event: BtPairingEvent) => void) | undefined, signal: AbortSignal | undefined): Promise<HelperPairingResult> {
		if (signal?.aborted) { return cancelled(); }
		const bdaddr = macToBdaddr(mac);
		if (!bdaddr) { return { ok: false, reason: `Not a Bluetooth address: ${mac}.`, status: 'InvalidAddress' }; }
		const adapter = cache.adapter();
		if (!adapter) { return { ok: false, reason: 'This computer has no Bluetooth adapter BlueZ knows.', status: 'NoAdapter' }; }
		// From the parsed bytes, whatever separators the address came with.
		const hex = Array.from(bdaddr).reverse().map((b) => b.toString(16).padStart(2, '0').toUpperCase());
		const devicePath = `${adapter.path}/dev_${hex.join('_')}`;
		const known = (): BluezDevice | undefined => cache.devices().find((d) => d.path === devicePath);
		const emit = (event: BtPairingEvent): void => { try { onEvent?.(event); } catch { /* the listener's fault */ } };
		const failed = (status: string, reason: string): HelperPairingResult => {
			emit({ type: 'result', status, ok: false });
			return { ok: false, reason, status };
		};

		const held = known();
		if (held?.paired) {
			emit({ type: 'alreadyPaired', mac });
			return { ok: true, status: 'AlreadyPaired' };
		}

		let phase: 'search' | 'agent' | 'pair' = 'search';
		let registered = false;
		let withdraw: (() => void) | undefined;
		const cancelAtBluez = (): void => {
			void bus.call({ destination: BLUEZ, path: devicePath, interface: DEVICE, member: 'CancelPairing' }).catch(() => { /* nothing to cancel */ });
		};
		try {
			let target = held;
			// A brick BlueZ does not hold yet has to be heard first, as the Windows helper searches.
			if (!target) {
				emit({ type: 'searching', mac });
				if (signal?.aborted) { return cancelled(); }
				target = await search(adapter.path, devicePath, signal);
				if (signal?.aborted) { return cancelled(); }
				if (!target) {
					return failed('NotFound', 'The brick was not found: check that its Bluetooth is on and it is visible.');
				}
				if (target.paired) {
					emit({ type: 'found', id: mac, name: target.name ?? '', alreadyPaired: true });
					return { ok: true, status: 'AlreadyPaired' };
				}
			}
			// Whoever shows progress tells the user to watch the brick on this event, held or heard.
			emit({ type: 'found', id: mac, name: target.name ?? '', alreadyPaired: false });

			// Our agent, for this pairing only; it answers BlueZ about this brick and refuses the rest.
			const forThisBrick = (device: DBusValue, message: { sender?: string } | undefined): void => {
				// Once BlueZ's owner is tracked, fail closed: while it is unknown, nobody is BlueZ.
				if (options.bluezOwner) {
					const owner = options.bluezOwner();
					if (owner === undefined || message?.sender !== owner) { throw new DBusError('org.bluez.Error.Rejected', 'Not BlueZ.'); }
				}
				if (device !== devicePath) { throw new DBusError('org.bluez.Error.Rejected', 'Not the brick being paired.'); }
			};
			phase = 'agent';
			withdraw = bus.exportObject(agentPath, AGENT, {
				RequestPinCode: { returns: 's', handler: ([device], m) => { forThisBrick(device, m); emit({ type: 'pairingRequested', kind: 'ProvidePin' }); return [EV3_PAIRING_PIN]; } },
				RequestPasskey: { returns: 'u', handler: ([device], m) => { forThisBrick(device, m); return [Number(EV3_PAIRING_PIN)]; } },
				RequestConfirmation: { returns: '', handler: ([device], m) => { forThisBrick(device, m); emit({ type: 'pairingRequested', kind: 'ConfirmOnly' }); return []; } },
				RequestAuthorization: { returns: '', handler: ([device], m) => { forThisBrick(device, m); return []; } },
				AuthorizeService: { returns: '', handler: ([device], m) => { forThisBrick(device, m); return []; } },
				DisplayPinCode: { returns: '', handler: () => [] },
				DisplayPasskey: { returns: '', handler: () => [] },
				Cancel: { returns: '', handler: () => [] },
				Release: { returns: '', handler: () => [] },
			});
			await bus.call({ destination: BLUEZ, path: '/org/bluez', interface: AGENT_MANAGER, member: 'RegisterAgent', signature: 'os', body: [agentPath, 'KeyboardDisplay'] });
			registered = true;
			if (signal?.aborted) { return cancelled(); }

			phase = 'pair';
			await pairBounded(devicePath, cancelAtBluez, signal);
			emit({ type: 'result', status: 'Paired', ok: true });
			return { ok: true, status: 'Paired' };
		} catch (error) {
			// Whatever ended the wait here, BlueZ may still be pairing: tell it to stop.
			if (phase === 'pair' && !(error instanceof DBusError)) { cancelAtBluez(); }
			if (signal?.aborted) { return cancelled(); }
			if (error instanceof PairTimeout) { return failed('Timeout', 'The pairing took too long and was cancelled.'); }
			if (error instanceof DBusError) {
				if (phase === 'pair' && error.dbusName === 'org.bluez.Error.AlreadyExists') { return { ok: true, status: 'AlreadyPaired' }; }
				return failed(error.dbusName.replace(/^.*\./, ''), REASONS[error.dbusName] ?? `BlueZ: ${error.detail || error.dbusName}`);
			}
			return failed('Failed', error instanceof Error ? error.message : String(error));
		} finally {
			if (registered) {
				await bus.call({ destination: BLUEZ, path: '/org/bluez', interface: AGENT_MANAGER, member: 'UnregisterAgent', signature: 'o', body: [agentPath] })
					.catch(() => { /* gone with the bus */ });
			}
			withdraw?.();
		}
	}

	/**
	 * Pair, bounded here by `pairTimeoutMs` whatever the bus does, and by an abort: either sends
	 * CancelPairing. A Pair that resolves is a paired brick, whatever came after (the honest answer).
	 * One race cannot be closed: an abort that lands after BlueZ has bonded the brick but before its
	 * reply arrives answers Cancelled for a brick that is in fact paired; the cache shows it paired.
	 */
	async function pairBounded(devicePath: string, cancelAtBluez: () => void, signal: AbortSignal | undefined): Promise<void> {
		const pair = bus.call({ destination: BLUEZ, path: devicePath, interface: DEVICE, member: 'Pair', timeoutMs: pairTimeoutMs + PAIR_BUS_MARGIN_MS });
		let cleanup = (): void => { /* set below */ };
		const stop = new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new PairTimeout()), pairTimeoutMs);
			const onAbort = (): void => { cancelAtBluez(); reject(new Error('aborted')); };
			signal?.addEventListener('abort', onAbort, { once: true });
			cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
			if (signal?.aborted) { onAbort(); }
		});
		stop.catch(() => { /* raced below */ });
		pair.catch(() => { /* raced below */ });
		try {
			await Promise.race([pair, stop]);
		} finally {
			cleanup();
		}
	}

	/** A BR/EDR discovery until BlueZ holds the brick, the search time runs out, or an abort. */
	async function search(adapterPath: string, devicePath: string, signal: AbortSignal | undefined): Promise<BluezDevice | undefined> {
		let finish = (_value: BluezDevice | undefined): void => { /* set below */ };
		let cleanup = (): void => { /* set below */ };
		const heard = new Promise<BluezDevice | undefined>((resolve) => {
			// Not unref'd: a search must end even where nothing else keeps the process alive.
			const timer = setTimeout(() => finish(undefined), searchMs);
			const aborted = (): void => finish(undefined);
			signal?.addEventListener('abort', aborted, { once: true });
			const stopListening = cache.onChange(() => { const d = cache.devices().find((x) => x.path === devicePath); if (d) { finish(d); } });
			let clean = false;
			cleanup = () => {
				if (clean) { return; }
				clean = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', aborted);
				stopListening();
			};
			finish = (value) => { cleanup(); resolve(value); };
			if (signal?.aborted) { finish(undefined); }
		});
		// Each setup call races `heard`, which an abort or the search time ends: neither waits for BlueZ.
		const endedFirst = (call: Promise<unknown>): Promise<boolean> => Promise.race([call.then(() => false), heard.then(() => true)]);
		let start: Promise<unknown> | undefined;
		let startSettled = false;
		try {
			const filter = bus.call({ destination: BLUEZ, path: adapterPath, interface: ADAPTER, member: 'SetDiscoveryFilter', signature: 'a{sv}', body: [new Map([['Transport', new Variant('s', 'bredr')]])] });
			filter.catch(() => { /* raced */ });
			if (await endedFirst(filter)) { return await heard; }
			start = bus.call({ destination: BLUEZ, path: adapterPath, interface: ADAPTER, member: 'StartDiscovery' });
			start.then(() => { startSettled = true; }, () => { startSettled = true; });
			await endedFirst(start);
			return await heard;
		} finally {
			cleanup();
			const stopDiscovery = (): Promise<unknown> => bus.call({ destination: BLUEZ, path: adapterPath, interface: ADAPTER, member: 'StopDiscovery' }).catch(() => { /* not discovering */ });
			if (start && startSettled) {
				await start.then(stopDiscovery, () => { /* never started */ });
			} else if (start) {
				// A discovery that starts after we gave up is stopped when it does, without holding the caller.
				void start.then(stopDiscovery, () => { /* never started */ });
			}
		}
	}
}

/** Resolves true when `turn` does, false on an abort first. */
async function untilAborted(turn: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) { return turn; }
	if (signal.aborted) { return false; }
	let onAbort = (): void => { /* set below */ };
	const aborted = new Promise<boolean>((resolve) => { onAbort = () => resolve(false); signal.addEventListener('abort', onAbort, { once: true }); });
	try {
		return await Promise.race([turn, aborted]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}
