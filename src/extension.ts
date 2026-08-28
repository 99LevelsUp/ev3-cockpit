import * as vscode from 'vscode';
import { DisposableStore } from './events';
import {
	ProviderRegistry,
	UsbTransportProvider, TcpTransportProvider, BtTransportProvider, BtSppBackend,
	BtConnectionQueue, BtWinsockAdapter, BtClassicDiscovery,
} from './transports';
import type { BtBackend, BtAdapterFactory } from './transports';
import { createBrickFilesystem, BrickFilesystem } from './fs/brickFilesystem';

/** Where the brick keeps user projects. The one path worth a default. */
const PROJECTS_PATH = '/home/root/lms2012/prjs';
import { DiscoveryScheduler, PresenceAggregator, SessionManager } from './runtime';
import { ConnectionState, PresenceState } from './contracts';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from './mock';

export function activate(context: vscode.ExtensionContext): void {
	const logger = vscode.window.createOutputChannel('EVƎ Cockpit', { log: true });
	context.subscriptions.push(logger);

	logger.info('EVƎ Cockpit activated');

	const services = new DisposableStore();
	context.subscriptions.push(services);

	// ── Transport layer ─────────────────────────────────────────
	const registry = services.add(new ProviderRegistry());

	// Mock transport (always — for development and testing)
	const mockProvider = services.add(new MockTransportProvider(DEFAULT_MOCK_CONFIG));
	registry.register(mockProvider);
	logger.info(`Mock transport registered (${DEFAULT_MOCK_CONFIG.bricks.length} brick(s))`);

	// USB transport: discovery over node-hid, connections over libusb where it can claim
	// the interface. The provider logs which backend each connection landed on, because a
	// HID fallback is a degraded link rather than an equivalent one.
	const usbProvider = services.add(new UsbTransportProvider({ log: logger }));
	registry.register(usbProvider);
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const hid = require('node-hid') as { devices(v: number, p: number): unknown[] };
		const found = hid.devices(0x0694, 0x0005).length;
		logger.info(`USB transport registered — node-hid OK, ${found} EV3 device(s) visible`);
	} catch (e) {
		logger.warn(`USB transport registered — node-hid unavailable in extension host: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require('usb');
		logger.info('USB transport — libusb available, full 1024-byte frames');
	} catch (e) {
		// Worth saying at activation rather than at the first failed copy: without libusb
		// every USB link runs at 64 bytes a packet, where copy and move do not fit.
		logger.warn(
			'USB transport — libusb unavailable, USB links will fall back to 64-byte HID '
			+ `packets: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	// TCP transport (UDP beacon discovery on port 3015, connects on port 5555)
	const tcpProvider = services.add(new TcpTransportProvider());
	registry.register(tcpProvider);
	logger.info('TCP transport registered');

	// BT transport. Discovery reads the Windows Bluetooth device cache, which is what the
	// testlab used and answers the question discovery actually asks: which bricks does this
	// machine know about, and what does each call itself. The COM-port scan runs behind it,
	// both as a fallback and because the SPP backend builds its adapters from what it saw.
	//
	// Those two used to be the same list, back when the runtime went through a serial port.
	// They are not any more: a paired brick whose outgoing port Windows never created is
	// invisible to a port scan and perfectly reachable over a socket.
	//
	// Nothing here pairs anything -- that is still the user's action on their own machine,
	// and a brick they have not paired does not appear. See plan 1.11.13.
	//
	// The connection queue is not optional. Windows carries exactly **one** RFCOMM/SPP
	// channel: a second connection fails with error 121 until the first is fully released,
	// and recovery is about 10 s after a clean close and 30 s or more after a failure. That
	// was measured in the testlab long before this code existed, and `BtConnectionQueue` was
	// written from those numbers — but nothing ever passed it in, so every Bluetooth
	// connection went straight at the adapter with no pacing at all.
	//
	// What that looked like from outside: the first connect in a session worked and the next
	// one failed, seemingly at random, differently on each brick.
	//
	// Two backends. Winsock2 opens an AF_BTH RFCOMM socket through koffi and is what the
	// testlab measured and chose; SPP goes through the COM port and stays behind it because
	// it needs no FFI, so it still works where koffi cannot load. Falling from one to the
	// other happens only when a backend cannot run on this host at all — a failed connect
	// ends the attempt, because the channel it just disturbed needs the cooldown more than
	// it needs another immediate try.
	const btBackend = new BtSppBackend();
	const btDiscovery = new BtClassicDiscovery({
		portScan: btBackend.discover,
		onCacheUnavailable: (reason) => logger.warn(
			`BT device cache unavailable, falling back to the COM port scan: ${reason}`
		),
	});
	const btProvider = services.add(new BtTransportProvider({
		discoverDevices: btDiscovery.discover,
		unpairDevice: btDiscovery.unpair,
		backends: new Map<BtBackend, BtAdapterFactory>([
			['winsock', (mac) => new BtWinsockAdapter({ mac })],
			['spp', btBackend.adapterFor],
		]),
		connectionQueue: services.add(new BtConnectionQueue()),
	}));
	registry.register(btProvider);
	logger.info('BT transport registered (Winsock RFCOMM, SPP fallback; bthprops discovery)');

	// ── Session Manager ─────────────────────────────────────────
	const sessionManager = services.add(new SessionManager({ providerRegistry: registry }));

	sessionManager.onSessionStateChange(e => {
		logger.info(`Session: ${e.brickKey} ${e.previousState} → ${e.newState}`);
	});
	sessionManager.onActiveBrickChange(e => {
		logger.info(`Active brick: ${e.previousBrickKey ?? 'none'} → ${e.newBrickKey ?? 'none'}`);
	});

	// ── Discovery & presence ────────────────────────────────────
	const scheduler = services.add(new DiscoveryScheduler(registry));
	const aggregator = services.add(new PresenceAggregator(scheduler));

	aggregator.onListChanged(e => {
		logger.debug(`Discovery list updated (${e.items.length} brick(s)):`,
			e.items.map(i => i.displayName));
	});
	aggregator.onPresenceChanged(e => {
		logger.info(`Presence: ${e.item.displayName} [${e.item.transport}] ${e.previousState ?? 'new'} → ${e.currentState}`);

		// A brick that has just become visible again is the evidence a reconnecting session
		// is waiting for. Measured before this existed: a brick that boots in about 40 s took
		// 121 s to be picked up, because the backoff had reached 30-second steps and waited
		// them out beside a brick that was ready. Backoff remains the fallback wherever
		// discovery cannot see — this only ever makes an attempt happen sooner.
		if (e.currentState === PresenceState.Available) {
			sessionManager.notifyBrickAvailable(e.brickKey);
		}
	});

	// The discovery list owns `connected` locally, and nothing was telling it. Without
	// this the flag stayed false for every brick no matter how many were connected --
	// `updateBrick` had no caller outside the tests.
	services.add(sessionManager.onSessionStateChange(e => {
		aggregator.updateBrick(e.brickKey, {
			connected: e.newState === ConnectionState.Connected,
		});
	}));

	services.add(scheduler.onScanFailed(e => {
		logger.error(`Discovery scan failed on ${e.transport}`,
			e.error instanceof Error ? e.error : new Error(String(e.error)));
	}));

	// Start discovery polling
	scheduler.start();
	logger.info('Discovery scheduler started');

	void scheduler.scanOnce().then(() => {
		logger.info('Initial discovery scan complete');
	}).catch((err: unknown) => {
		logger.error('Initial discovery scan failed',
			err instanceof Error ? err : new Error(String(err)));
	});

	// ── Filesystem ──────────────────────────────────────────────
	// Palette commands are diagnostics, not the primary UX (DESIGN §14). They exist here
	// so the filesystem layer has a consumer before the API and panel arrive, and so it
	// can be exercised by hand against a real brick.
	const withActiveFilesystem = async (
		what: string,
		body: (fs: BrickFilesystem, brickKey: string) => Promise<void>,
	): Promise<void> => {
		const brickKey = sessionManager.getActiveBrickKey();
		if (!brickKey) {
			void vscode.window.showWarningMessage(
				`EV\u018E Cockpit: no active brick, so ${what} has nothing to talk to.`);
			return;
		}
		try {
			await body(createBrickFilesystem(sessionManager, brickKey), brickKey);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`${what} failed on ${brickKey}`, err);
			void vscode.window.showErrorMessage(`EV\u018E Cockpit: ${what} failed — ${err.message}`);
		}
	};

	services.add(vscode.commands.registerCommand('ev3-cockpit.listProjects', () =>
		withActiveFilesystem('listing projects', async (fs, brickKey) => {
			const entries = await fs.files.list(PROJECTS_PATH);
			logger.info(`Files on ${brickKey} at ${PROJECTS_PATH} (${entries.length}):`);
			for (const e of entries) {
				const size = e.bytes === undefined ? '' : ` ${e.bytes} B`;
				logger.info(`  ${e.kind === 'directory' ? '[dir] ' : '      '}${e.name}${size}`);
			}
			logger.show(true);
		})));

	services.add(vscode.commands.registerCommand('ev3-cockpit.showStorage', () =>
		withActiveFilesystem('reading storage', async (fs, brickKey) => {
			const usage = await fs.files.storage();
			const used = usage.totalKb - usage.freeKb;
			void vscode.window.showInformationMessage(
				`EV\u018E ${brickKey}: ${usage.freeKb} KB free of ${usage.totalKb} KB `
				+ `(${used} KB used).`);
		})));

	logger.info('Filesystem commands registered');

	// Phase 3+: telemetry runtime, public API, UI panel wired here.
}

export function deactivate(): void {
	// context.subscriptions handles disposal — nothing extra needed here.
}
