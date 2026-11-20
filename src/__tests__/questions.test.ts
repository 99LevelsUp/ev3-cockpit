/** A question for a person: answered, or `keep` — never `no` — when nobody answers. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEndpoint } from '../client/connection';
import { ask } from '../daemon/questions';
import { duplexPair } from './duplexPair';

function pair() {
	const [a, b] = duplexPair();
	return { daemon: createEndpoint(a), client: createEndpoint(b) };
}

describe('questions for a person', () => {
	it('returns the person\'s answer', async () => {
		const { daemon, client } = pair();
		client.onRequest('question/ask', () => ({ answer: 'no' }));
		assert.equal(await ask(daemon, { kind: 'forget', text: 'Forget CCC?' }), 'no');
		daemon.close();
	});

	it('counts silence as keep once the question times out, and withdraws it', async () => {
		const { daemon, client } = pair();
		const withdrawn: unknown[] = [];
		client.onRequest('question/ask', () => new Promise(() => { /* nobody answers */ }));
		client.onNotification('question/withdrawn', (p) => withdrawn.push(p));
		assert.equal(await ask(daemon, { kind: 'sweep', text: 'Release?', timeoutMs: 50 }), 'keep');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(withdrawn.length, 1);
		daemon.close();
	});

	it('counts a client that leaves while asked as keep', async () => {
		const { daemon, client } = pair();
		client.onRequest('question/ask', () => new Promise(() => { /* nobody answers */ }));
		setTimeout(() => client.close(), 20);
		assert.equal(await ask(daemon, { kind: 'sweep', text: 'Release?' }), 'keep');
	});

	it('reads anything but yes or no as keep', async () => {
		const { daemon, client } = pair();
		client.onRequest('question/ask', () => ({ answer: 'maybe' }));
		assert.equal(await ask(daemon, { kind: 'clearBluetoothList', text: 'Clear?' }), 'keep');
		daemon.close();
	});
});
