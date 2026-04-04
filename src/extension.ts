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
	registry.register(services.add(new MockTransportProvider(DEFAULT_MOCK_CONFIG)));

	// ── Discovery & presence ────────────────────────────────────
	const scheduler = services.add(new DiscoveryScheduler(registry));
	// Aggregator is wired to scheduler events via constructor — retained for Phase 2+ wiring.
	services.add(new PresenceAggregator(scheduler));

	// Start discovery polling
	scheduler.start();

	// Phase 2+: session manager, telemetry runtime, public API,
	// and UI panel will be wired here.
}

export function deactivate(): void {
	console.log('EVƎ Cockpit deactivated');
	// context.subscriptions handles disposal — nothing extra needed here.
}
