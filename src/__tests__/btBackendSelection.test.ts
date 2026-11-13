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

	it('names the registry key Windows keeps, with this brick\'s address', async () => {
		const provider = new BtTransportProvider({ unpairDevice: () => ({ ok: true }) });

		const residue = await provider.forget(KEY);

		// The user is told where the record is so they can deal with it themselves; the cockpit
		// does not touch a key owned by SYSTEM (plan step 3, KD3).
		assert.equal(
			residue[0]?.location,
			'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\001653aabbcc'
		);
		assert.match(residue[0]?.reason ?? '', /SYSTEM/);
	});

	it('names Windows\' in-memory record, which outlives the unpair until Windows restarts', async () => {
		const provider = new BtTransportProvider({ unpairDevice: () => ({ ok: true }) });

		const residue = await provider.forget(KEY);

		assert.equal(residue.length, 2);
		assert.match(residue[1].location, /001653AABBCC/);
		assert.match(residue[1].reason, /restart/);
	});

	it('reports no residue when it had no way to unpair', async () => {
		// Without an unpair hook nothing reached Windows, so there is nothing to account for.
		assert.deepEqual(await new BtTransportProvider({}).forget(KEY), []);
	});

	it('stops presence checking a forgotten brick', async () => {
		const provider = new BtTransportProvider({
			unpairDevice: () => ({ ok: true }),
			// Spelled the way discovery spells it, which is not how the brick key spells it.
			discoverDevices: () => Promise.resolve([{
				mac: '00:16:53:AA:BB:CC', name: '', connected: false, remembered: true, authenticated: true,
			}]),
		});
		await provider.discover();
		assert.deepEqual(provider.pairedWithoutSession(), ['00:16:53:AA:BB:CC']);

		await provider.forget(KEY);

		// Until the next scan the provider's list still said "paired", and presence would page a
		// brick Windows no longer knows.
		assert.deepEqual(provider.pairedWithoutSession(), []);
	});

	it('does not hold back the next connect to a forgotten brick', async () => {
		const at: number[] = [];
		const started = Date.now();
		const provider = new BtTransportProvider({
			unpairDevice: () => ({ ok: true }),
			reconnectGapAfterCloseMs: 500,
			backends: new Map<BtBackend, BtAdapterFactory>([['winsock', () => adapterThat(() => {
				at.push(Date.now() - started);
				return Promise.resolve();
			})]]),
		});

		await provider.connect(KEY);
		await provider.forget(KEY);
		await provider.connect(KEY);

		// Forget leaves no memory of the brick, its close time included (plan step 3, KTD7).
		assert.ok(at[1] - at[0] < 100, `reopened after ${at[1] - at[0]} ms`);
		provider.dispose();
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

describe('BtTransportProvider — reconnecting to the same brick', () => {
	const KEY_B = makeBrickKey(Transport.BT, '00:16:53:aa:bb:dd');
	const opens = () => {
		const at: Array<{ mac: string; ms: number }> = [];
		const started = Date.now();
		const backends = new Map<BtBackend, BtAdapterFactory>([['winsock', (mac) => adapterThat(() => {
			at.push({ mac, ms: Date.now() - started });
			return Promise.resolve();
		})]]);
		return { at, backends };
	};

	it('gives a brick its gap after a close before connecting to it again', async () => {
		// Measured 29.10.2026: a connect 0-2 s after a clean close failed with WSA 10064, and
		// that sequence was what tipped the old blocking connect into its collapse.
		const { at, backends } = opens();
		const provider = new BtTransportProvider({ backends, reconnectGapAfterCloseMs: 150 });

		await provider.connect(KEY);
		await provider.disconnect(KEY);
		await provider.connect(KEY);

		assert.ok(at[1].ms - at[0].ms >= 140, `reopened after ${at[1].ms - at[0].ms} ms`);
		provider.dispose();
	});

	it('does not make another brick wait for that gap', async () => {
		const { at, backends } = opens();
		const provider = new BtTransportProvider({ backends, reconnectGapAfterCloseMs: 500 });

		await provider.connect(KEY);
		await provider.disconnect(KEY);
		await provider.connect(KEY_B);

		assert.ok(at[1].ms < 100, `the other brick waited ${at[1].ms} ms`);
		provider.dispose();
	});
});

describe('BtTransportProvider — dispose reaches a link still opening (review of 6955f22)', () => {
	it('closes an adapter whose open is in flight, and keeps no session when it lands', async () => {
		let land!: () => void;
		const gate = new Promise<void>((resolve) => { land = resolve; });
		const events: string[] = [];
		const backends = new Map<BtBackend, BtAdapterFactory>([[
			'bluez', () => ({
				open: async () => { events.push('open-start'); await gate; events.push('open-landed'); },
				close: () => { events.push('closed'); return Promise.resolve(); },
				send: () => Promise.reject(new TransportError('not used')),
				get isOpen() { return false; },
			}),
		]]);
		const provider = new BtTransportProvider({ backends });
		const connecting = provider.connect(KEY).then(() => 'connected', (e: unknown) => e);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(events, ['open-start']);

		provider.dispose();
		assert.ok(events.includes('closed'), 'dispose closes the link still opening');
		land();
		const outcome = await connecting;
		assert.ok(outcome instanceof Error, 'a connect that lands after dispose must fail');
	});
});

describe('BtTransportProvider — one lifetime: nothing runs outside the scope (ownership audit, round 4)', () => {
	interface Made { open: boolean; closed: boolean }
	/** A backend whose adapters honour the open signal; `gate` holds their opens until landed. */
	function backend(name: BtBackend, gate?: Promise<void>): { backends: Map<BtBackend, BtAdapterFactory>; made: Made[] } {
		const made: Made[] = [];
		const backends = new Map<BtBackend, BtAdapterFactory>([[name, () => {
			const record: Made = { open: false, closed: false };
			made.push(record);
			return {
				async open(o?: { signal?: AbortSignal }): Promise<void> {
					if (gate) {
						await new Promise<void>((resolve, reject) => {
							void gate.then(resolve);
							o?.signal?.addEventListener('abort', () => reject(o.signal!.reason), { once: true });
						});
					}
					record.open = true;
				},
				close: () => { record.closed = true; return Promise.resolve(); },
				send: () => Promise.reject(new TransportError('not used')),
				get isOpen() { return record.open && !record.closed; },
			};
		}]]);
		return { backends, made };
	}
	const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	for (const name of ['bluez', 'winsock'] as const) {
		it(`[${name}] ends a connect waiting out the reconnect gap, making no adapter`, async () => {
			const { backends, made } = backend(name);
			const provider = new BtTransportProvider({ backends, reconnectGapAfterCloseMs: 60_000 });
			await provider.connect(KEY);
			await provider.disconnect(KEY);
			const reconnecting = provider.connect(KEY).then(() => 'connected', (e: unknown) => e);
			await tick(10);
			const started = Date.now();
			await provider.disposeAsync();
			assert.ok(Date.now() - started < 1000, 'the gap does not hold the dispose');
			assert.ok((await reconnecting) instanceof Error);
			assert.equal(made.length, 1, 'no adapter made after the gap');
		});

		it(`[${name}] ends a connect waiting for the queue`, async () => {
			const { backends, made } = backend(name);
			const queue = new BtConnectionQueue();
			const provider = new BtTransportProvider({ backends, connectionQueue: queue });
			const held = await queue.acquire('someone-else');
			const connecting = provider.connect(KEY).then(() => 'connected', (e: unknown) => e);
			await tick(10);
			await provider.disposeAsync();
			assert.ok((await connecting) instanceof Error);
			assert.equal(made.length, 0);
			held();
		});

		it(`[${name}] waits for an adapter mid-open, which closes, and keeps no session`, async () => {
			const { backends, made } = backend(name, new Promise<void>(() => { /* never */ }));
			const provider = new BtTransportProvider({ backends });
			const connecting = provider.connect(KEY).then(() => 'connected', (e: unknown) => e);
			await tick(10);
			await provider.disposeAsync();
			assert.ok((await connecting) instanceof Error);
			assert.deepEqual(made.map((m) => m.open), [false]);
			await assert.rejects(() => provider.sendPacket(KEY, new Uint8Array(4)));
		});

		it(`[${name}] closes a link that finished opening as the dispose came`, async () => {
			let land!: () => void;
			const { backends, made } = backend(name, new Promise<void>((resolve) => { land = resolve; }));
			const provider = new BtTransportProvider({ backends });
			const connecting = provider.connect(KEY).catch(() => undefined);
			await tick(10);
			land();
			const disposing = provider.disposeAsync();
			await Promise.all([connecting, disposing]);
			assert.ok(made.every((m) => !m.open || m.closed), 'every adapter that opened is closed');
		});

		it(`[${name}] resolves the dispose only once an aborted open has finished cleaning up`, async () => {
			const events: string[] = [];
			const backends = new Map<BtBackend, BtAdapterFactory>([[name, () => ({
				open: (o?: { signal?: AbortSignal }) => new Promise<void>((_resolve, reject) => {
					o?.signal?.addEventListener('abort', () => {
						setTimeout(() => { events.push('cleanup done'); reject(o.signal!.reason); }, 30);
					}, { once: true });
				}),
				close: () => Promise.resolve(),
				send: () => Promise.reject(new TransportError('not used')),
				get isOpen() { return false; },
			})]]);
			const provider = new BtTransportProvider({ backends });
			const connecting = provider.connect(KEY).catch(() => undefined);
			await tick(10);
			await provider.disposeAsync();
			events.push('dispose resolved');
			await connecting;
			assert.deepEqual(events, ['cleanup done', 'dispose resolved']);
		});

		it(`[${name}] answers two connects to one brick with one adapter (audit round 4, #7)`, async () => {
			const { backends, made } = backend(name);
			const provider = new BtTransportProvider({ backends });
			const [a, b] = await Promise.all([provider.connect(KEY), provider.connect(KEY)]);
			assert.deepEqual(a, b);
			assert.equal(made.length, 1);
			await provider.disposeAsync();
			assert.equal(made[0].closed, true);
		});

		it(`[${name}] refuses connect and discover after the dispose, making nothing`, async () => {
			const { backends, made } = backend(name);
			const provider = new BtTransportProvider({ backends });
			await provider.disposeAsync();
			await assert.rejects(() => provider.connect(KEY), /disposed/);
			await assert.rejects(() => provider.discover(), /disposed/);
			assert.equal(made.length, 0);
		});
	}
});
