/**
 * Builds the cockpit's runtime: transports, discovery, sessions, the brick layer and telemetry, wired.
 *
 * One function that the extension and the hardware harness both call, so a measurement on
 * the bench runs the shipped wiring rather than a hand-made copy of it (step-2 plan, KTD9). A
 * probe that rebuilt the wiring by hand has diverged from the shipped code five times before.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { BrickId, BrickKey, TransportProvider } from '../contracts';
import { DisposableStore } from '../events';
import {
	ProviderRegistry,
	UsbTransportProvider, TcpTransportProvider, BtTransportProvider, BtSppBackend,
	BtConnectionQueue, BtWinsockAdapter, BtClassicDiscovery,
} from '../transports';
import type { BtBackend, BtAdapterFactory } from '../transports';
import { createHelperPairing, createHelperPresenceCheck, scanForBricks } from '../transports/btPairingHelper';
import { BtPresenceMonitor } from '../transports/btPresence';
import { BT } from '../transports/transportConstants';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from '../mock';
import { TelemetryReadModel } from '../telemetry/telemetryReadModel';
import { TelemetryService } from '../telemetry/telemetryService';
import type { ProgramPresetSettings, TelemetrySettings, ThrottleSettings } from '../telemetry/telemetrySettings';
import { BrickManager } from './brickManager';
import { brickLabel, channelLabel, transportLabel } from './brickLabels';
import { DiscoveryScheduler } from './discoveryScheduler';
import { logOnChange } from './logOnChange';
import { PresenceAggregator } from './presenceAggregator';
import { SessionManager } from './sessionManager';

/** Where the runtime reports what it does. The extension's log channel fits it. */
export interface RuntimeLog {
	info(message: string, ...args: unknown[]): void;
	warn(message: string): void;
	error(message: string, error?: Error): void;
	debug(message: string, ...args: unknown[]): void;
}

export interface RuntimeOptions {
	/** The extension's install folder, where `native/bin` holds the Bluetooth helper. */
	readonly extensionPath: string;
	readonly log: RuntimeLog;
	/**
	 * Start the background Bluetooth presence jobs (inquiry and paired-brick checks).
	 *
	 * False in the extension's test host, whose suite must not page real bricks.
	 */
	readonly startPresence: boolean;
	/**
	 * Register the simulated bricks beside the real transports. For development only: a user
	 * has no use for six robots that are not there, and they fill the log.
	 */
	readonly mockBricks?: boolean;
	/**
	 * Register these providers instead of the real ones, for tests. The Bluetooth pairing and
	 * presence pieces are then not built.
	 */
	readonly providers?: readonly TransportProvider[];
	/**
	 * When a telemetry value counts as stale and when it goes (owner decision D9). The extension
	 * reads them from the user's settings; code outside VS Code takes the defaults `package.json`
	 * declares (`telemetrySettingsFromPackage`). The runtime has no values of its own.
	 */
	readonly telemetrySettings: TelemetrySettings;
	/** How each brick's telemetry slows down when its round trips grow (U7); read as the stale settings are. */
	readonly throttleSettings: ThrottleSettings;
	/** How a running program slows its brick's telemetry (U9, D11): the user's settings, as above. */
	readonly programPreset: ProgramPresetSettings;
}

/** The pieces a caller works with. Disposing it releases all of them. */
export interface Runtime extends vscode.Disposable {
	readonly registry: ProviderRegistry;
	readonly sessionManager: SessionManager;
	readonly scheduler: DiscoveryScheduler;
	readonly aggregator: PresenceAggregator;
	readonly bricks: BrickManager;
	/**
	 * Pairs bricks over Bluetooth, and reads this computer's Bluetooth name (`radioName`) for
	 * finding this computer's entry on a brick. Absent when providers were injected, and then
	 * that name is unknown.
	 */
	readonly btDiscovery?: BtClassicDiscovery;
	/** Background Bluetooth presence. Absent when providers were injected. */
	readonly btPresence?: BtPresenceMonitor;
	/** One telemetry loop per brick someone wants read: the active one, and any a consumer claimed. */
	readonly telemetry: TelemetryService;
	/** What the loops read: per brick, each row's last value and whether it is fresh. */
	readonly telemetryView: TelemetryReadModel;
}

