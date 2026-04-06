import * as vscode from 'vscode';
import { DisposableStore } from './events';
import {
	ProviderRegistry,
	UsbTransportProvider, TcpTransportProvider, BtTransportProvider,
} from './transports';
import { DiscoveryScheduler, PresenceAggregator, SessionManager } from './runtime';
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

	// USB transport (lazy-loads node-hid; returns empty list if unavailable)
	const usbProvider = services.add(new UsbTransportProvider());
	registry.register(usbProvider);
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const hid = require('node-hid') as { devices(v: number, p: number): unknown[] };
		const found = hid.devices(0x0694, 0x0005).length;
		logger.info(`USB transport registered — node-hid OK, ${found} EV3 device(s) visible`);
	} catch (e) {
		logger.warn(`USB transport registered — node-hid unavailable in extension host: ${e instanceof Error ? e.message : String(e)}`);
	}

	// TCP transport (UDP beacon discovery on port 3015, connects on port 5555)
	const tcpProvider = services.add(new TcpTransportProvider());
	registry.register(tcpProvider);
	logger.info('TCP transport registered');

	// BT transport (discovery requires platform backend — silent until wired)
	const btProvider = services.add(new BtTransportProvider());
	registry.register(btProvider);
	logger.info('BT transport registered (discovery not yet wired)');

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
		logger.info(`Presence: ${e.item.displayName} [${e.item.transport}] ${e.previousState} → ${e.currentState}`);
	});

	// Start discovery polling
	scheduler.start();
	logger.info('Discovery scheduler started');

	void scheduler.scanOnce().then(() => {
		logger.info('Initial discovery scan complete');
	}).catch((err: unknown) => {
		logger.error('Initial discovery scan failed',
			err instanceof Error ? err : new Error(String(err)));
	});

	// Phase 3+: telemetry runtime, public API, UI panel wired here.
}

export function deactivate(): void {
	// context.subscriptions handles disposal — nothing extra needed here.
}
