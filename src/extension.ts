import * as vscode from 'vscode';
import * as path from 'node:path';
import { DisposableStore } from './events';
import {
	ProviderRegistry,
	UsbTransportProvider, TcpTransportProvider, BtTransportProvider, BtSppBackend,
	BtConnectionQueue, BtWinsockAdapter, BtClassicDiscovery,
} from './transports';
import type { BtBackend, BtAdapterFactory } from './transports';
import {
	createHelperPairing, scanForBricks, BtPairingEvent, ScannedBrick,
} from './transports/btPairingHelper';
import { BT } from './transports/transportConstants';
import { createBrickFilesystem, BrickFilesystem } from './fs/brickFilesystem';

/** Where the brick keeps user projects. The one path worth a default. */
const PROJECTS_PATH = '/home/root/lms2012/prjs';
import { DiscoveryScheduler, PresenceAggregator, SessionManager } from './runtime';
import { PresenceState, Transport, makeBrickKey } from './contracts';
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
	// 30 s and growing after a failure) are still unsupported: waiting longer never raised
	// the open rate (plan 2.8.16), and the ~50 % failures behind them belong to that adapter —
	// the same Winsock RFCOMM stack on an Intel adapter opened 96 % (ev3-lab-communication,
	// win32-bt-2026-10.md §8). Their values come from the step-1 plan's gap sweep (U3.2).
	//
	// Two backends. Winsock2 opens an AF_BTH RFCOMM socket through koffi and is what the
	// testlab measured and chose; SPP goes through the COM port and stays behind it because
	// it needs no FFI, so it still works where koffi cannot load. Falling from one to the
	// other happens only when a backend cannot run on this host at all — a failed connect
	// ends the attempt, because the channel it just disturbed needs the cooldown more than
	// it needs another immediate try.
	const btBackend = new BtSppBackend();
	// One queue for the whole transport: connects and pairing attempts both page the radio,
	// so they take turns opening rather than race.
	const btQueue = services.add(new BtConnectionQueue());
	const btHelperPath = path.join(context.extensionPath, 'native', 'bin', 'bt-pairing-helper.exe');
	const btDiscovery = new BtClassicDiscovery({
		portScan: btBackend.discover,
		onCacheUnavailable: (reason) => logger.warn(
			`BT device cache unavailable, falling back to the COM port scan: ${reason}`
		),
		connectionQueue: btQueue,
		pairDevice: createHelperPairing({ helperPath: btHelperPath }),
	});
	const btProvider = services.add(new BtTransportProvider({
		discoverDevices: btDiscovery.discover,
		unpairDevice: btDiscovery.unpair,
		backends: new Map<BtBackend, BtAdapterFactory>([
			['winsock', (mac) => new BtWinsockAdapter({ mac })],
			['spp', btBackend.adapterFor],
		]),
		connectionQueue: btQueue,
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
	const aggregator = services.add(new PresenceAggregator(scheduler, registry));

	aggregator.onListChanged(e => {
		logger.debug(`Discovery list updated (${e.items.length} brick(s)):`,
			e.items.map(i => `${i.name.value} [${i.channels.map(c => `${c.transport}:${c.state}`).join(' ')}]`));
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

	// A channel's state in the list follows its session: connected, lost while it reconnects,
	// available again once signed out.
	services.add(sessionManager.onSessionStateChange(e => {
		aggregator.updateChannelSession(e.brickKey, e.newState);
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

	// ── Bluetooth: pick a brick and connect to it ───────────────
	// A palette command for the same reason the filesystem ones exist: this needs a consumer
	// before the panel arrives, and it has to be exercisable by hand against a real brick.
	// The panel (Phase 5) is where this belongs for a real user.
	//
	// The whole interaction is picking a brick by name. Pairing is not something a user should
	// have to think about, let alone do first in Windows: if the brick they picked has never
	// been paired, this pairs it and then connects. Nobody who owns a Mindstorms brick knows
	// its MAC address, and nothing should ask them for one.
	services.add(vscode.commands.registerCommand('ev3-cockpit.connectBluetoothBrick', async () => {
		interface BrickItem extends vscode.QuickPickItem { brick: ScannedBrick }

		const picker = vscode.window.createQuickPick<BrickItem>();
		picker.title = 'EVƎ Cockpit: connect a brick over Bluetooth';
		picker.placeholder = 'Looking for bricks in range…';
		picker.busy = true;
		// The list re-sorts while someone is choosing from it; the highlight has to stay on
		// the brick they arrowed to, not on whatever row it used to be.
		picker.keepScrollPosition = true;

		const scan = scanForBricks({
			helperPath: btHelperPath,
			ouiFilter: BT.LEGO_OUI,
			onChange: (bricks) => {
				// Sorting happens here, not in the scan: which brick belongs at the top is a
				// question about the person at the screen. Strongest signal first, so the one
				// somebody is walking towards the computer holding climbs the list as they
				// approach and is top by the time they arrive. The list is meant to move.
				const focusedMac = picker.activeItems[0]?.brick.mac;
				picker.items = [...bricks]
					.sort((a, b) =>
						(b.signal ?? Number.NEGATIVE_INFINITY) - (a.signal ?? Number.NEGATIVE_INFINITY))
					.map((brick) => ({
						label: brick.name || `EV3 [${brick.mac}]`,
						description: brick.paired ? 'paired' : 'new',
						detail: brick.mac,
						brick,
					}));
				const focused = picker.items.find((item) => item.brick.mac === focusedMac);
				if (focused) { picker.activeItems = [focused]; }
			},
			onComplete: () => {
				picker.busy = false;
				picker.placeholder = picker.items.length
					? 'Pick a brick'
					: 'No bricks in range. Check that the brick is on, with Bluetooth and visibility enabled.';
			},
		});
		// A helper that cannot start at all (missing from the install, or not Windows) rejects
		// rather than ending; without this the picker would spin with nothing to show for it.
		scan.done.catch((error: unknown) => {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error('Bluetooth scan could not run', err);
			picker.busy = false;
			picker.placeholder = `Bluetooth scan could not run: ${err.message}`;
		});

		const picked = await new Promise<ScannedBrick | undefined>((resolve) => {
			picker.onDidAccept(() => resolve(picker.selectedItems[0]?.brick));
			picker.onDidHide(() => resolve(undefined));
			picker.show();
		});
		picker.hide();
		picker.dispose();
		scan.cancel();

		if (!picked) { return; }
		const brickKey = makeBrickKey(Transport.BT, picked.mac);
		const label = picked.name || picked.mac;

		const paired = picked.paired || await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `EVƎ Cockpit: pairing ${label}`, cancellable: false },
			async (progress) => {
				const result = await btDiscovery.pair(picked.mac, (event: BtPairingEvent) => {
					logger.debug(`Pairing ${picked.mac}: ${JSON.stringify(event)}`);
					// Prompt on `found`, not on `pairingRequested`: by the time the brick is
					// asking, whoever is meant to press it has seconds. On `found` they have
					// the whole ceremony.
					if (event.type === 'found' && event.alreadyPaired === false) {
						progress.report({ message: 'Confirm on the brick\'s display, then accept PIN 1234.' });
					}
				});
				if (!result.ok) {
					logger.warn(`Pairing ${picked.mac} failed: ${result.reason ?? 'no reason given'}`);
					void vscode.window.showErrorMessage(
						`EVƎ Cockpit: could not pair ${label} — ${result.reason ?? 'no reason given.'}`);
				}
				return result.ok;
			});
		if (!paired) { return; }

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `EVƎ Cockpit: connecting to ${label}`, cancellable: false },
			async () => {
				// A freshly paired brick is not in the discovery list yet — the OS knows the
				// pairing immediately, the next scheduled scan is up to a poll interval away.
				await scheduler.scanOnce().catch(() => { /* connect is what matters here */ });
				try {
					await sessionManager.connect(brickKey, Transport.BT, label);
					logger.info(`Connected to ${label} over Bluetooth`);
					void vscode.window.showInformationMessage(`EVƎ Cockpit: connected to ${label}.`);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					logger.error(`Connecting to ${label} failed`, err);
					void vscode.window.showErrorMessage(
						`EVƎ Cockpit: could not connect to ${label} — ${err.message}`);
				}
			});
	}));

	logger.info('Bluetooth connect command registered');

	// Phase 3+: telemetry runtime, public API, UI panel wired here.
}

export function deactivate(): void {
	// context.subscriptions handles disposal — nothing extra needed here.
}