export function createRuntime(options: RuntimeOptions): Runtime {
	const { log } = options;
	const services = new DisposableStore();
	const registry = services.add(new ProviderRegistry());

	let btDiscovery: BtClassicDiscovery | undefined;
	let btPresence: BtPresenceMonitor | undefined;
	let refreshDiscovery = (): void => { /* set once the scheduler exists */ };

	if (options.providers) {
		for (const provider of options.providers) { registry.register(provider); }
	} else {
		({ btDiscovery, btPresence } = registerRealProviders(services, registry, options, () => refreshDiscovery()));
	}

	// ── Discovery ───────────────────────────────────────────────
	// Built before the sessions so every log line can name the brick it is about.
	const scheduler = services.add(new DiscoveryScheduler(registry));
	const aggregator = services.add(new PresenceAggregator(scheduler, registry));
	services.add(aggregator.onListChanged(e => {
		log.debug(`Discovery list updated (${e.items.length} brick(s)):`,
			e.items.map(i => `${i.name.value} [${i.channels.map(c => `${c.transport}:${c.state}`).join(' ')}]`));
	}));
	// The change the picker shows as "BT not heard", so a wait seen there can be found here (KTD9).
	services.add(aggregator.onHeardChange(e => {
		log.info(`Presence check: ${channelLabel(aggregator, e.brickKey)} ${e.heard ? 'heard again' : 'not heard'}`);
	}));
	services.add(aggregator.onPresenceChanged(e => {
		// The brick's name, not this channel's: a channel that has none yet would otherwise
		// print a different name for the same brick.
		log.info(`Presence: ${channelLabel(aggregator, e.item.brickKey)} ${e.previousState ?? 'new'} → ${e.currentState}`);
	}));

	// ── Sessions ────────────────────────────────────────────────
	const sessionManager = services.add(new SessionManager({ providerRegistry: registry }));
	services.add(sessionManager.onSessionStateChange(e => {
		log.info(`Session: ${channelLabel(aggregator, e.brickKey)} ${e.previousState} → ${e.newState}`);
	}));
	services.add(scheduler.onScanFailed(e => {
		log.error(`Discovery scan failed on ${e.transport}`,
			e.error instanceof Error ? e.error : new Error(String(e.error)));
	}));

	// Bricks rather than channels: signs a brick in over every channel it is available on and
	// sends each command over the best connected one. It also keeps the list's channel states
	// in step with the sessions, and hands a reconnecting session the sighting it waits for.
	// Forgetting a brick also reaches discovery, Bluetooth presence and this computer's
	// Bluetooth name (step-3 plan, KTD1); with injected providers the last two are absent, and
	// a forget then has no presence to clear and leaves the brick's own list alone.
	const bricks = services.add(new BrickManager({
		sessionManager, aggregator, providerRegistry: registry, log,
		discovery: scheduler, btPresence, radioName: btDiscovery?.radioName, pair: btDiscovery?.pair,
		windowsPairing: scheduler,
	}));
	services.add(bricks.onRouteChange(e => {
		const over = (key?: BrickKey): string => (key ? transportLabel(key) : 'none');
		log.info(`Route: ${brickLabel(aggregator, e.brickId)} ${over(e.previous)} → ${over(e.current)}`);
	}));
	services.add(bricks.onActiveBrickChange(e => {
		const label = (id?: BrickId): string => (id ? brickLabel(aggregator, id) : 'none');
		log.info(`Active brick: ${label(e.previous)} → ${label(e.current)}`);
	}));

	// ── Telemetry ───────────────────────────────────────────────
	// After the brick layer, so disposing the runtime (in reverse) stops the loops before the
	// sessions they send over. The host gates on the pair (2.8.10a): a brick is read only while it is
	// signed in and has a route.
	const telemetry = services.add(new TelemetryService({
		host: bricks.telemetryHost(), providerRegistry: registry, throttle: options.throttleSettings, programPreset: options.programPreset,
	}));
	const telemetryView = services.add(new TelemetryReadModel({ source: telemetry, settings: options.telemetrySettings }));
	services.add(telemetry.onPlanChange((e) => {
		const brick = brickLabel(aggregator, e.brickKey as BrickId);
		if (e.intervals.size === 0) { log.info(`Telemetry: ${brick} no longer read`); return; }
		const ticks = [...e.intervals.values()].filter((ms): ms is number => typeof ms === 'number');
		log.info(`Telemetry: ${brick} ${telemetry.modeOf(e.brickKey)}, ${e.intervals.size} row(s) read, `
			+ `fastest every ${ticks.length ? Math.min(...ticks) : 'once'} ms`);
	}));
	// Said when the tick moves, which is a window's decision, not a frame's.
	services.add(telemetry.onThrottleChange((e) => {
		const { state } = e;
		log.info(`Telemetry: ${brickLabel(aggregator, e.brickKey as BrickId)} tick ${Math.round(state.periodMs)} ms `
			+ `(${state.factor === 1 ? 'as planned' : `${Number(state.factor.toFixed(2))}x the plan`}; `
			+ `p95 ${state.p95Ms ?? '-'} ms against ${state.limitMs} ms, ${state.stalls} stall(s))`);
	}));
	// A failing frame repeats every tick: said once per brick, and once more when frames come back.
	const failing = new Set<string>();
	services.add(telemetry.onError((e) => {
		if (failing.has(e.brickKey)) { return; }
		failing.add(e.brickKey);
		log.warn(`Telemetry: frames for ${brickLabel(aggregator, e.brickKey as BrickId)} are failing: `
			+ `${e.error instanceof Error ? e.error.message : String(e.error)}`);
	}));
	services.add(telemetry.onValues((e) => {
		if (failing.delete(e.brickKey)) { log.info(`Telemetry: frames for ${brickLabel(aggregator, e.brickKey as BrickId)} work again`); }
	}));

	scheduler.start();
	log.info('Discovery scheduler started');
	refreshDiscovery = () => { void scheduler.scanOnce().catch(() => { /* reported by onScanFailed */ }); };
	if (btPresence && options.startPresence) {
		if (process.platform === 'win32') {
			btPresence.start();
			log.info('Bluetooth presence started (inquiry and paired-brick checks, every minute)');
		} else {
			// Both jobs run the Windows Bluetooth helper; started here they would only report that (HOSTC, 11.11.2026).
			log.info(`Bluetooth presence not started: it needs the Windows Bluetooth helper; this host is ${process.platform}`);
		}
	}
	void scheduler.scanOnce().then(() => {
		log.info('Initial discovery scan complete');
	}).catch((err: unknown) => {
		log.error('Initial discovery scan failed', err instanceof Error ? err : new Error(String(err)));
	});

	return {
		registry, sessionManager, scheduler, aggregator, bricks, btDiscovery, btPresence, telemetry, telemetryView,
		dispose: () => services.dispose(),
	};
}

