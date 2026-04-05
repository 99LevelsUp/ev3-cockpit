import * as vscode from 'vscode';
import { DisposableStore } from './events';
import { ProviderRegistry } from './transports';
import { DiscoveryScheduler, PresenceAggregator } from './runtime';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from './mock';
import { OutputChannelLogger } from './diagnostics';

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel('EVƎ Cockpit');
	const logger = new OutputChannelLogger(channel);
	context.subscriptions.push(logger);

	logger.info('EVƎ Cockpit activated');

	const services = new DisposableStore();
	context.subscriptions.push(services);

	// ── Transport layer ─────────────────────────────────────────
	const registry = services.add(new ProviderRegistry());
	const mockProvider = services.add(new MockTransportProvider(DEFAULT_MOCK_CONFIG));
	registry.register(mockProvider);
	logger.info(`MockTransportProvider registered (${DEFAULT_MOCK_CONFIG.bricks.length} brick(s))`);

	// ── Discovery & presence ────────────────────────────────────
	const scheduler = services.add(new DiscoveryScheduler(registry));
	const aggregator = services.add(new PresenceAggregator(scheduler));

	aggregator.onListChanged(e => {
		logger.debug(`Discovery list updated (${e.items.length} brick(s)):`, e.items.map(i => i.displayName));
	});

	aggregator.onPresenceChanged(e => {
		logger.info(`Presence: ${e.item.displayName} ${e.previousState} → ${e.currentState}`);
	});

	// Start discovery polling
	scheduler.start();
	logger.info('Discovery scheduler started');

	// Run one initial scan to populate the list
	void scheduler.scanOnce().then(() => {
		logger.info('Initial discovery scan complete');
	}).catch((err: unknown) => {
		logger.error('Initial discovery scan failed', err instanceof Error ? err : new Error(String(err)));
	});

	// Phase 2+: session manager, telemetry runtime, public API,
	// and UI panel will be wired here.
}

export function deactivate(): void {
	console.log('EVƎ Cockpit deactivated');
	// context.subscriptions handles disposal — nothing extra needed here.
}
