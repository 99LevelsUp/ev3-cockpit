/**
 * How `BtTransportProvider` chooses between its two backends.
 *
 * The rule is not "try them all". Windows carries one RFCOMM channel, and a backend that
 * failed a connect has just disturbed it — following that with a second backend spends the
 * recovery instead of shortening it, which is the mistake that was already removed from
 * `BtSppAdapter` once. Only a backend that could not run at all is worth stepping over.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BtTransportProvider, BtBackend, BtAdapterFactory } from '../transports/btTransportProvider';
import { BtConnectionQueue } from '../transports/btConnectionQueue';
import { TransportAdapter } from '../transports/transportAdapter';
import { BackendUnavailableError, TransportError, ConnectionError } from '../errors/CockpitError';
import { Transport, makeBrickKey } from '../contracts';

const MAC = '00:16:53:aa:bb:cc';
const KEY = makeBrickKey(Transport.BT, MAC);

/** An adapter whose `open()` does whatever the test needs. */
function adapterThat(open: () => Promise<void>): TransportAdapter {
	return {
		open,
		close: () => Promise.resolve(),
		send: () => Promise.reject(new TransportError('not used')),
		get isOpen() { return false; },
	};
}

/** Records which backends were asked to open, in order. */
function tracked(
	entries: Array<[BtBackend, () => Promise<void>]>
): { backends: Map<BtBackend, BtAdapterFactory>; attempts: BtBackend[] } {
	const attempts: BtBackend[] = [];
	const backends = new Map<BtBackend, BtAdapterFactory>();
	for (const [name, open] of entries) {
		backends.set(name, () => adapterThat(() => {
			attempts.push(name);
			return open();
		}));
	}
	return { backends, attempts };
}

describe('BtTransportProvider — backend selection', () => {
	it('uses the first backend that opens', async () => {
		const { backends, attempts } = tracked([
			['winsock', () => Promise.resolve()],
			['spp', () => Promise.reject(new TransportError('should not be reached'))],
		]);
		const provider = new BtTransportProvider({ backends });

		const handle = await provider.connect(KEY);

		assert.equal(handle.transport, Transport.BT);
		assert.deepEqual(attempts, ['winsock']);
	});

	it('steps over a backend that cannot run on this host', async () => {
		const { backends, attempts } = tracked([
			['winsock', () => Promise.reject(new BackendUnavailableError('koffi is not installed'))],
			['spp', () => Promise.resolve()],
		]);
		const provider = new BtTransportProvider({ backends });

		await provider.connect(KEY);

		// Nothing reached the radio, so the fallback costs nothing.
		assert.deepEqual(attempts, ['winsock', 'spp']);
	});

	it('does not try the next backend after a connect that actually failed', async () => {
		const { backends, attempts } = tracked([
			['winsock', () => Promise.reject(new TransportError('WSA error 10060'))],
			['spp', () => Promise.resolve()],
		]);
		const provider = new BtTransportProvider({ backends });

		await assert.rejects(provider.connect(KEY), /10060/);

		// The channel is settling. A second backend here is the impatient retry under a
		// different name; the caller waits out the queue's error cooldown instead.
		assert.deepEqual(attempts, ['winsock']);
	});

	it('says no backend can run here when every one is unavailable', async () => {
		const { backends } = tracked([
			['winsock', () => Promise.reject(new BackendUnavailableError('no radio'))],
			['spp', () => Promise.reject(new BackendUnavailableError('no serialport'))],
		]);
		const provider = new BtTransportProvider({ backends });

		await assert.rejects(provider.connect(KEY), (error: unknown) => {
			assert.ok(error instanceof ConnectionError);
			assert.match((error as Error).message, /no radio/);
			assert.match((error as Error).message, /no serialport/);
			return true;
		});
	});

	it('prefers the backend that worked for this brick last time', async () => {
		const { backends, attempts } = tracked([
			['winsock', () => Promise.reject(new BackendUnavailableError('no radio'))],
			['spp', () => Promise.resolve()],
		]);
		const provider = new BtTransportProvider({ backends });

		await provider.connect(KEY);
		await provider.disconnect(KEY);
		attempts.length = 0;
		await provider.connect(KEY);

		assert.deepEqual(attempts, ['spp'], 'the known-good backend goes first on the retry');
	});
});

// ════════════════════════════════════════════════════════════════════
// Forgetting
// ════════════════════════════════════════════════════════════════════

describe('BtTransportProvider — forgetting', () => {
	it('removes the OS pairing, not just its own bookkeeping', async () => {
		const unpaired: string[] = [];
		const provider = new BtTransportProvider({
			unpairDevice: (mac) => { unpaired.push(mac); return { ok: true }; },
		});

		await provider.forget(KEY);

		// Dropping only the cached backend preference left the pairing in place, so the
		// brick came back on the next scan as though nothing had happened.
		assert.deepEqual(unpaired, [MAC]);
	});

	it('advertises forget only when it can actually forget', () => {
		assert.equal(new BtTransportProvider({}).capabilities.supportsForget, false);
		assert.equal(
			new BtTransportProvider({ unpairDevice: () => ({ ok: true }) })
				.capabilities.supportsForget,
			true
		);
	});

	it('reports a refused unpair instead of claiming success', async () => {
		const provider = new BtTransportProvider({
			unpairDevice: () => ({ ok: false, reason: 'device is in use' }),
		});

		await assert.rejects(provider.forget(KEY), /device is in use/);
	});
});

describe('BtTransportProvider — the connection queue', () => {
	const KEY_B = makeBrickKey(Transport.BT, '00:16:53:aa:bb:dd');
	const quickQueue = () => new BtConnectionQueue({
		interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0, acquireTimeoutMs: 200,
	});

	it('lets a second brick connect while the first stays connected', async () => {
		// Measured 29.10.2026: this host holds two Bluetooth sessions at once. A session that
		// kept the queue's only slot for its whole life made the second connect wait out the
		// acquire timeout and fail, so the cockpit could never hold two bricks on Bluetooth.
		const queue = quickQueue();
		const provider = new BtTransportProvider({
			backends: new Map<BtBackend, BtAdapterFactory>([['winsock', () => adapterThat(() => Promise.resolve())]]),
			connectionQueue: queue,
		});

		await provider.connect(KEY);
		const second = await provider.connect(KEY_B);

		assert.equal(second.brickKey, KEY_B);
		provider.dispose();
	});

	it('still opens one connection at a time', async () => {
		// What the queue is still for: two opens must not page the radio at once.
		let releaseFirst: () => void = () => {};
		const order: string[] = [];
		const provider = new BtTransportProvider({
			backends: new Map<BtBackend, BtAdapterFactory>([['winsock', (mac) => adapterThat(() => {
				order.push(`open ${mac}`);
				return mac === MAC
					? new Promise<void>((resolve) => { releaseFirst = () => { order.push(`opened ${mac}`); resolve(); }; })
					: Promise.resolve();
			})]]),
			connectionQueue: new BtConnectionQueue({
				interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0, acquireTimeoutMs: 2000,
			}),
		});

		const first = provider.connect(KEY);
		const second = provider.connect(KEY_B);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(order, [`open ${MAC}`], 'the second open must wait for the first');
		releaseFirst();
		await Promise.all([first, second]);
		assert.deepEqual(order, [`open ${MAC}`, `opened ${MAC}`, 'open 00:16:53:aa:bb:dd']);
		provider.dispose();
	});
});
