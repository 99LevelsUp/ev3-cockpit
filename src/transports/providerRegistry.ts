import * as vscode from 'vscode';
import { Transport, TransportProvider } from '../contracts';

/**
 * Central registry of transport providers.
 *
 * Each transport type can have at most one registered provider.
 * The registry owns the lifecycle of registered providers and disposes them
 * when the registry itself is disposed.
 *
 * Fires `onProviderRegistered` and `onProviderUnregistered` so that consumers
 * (e.g. DiscoveryScheduler) can react to provider changes without polling.
 */
export class ProviderRegistry implements vscode.Disposable {
	private readonly providers = new Map<Transport, TransportProvider>();

	private readonly _onProviderRegistered = new vscode.EventEmitter<TransportProvider>();
	private readonly _onProviderUnregistered = new vscode.EventEmitter<Transport>();

	/** Fired when a provider is registered (or replaces an existing one for the same transport). */
	readonly onProviderRegistered: vscode.Event<TransportProvider> = this._onProviderRegistered.event;
	/** Fired when a provider is unregistered (after it has been disposed). */
	readonly onProviderUnregistered: vscode.Event<Transport> = this._onProviderUnregistered.event;

	/** Register a provider. Replaces any existing provider for the same transport. */
	register(provider: TransportProvider): void {
		const existing = this.providers.get(provider.transport);
		if (existing) {
			existing.dispose();
		}
		this.providers.set(provider.transport, provider);
		this._onProviderRegistered.fire(provider);
	}

	/** Unregister and dispose a provider by transport type. */
	unregister(transport: Transport): void {
		const provider = this.providers.get(transport);
		if (provider) {
			this.providers.delete(transport);
			provider.dispose();
			this._onProviderUnregistered.fire(transport);
		}
	}

	/** Get a provider by transport type. */
	get(transport: Transport): TransportProvider | undefined {
		return this.providers.get(transport);
	}

	/** Return all currently registered providers. */
	all(): TransportProvider[] {
		return [...this.providers.values()];
	}

	/** Number of registered providers. */
	get size(): number {
		return this.providers.size;
	}

	dispose(): void {
		for (const provider of this.providers.values()) {
			provider.dispose();
		}
		this.providers.clear();
		this._onProviderRegistered.dispose();
		this._onProviderUnregistered.dispose();
	}
}
