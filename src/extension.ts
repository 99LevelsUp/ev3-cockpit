import * as vscode from 'vscode';
import { DisposableStore } from './events';
import { ProviderRegistry } from './transports';
import { DiscoveryScheduler, PresenceAggregator } from './runtime';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from './mock';

export function activate(context: vscode.ExtensionContext): void {
	console.log('EVƎ Cockpit activated');

	const services = new DisposableStore();
	context.subscriptions.push(services);

	// ── Transport layer ─────────────────────────────────────────
	const registry = services.add(new ProviderRegistry());
	const mockProvider = services.add(new MockTransportProvider(DEFAULT_MOCK_CONFIG));
	registry.register(mockProvider);
	console.log(`✓ MockTransportProvider registered (${DEFAULT_MOCK_CONFIG.bricks.length} brick(s))`);

	// ── Discovery & presence ────────────────────────────────────
	const scheduler = services.add(new DiscoveryScheduler(registry));
	const aggregator = services.add(new PresenceAggregator(scheduler));

	// Wire events for visibility
	aggregator.onListChanged(e => {
		console.log(`📡 Discovery list updated (${e.items.length} brick(s)):`, e.items.map(i => i.displayName));
	});

	aggregator.onPresenceChanged(e => {
		console.log(`🔄 Presence: ${e.item.displayName} ${e.previousState} → ${e.currentState}`);
	});

	// Start discovery polling
	scheduler.start();
	console.log('🚀 Discovery scheduler started (3s polling interval)');

	// Run one initial scan to populate the list
	void scheduler.scanOnce().then(() => {
		console.log('✅ Initial discovery scan complete');
	}).catch(err => {
		console.error('❌ Initial discovery scan failed:', err);
	});

	// Phase 2+: session manager, telemetry runtime, public API,
	// and UI panel will be wired here.
}

export function deactivate(): void {
	console.log('EVƎ Cockpit deactivated');
	// context.subscriptions handles disposal — nothing extra needed here.
}
