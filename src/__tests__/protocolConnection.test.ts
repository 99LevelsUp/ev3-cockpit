/**
 * A contract connection carries requests, notifications, cancellation and progress, fails pending
 * requests at once when the other side goes, and closes on a message over the size limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError, createEndpoint } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import { duplexPair } from './duplexPair';

function pair(options: { maxMessageBytes?: number } = {}) {
	const [a, b] = duplexPair();
	return { client: createEndpoint(a, options), server: createEndpoint(b, options) };
}

describe('a contract connection', () => {
	it('answers a request and delivers a notification', async () => {
		const { client, server } = pair();
		server.onRequest('math/add', (params) => {
			const { a, b } = params as { a: number; b: number };
			return a + b;
		});
		const heard: unknown[] = [];
		client.onNotification('news/told', (params) => heard.push(params));
		assert.equal(await client.request<number>('math/add', { a: 2, b: 3 }), 5);
		server.notify('news/told', { text: 'hi' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(heard, [{ text: 'hi' }]);
		client.close();
	});

	it('ends a cancelled request with the cancelled code, and the handler sees the abort', async () => {
		const { client, server } = pair();
		let handlerAborted = false;
		server.onRequest('slow/work', (_params, context) => new Promise((resolve) => {
			context.signal.addEventListener('abort', () => { handlerAborted = true; resolve('late'); });
		}));
		const controller = new AbortController();
		const pending = client.request('slow/work', {}, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(pending, (error: unknown) => error instanceof ContractError && error.code === WireErrorCode.Cancelled);
		assert.equal(handlerAborted, true);
		client.close();
	});

	it('delivers progress in order before the answer', async () => {
		const { client, server } = pair();
		server.onRequest('upload/file', async (_params, context) => {
			for (const transferred of [10, 20, 30]) { context.progress({ transferred }); }
			await new Promise((resolve) => setTimeout(resolve, 10));
			return 'done';
		});
		const seen: unknown[] = [];
		const answer = await client.request('upload/file', { name: 'x' }, { onProgress: (value) => seen.push(value) });
		assert.equal(answer, 'done');
		assert.deepEqual(seen, [{ transferred: 10 }, { transferred: 20 }, { transferred: 30 }]);
		client.close();
	});

	it('fails every pending request at once when the other side closes', async () => {
		const { client, server } = pair();
		server.onRequest('never/answers', () => new Promise(() => { /* never */ }));
		const first = client.request('never/answers');
		const second = client.request('never/answers');
		setTimeout(() => server.close(), 20);
		const unavailable = (error: unknown) => error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable;
		await assert.rejects(first, unavailable);
		await assert.rejects(second, unavailable);
		assert.equal(client.closed, true);
	});

	it('closes the connection on a message over the size limit and reports it', async () => {
		const [a, b] = duplexPair();
		let oversize = 0;
		const server = createEndpoint(b, { maxMessageBytes: 1024, onOversize: (bytes) => { oversize = bytes; } });
		const client = createEndpoint(a);
		server.onRequest('echo', (params) => params);
		const big = 'x'.repeat(4000);
		await assert.rejects(client.request('echo', { big }),
			(error: unknown) => error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable);
		assert.ok(oversize > 1024);
		assert.equal(server.closed, true);
	});

	it('carries a handler error with its contract code and class', async () => {
		const { client, server } = pair();
		server.onRequest('bricks/write', () => {
			throw new ContractError(WireErrorCode.BrickBusy, 'CCC is busy: terminal holds it.', { holder: 'terminal', kind: 'BrickBusyError' });
		});
		await assert.rejects(client.request('bricks/write'), (error: unknown) => error instanceof ContractError
			&& error.code === WireErrorCode.BrickBusy && error.kind === 'BrickBusyError' && error.data.holder === 'terminal');
		client.close();
	});
});
