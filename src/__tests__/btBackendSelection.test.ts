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