/** The USB, TCP and Bluetooth providers, with Bluetooth pairing and presence; the mock if asked. */
function registerRealProviders(
	services: DisposableStore,
	registry: ProviderRegistry,
	options: RuntimeOptions,
	refreshDiscovery: () => void,
): { btDiscovery: BtClassicDiscovery; btPresence: BtPresenceMonitor } {
	const { log } = options;

	// Mock transport: simulated bricks, for development only.
	if (options.mockBricks) {
		registry.register(services.add(new MockTransportProvider(DEFAULT_MOCK_CONFIG)));
		log.info(`Mock transport registered (${DEFAULT_MOCK_CONFIG.bricks.length} brick(s))`);
	}

	// USB transport: discovery over node-hid, connections over libusb where it can claim
	// the interface. The provider logs which backend each connection landed on, because a
	// HID fallback is a degraded link rather than an equivalent one.
	registry.register(services.add(new UsbTransportProvider({ log })));
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const hid = require('node-hid') as { devices(v: number, p: number): unknown[] };
		const found = hid.devices(0x0694, 0x0005).length;
		log.info(`USB transport registered — node-hid OK, ${found} EV3 device(s) visible`);
	} catch (e) {
		log.warn(`USB transport registered — node-hid unavailable in extension host: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require('usb');
		log.info('USB transport — libusb available, full 1024-byte frames');
	} catch (e) {
		// Worth saying at activation rather than at the first failed copy: without libusb
		// every USB link runs at 64 bytes a packet, where copy and move do not fit.
		log.warn(
			'USB transport — libusb unavailable, USB links will fall back to 64-byte HID '
			+ `packets: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	// TCP transport (UDP beacon discovery on port 3015, connects on port 5555)
	registry.register(services.add(new TcpTransportProvider()));
	log.info('TCP transport registered');

	// BT transport. Discovery reads the Windows Bluetooth device cache, which is what the
	// testlab used and answers the question discovery actually asks: which bricks does this
	// machine know about, and what does each call itself. The COM-port scan runs behind it,
	// both as a fallback and because the SPP backend builds its adapters from what it saw.
	//
	// Those two used to be the same list, back when the runtime went through a serial port.
	// They are not any more: a paired brick whose outgoing port Windows never created is
	// invisible to a port scan and perfectly reachable over a socket.
	//
	// Pairing goes through the net48 WinRT helper (`native/bin/bt-pairing-helper.exe`,
	// published by `npm run build:helper`). The legacy `bthprops.cpl` path it replaces cannot
	// work from any host: Windows' own Bluetooth service owns the single authentication
	// callback slot, so this side of the PIN exchange never gets asked. See plan 2.8.18.
	//
	// The connection queue serialises the *opening* of Bluetooth connections and pairing
	// attempts; an open session does not hold it. Measured 29.10.2026 on this host's weak
	// Realtek adapter: two sessions to two bricks held at once, and a live inquiry beside
	// them, cost nothing (scripts/bt-radio-probe.js). The old testlab's "one RFCOMM
	// connection at a time" did not hold. The queue's cooldowns (15 s after a clean close,
	// 30 s and growing after a failure) stay for the release as slow and safe (step-1 plan,
	// D3); the ~50 % failures behind them belong to that adapter — the same Winsock RFCOMM
	// stack on an Intel adapter opened 96 % (ev3-lab-communication, win32-bt-2026-10.md §8).
	//
	// Two backends. Winsock2 opens an AF_BTH RFCOMM socket through koffi and is what the
	// testlab measured and chose; SPP goes through the COM port and stays behind it because
	// it needs no FFI, so it still works where koffi cannot load. Falling from one to the
	// other happens only when a backend cannot run on this host at all — a failed connect
	// ends the attempt, because the channel it just disturbed needs the cooldown more than
	// it needs another immediate try.
	const btBackend = new BtSppBackend();
	// One queue for the whole transport: connects, pairing attempts and the presence jobs all
	// page the radio, so they take turns rather than race.
	const btQueue = services.add(new BtConnectionQueue());
	const btHelperPath = path.join(options.extensionPath, 'native', 'bin', 'bt-pairing-helper.exe');
	const btDiscovery = new BtClassicDiscovery({
		portScan: btBackend.discover,
		// Asked on every scan; logged once, and again only if the reason changes (HOSTC, 11.11.2026).
		onCacheUnavailable: (() => {
			const warn = logOnChange((message) => log.warn(message));
			return (reason: string) => warn(`BT device cache unavailable, falling back to the COM port scan: ${reason}`);
		})(),
		connectionQueue: btQueue,
		pairDevice: createHelperPairing({ helperPath: btHelperPath }),
		// At info, with the time since the pairing began: pairing is rare and paced by a person,
		// and the wait before the brick asks has to be findable (step-3 hardware session).
		onPairingEvent: (mac, event, elapsedMs) => log.info(`Pairing ${mac} +${elapsedMs} ms: ${JSON.stringify(event)}`),
	});
	// Which Bluetooth bricks are actually there (step-2 plan, U7): an inquiry now and then, so
	// a brick nobody has paired yet appears without anyone opening a picker; and a check of
	// each paired brick without a session, so one that is switched off turns "not heard"
	// instead of looking available because Windows still lists it.
	const btPresence: BtPresenceMonitor = new BtPresenceMonitor({
		queue: btQueue,
		check: createHelperPresenceCheck({ helperPath: btHelperPath, log }),
		inquire: () => scanForBricks({
			helperPath: btHelperPath,
			ouiFilter: BT.LEGO_OUI,
			inquirySeconds: BT.PRESENCE_INQUIRY_SECONDS,
			timeoutSeconds: BT.PRESENCE_INQUIRY_SECONDS + 20,
		}).done,
		pairedWithoutSession: (): string[] => btProvider.pairedWithoutSession(),
		onUnavailable: (reason) => log.warn(
			`Bluetooth presence unavailable, the list shows Windows' records only: ${reason}`),
		onChange: refreshDiscovery,
	});
	services.add({ dispose: () => btPresence.dispose() });
	const btProvider: BtTransportProvider = services.add(new BtTransportProvider({
		presence: btPresence,
		discoverDevices: btDiscovery.discover,
		unpairDevice: btDiscovery.unpair,
		backends: new Map<BtBackend, BtAdapterFactory>([
			['winsock', (mac) => new BtWinsockAdapter({ mac })],
			['spp', btBackend.adapterFor],
		]),
		connectionQueue: btQueue,
	}));
	registry.register(btProvider);
	log.info(process.platform === 'win32'
		? 'BT transport registered (Winsock RFCOMM, SPP fallback; bthprops discovery)'
		// Its Winsock, bthprops and helper paths are Windows-only; only the serial-port fallback can run here.
		: `BT transport registered (Windows backends unavailable on ${process.platform}; serial-port fallback only)`);

	return { btDiscovery, btPresence };
}
