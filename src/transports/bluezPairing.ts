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
}

const AGENT = 'org.bluez.Agent1';
const AGENT_MANAGER = 'org.bluez.AgentManager1';
const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';

/** What BlueZ's pairing errors mean to someone at the brick. */
const REASONS: Record<string, string> = {
	'org.bluez.Error.AuthenticationRejected': 'The brick\'s dialog was not confirmed in time; it may still be showing on the brick.',
	'org.bluez.Error.AuthenticationCanceled': 'The pairing was cancelled on the brick.',
	'org.bluez.Error.AuthenticationFailed': 'The brick refused the PIN.',
	'org.bluez.Error.AuthenticationTimeout': 'The brick did not answer in time.',
	'org.bluez.Error.ConnectionAttemptFailed': 'The brick did not answer: check that it is on and its Bluetooth is on.',
	'org.bluez.Error.InProgress': 'Another pairing with this brick is already in progress.',
};

type PairingFunction = (mac: string, onEvent?: (event: BtPairingEvent) => void, signal?: AbortSignal) => Promise<HelperPairingResult>;

export function createBluezPairing(options: BluezPairingOptions): PairingFunction {
	const agentPath = options.agentPath ?? '/ev3cockpit/agent';
	const searchMs = options.searchMs ?? 40_000;
	const pairTimeoutMs = options.pairTimeoutMs ?? 90_000;
	const { bus, cache } = options;

	return async (mac, onEvent, signal) => {
		const cancelled: HelperPairingResult = { ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' };
		if (signal?.aborted) { return cancelled; }
		if (!macToBdaddr(mac) || !/^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$/.test(mac)) {
			return { ok: false, reason: `Not a Bluetooth address: ${mac}.`, status: 'InvalidAddress' };
		}
		const adapter = cache.adapter();
		if (!adapter) { return { ok: false, reason: 'This computer has no Bluetooth adapter BlueZ knows.', status: 'NoAdapter' }; }
		const devicePath = `${adapter.path}/dev_${mac.replace(/[:-]/g, '_').toUpperCase()}`;
		const known = (): BluezDevice | undefined => cache.devices().find((d) => d.path === devicePath);
		const emit = (event: BtPairingEvent): void => { try { onEvent?.(event); } catch { /* the listener's fault */ } };

		if (known()?.paired) {
			emit({ type: 'alreadyPaired', mac });
			return { ok: true, status: 'AlreadyPaired' };
		}

		// A brick BlueZ does not hold yet has to be heard first, as the Windows helper searches.
		if (!known()) {
			emit({ type: 'searching', mac });
			const found = await search(devicePath);
			if (signal?.aborted) { return cancelled; }
			if (!found) {
				return { ok: false, reason: 'The brick was not found: check that its Bluetooth is on and it is visible.', status: 'NotFound' };
			}
			emit({ type: 'found', id: mac, name: found.name ?? '', alreadyPaired: found.paired });
			if (found.paired) { return { ok: true, status: 'AlreadyPaired' }; }
		}

		// Our agent, for this pairing only; it answers for this brick and refuses any other.
		const forThisBrick = (device: DBusValue): void => {
			if (device !== devicePath) { throw new DBusError('org.bluez.Error.Rejected', 'Not the brick being paired.'); }
		};
		const withdraw = bus.exportObject(agentPath, AGENT, {
			RequestPinCode: { returns: 's', handler: ([device]) => { forThisBrick(device); emit({ type: 'pairingRequested', kind: 'ProvidePin' }); return [EV3_PAIRING_PIN]; } },
			RequestPasskey: { returns: 'u', handler: ([device]) => { forThisBrick(device); return [Number(EV3_PAIRING_PIN)]; } },
			RequestConfirmation: { returns: '', handler: ([device]) => { forThisBrick(device); emit({ type: 'pairingRequested', kind: 'ConfirmOnly' }); return []; } },
			RequestAuthorization: { returns: '', handler: ([device]) => { forThisBrick(device); return []; } },
			AuthorizeService: { returns: '', handler: ([device]) => { forThisBrick(device); return []; } },
			DisplayPinCode: { returns: '', handler: () => [] },
			DisplayPasskey: { returns: '', handler: () => [] },
			Cancel: { returns: '', handler: () => [] },
			Release: { returns: '', handler: () => [] },
		});
		let registered = false;
		const onAbort = (): void => {
			void bus.call({ destination: BLUEZ, path: devicePath, interface: DEVICE, member: 'CancelPairing' }).catch(() => { /* nothing to cancel */ });
		};
		try {
			await bus.call({ destination: BLUEZ, path: '/org/bluez', interface: AGENT_MANAGER, member: 'RegisterAgent', signature: 'os', body: [agentPath, 'KeyboardDisplay'] });
			registered = true;
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) { return cancelled; }
			await bus.call({ destination: BLUEZ, path: devicePath, interface: DEVICE, member: 'Pair', timeoutMs: pairTimeoutMs });
			emit({ type: 'result', status: 'Paired', ok: true });
			return { ok: true, status: 'Paired' };
		} catch (error) {
			if (signal?.aborted) { return cancelled; }
			if (error instanceof DBusError) {
				if (error.dbusName === 'org.bluez.Error.AlreadyExists') { return { ok: true, status: 'AlreadyPaired' }; }
				const status = error.dbusName.replace(/^.*\./, '');
				emit({ type: 'result', status, ok: false });
				return { ok: false, reason: REASONS[error.dbusName] ?? `BlueZ: ${error.detail || error.dbusName}`, status };
			}
			return { ok: false, reason: error instanceof Error ? error.message : String(error), status: 'Failed' };
		} finally {
			signal?.removeEventListener('abort', onAbort);
			if (registered) {
				await bus.call({ destination: BLUEZ, path: '/org/bluez', interface: AGENT_MANAGER, member: 'UnregisterAgent', signature: 'o', body: [agentPath] })
					.catch(() => { /* gone with the bus */ });
			}
			withdraw();
		}

		/** A BR/EDR discovery until BlueZ holds the brick, the search time runs out, or an abort. */
		async function search(path: string): Promise<BluezDevice | undefined> {
			let stopListening = (): void => { /* set below */ };
			const heard = new Promise<BluezDevice | undefined>((resolve) => {
				const done = (value: BluezDevice | undefined): void => { stopListening(); clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(value); };
				const aborted = (): void => done(undefined);
				// Not unref'd: a search must end even where nothing else keeps the process alive.
				const timer = setTimeout(() => done(undefined), searchMs);
				signal?.addEventListener('abort', aborted, { once: true });
				stopListening = cache.onChange(() => { const d = cache.devices().find((x) => x.path === path); if (d) { done(d); } });
			});
			try {
				await bus.call({ destination: BLUEZ, path: adapter!.path, interface: ADAPTER, member: 'SetDiscoveryFilter', signature: 'a{sv}', body: [new Map([['Transport', new Variant('s', 'bredr')]])] });
				await bus.call({ destination: BLUEZ, path: adapter!.path, interface: ADAPTER, member: 'StartDiscovery' });
				return await heard;
			} finally {
				stopListening();
				await bus.call({ destination: BLUEZ, path: adapter!.path, interface: ADAPTER, member: 'StopDiscovery' }).catch(() => { /* not discovering */ });
			}
		}
	};
}
