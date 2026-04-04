import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { ProviderRegistry } from '../transports/providerRegistry';
import { Transport } from '../contracts/enums';
import { makeBrickKey, BrickKey } from '../contracts/brickKey';
import {
	TransportProvider, TransportCapabilities, SessionHandle, DiscoveryScanResult,
	BrickCommand, BrickResponse,
} from '../contracts/transport';
import { DiscoveryItem, PresenceState } from '../contracts';

// ── Helpers ─────────────────────────────────────────────────────────

function makeStubProvider(transport: Transport, disposed?: { value: boolean }): TransportProvider {
	return {
		transport,
		capabilities: { supportsSignalInfo: false } satisfies TransportCapabilities,
		async discover(): Promise<DiscoveryScanResult> { return { transport, items: [] }; },
		async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport }; },
		async disconnect(): Promise<void> { /* noop */ },
		async send(_key: BrickKey, _cmd: BrickCommand): Promise<BrickResponse> { return { kind: 'battery', level: 0 }; },
		dispose(): void { if (disposed) { disposed.value = true; } },
	};
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
	it('registers and retrieves a provider', () => {
		const registry = new ProviderRegistry();
		const provider = makeStubProvider(Transport.Mock);
		registry.register(provider);

		assert.equal(registry.size, 1);
		assert.equal(registry.get(Transport.Mock), provider);
	});

	it('enumerates all registered providers', () => {
		const registry = new ProviderRegistry();
		registry.register(makeStubProvider(Transport.Mock));
		registry.register(makeStubProvider(Transport.USB));

		const all = registry.all();
		assert.equal(all.length, 2);
	});

	it('replaces and disposes existing provider on re-register', () => {
		const registry = new ProviderRegistry();
		const disposed = { value: false };
		registry.register(makeStubProvider(Transport.Mock, disposed));
		registry.register(makeStubProvider(Transport.Mock));

		assert.equal(disposed.value, true);
		assert.equal(registry.size, 1);
	});

	it('unregisters and disposes a provider', () => {
		const registry = new ProviderRegistry();
		const disposed = { value: false };
		registry.register(makeStubProvider(Transport.Mock, disposed));
		registry.unregister(Transport.Mock);

		assert.equal(disposed.value, true);
		assert.equal(registry.size, 0);
		assert.equal(registry.get(Transport.Mock), undefined);
	});

	it('disposes all providers on dispose', () => {
		const registry = new ProviderRegistry();
		const d1 = { value: false };
		const d2 = { value: false };
		registry.register(makeStubProvider(Transport.Mock, d1));
		registry.register(makeStubProvider(Transport.USB, d2));
		registry.dispose();

		assert.equal(d1.value, true);
		assert.equal(d2.value, true);
		assert.equal(registry.size, 0);
	});

	it('returns undefined for unregistered transport', () => {
		const registry = new ProviderRegistry();
		assert.equal(registry.get(Transport.BT), undefined);
	});

	it('fires onProviderRegistered when a provider is registered', () => {
		const registry = new ProviderRegistry();
		const fired: Transport[] = [];
		registry.onProviderRegistered(p => fired.push(p.transport));

		registry.register(makeStubProvider(Transport.Mock));
		registry.register(makeStubProvider(Transport.USB));

		assert.deepEqual(fired, [Transport.Mock, Transport.USB]);
		registry.dispose();
	});

	it('fires onProviderUnregistered when a provider is unregistered', () => {
		const registry = new ProviderRegistry();
		const fired: Transport[] = [];
		registry.onProviderUnregistered(t => fired.push(t));

		registry.register(makeStubProvider(Transport.Mock));
		registry.unregister(Transport.Mock);

		assert.deepEqual(fired, [Transport.Mock]);
		registry.dispose();
	});
});
