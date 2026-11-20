/**
 * The handshake: a client and a daemon that share the key accept each other; anyone without it
 * learns nothing and is closed out.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEndpoint } from '../client/connection';
import { performHello } from '../client/hello';
import { HELLO_START, HelloAccepted, newNonce } from '../contract/hello';
import { acceptHello } from '../daemon/hello';
import { duplexPair } from './duplexPair';

const accepted = (): HelloAccepted => ({
	version: '1.2.3', contractVersion: 1, instanceId: 'test', pid: 1, state: 'serving', transports: ['mock'],
});
const me = { name: 'test client', kind: 'cli' as const, version: '1.2.3' };

/** Everything the daemon side wrote, as text. */
function recordWrites(stream: NodeJS.WritableStream): string[] {
	const written: string[] = [];
	const write = stream.write.bind(stream);
	(stream as { write: typeof stream.write }).write = ((chunk: unknown, ...rest: unknown[]) => {
		written.push(String(chunk));
		return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof stream.write;
	return written;
}

describe('the handshake', () => {
	it('accepts a client that holds the key, both ways', async () => {
		const key = randomBytes(32);
		const [a, b] = duplexPair();
		const daemon = createEndpoint(b);
		const accepting = acceptHello(daemon, { key, accepted });
		const client = createEndpoint(a);
		const result = await performHello(client, key, me);
		assert.equal(result.instanceId, 'test');
		const identity = await accepting;
		assert.deepEqual(identity, { name: 'test client', kind: 'cli', version: '1.2.3', contractVersion: 1 });
		client.close();
	});

	it('refuses a client with the wrong key, which hears only the daemon nonce and proof', async () => {
		const [a, b] = duplexPair();
		const written = recordWrites(b);
		const daemon = createEndpoint(b);
		const accepting = acceptHello(daemon, { key: randomBytes(32), accepted });
		const client = createEndpoint(a);
		// The client trusts any daemon proof here, to reach the daemon's check of the client's proof.
		await assert.rejects(performHello(client, randomBytes(32), me));
		await assert.rejects(accepting);
		const said = written.join('');
		assert.match(said, /daemonNonce/);
		assert.doesNotMatch(said, /instanceId/);
		assert.equal(daemon.closed, true);
	});

	it('says nothing to an opener that sends nothing', async () => {
		const [, b] = duplexPair();
		const written = recordWrites(b);
		const daemon = createEndpoint(b);
		const accepting = acceptHello(daemon, { key: randomBytes(32), accepted, timeoutMs: 100 });
		await assert.rejects(accepting);
		assert.deepEqual(written, []);
		assert.equal(daemon.closed, true);
	});

	it('closes a connection that sends another request before the handshake', async () => {
		const [a, b] = duplexPair();
		const daemon = createEndpoint(b);
		const accepting = acceptHello(daemon, { key: randomBytes(32), accepted });
		const client = createEndpoint(a);
		await assert.rejects(client.request('bricks/list', {}));
		await assert.rejects(accepting);
		assert.equal(daemon.closed, true);
	});

	it('lets a client refuse a daemon that cannot prove the key, before the client proves anything', async () => {
		const [a, b] = duplexPair();
		const impostor = createEndpoint(b);
		let finishAsked = false;
		impostor.onRequest(HELLO_START, () => ({ daemonNonce: newNonce(), daemonProof: 'f'.repeat(64) }));
		impostor.onRequest('hello/finish', () => { finishAsked = true; return accepted(); });
		const client = createEndpoint(a);
		await assert.rejects(performHello(client, randomBytes(32), me), /could not prove/);
		assert.equal(finishAsked, false);
		assert.equal(client.closed, true);
	});
});
