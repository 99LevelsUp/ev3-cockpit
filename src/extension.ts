import * as vscode from 'vscode';
import { DisposableStore } from './events';

export function activate(context: vscode.ExtensionContext): void {
	console.log('EVƎ Cockpit activated');

	const services = new DisposableStore();
	context.subscriptions.push(services);

	// Phase 1+: transport providers, presence aggregator, session manager,
	// telemetry runtime, public API, and UI panel will be wired here.
	// Each service is registered via services.add(...) so it is disposed
	// automatically when the extension deactivates.
}

export function deactivate(): void {
	console.log('EVƎ Cockpit deactivated');
	// context.subscriptions handles disposal — nothing extra needed here.
}
