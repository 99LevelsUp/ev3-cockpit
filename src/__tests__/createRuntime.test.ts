/**
 * The runtime the extension and the hardware harness both build (step-2 plan, U9, KTD9).
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport, makeBrickKey, brickIdOf } from '../contracts';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from '../mock';
import { createRuntime } from '../runtime/createRuntime';
import { createBrickFilesystem } from '../fs/brickFilesystem';
import { waitFor } from './waitFor';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('createRuntime', () => {
	it('wires discovery to the brick layer: a discovered mock brick signs in and answers', async () => {
		const runtime = createRuntime({
			extensionPath: '.',
			log: quiet,
			startPresence: false,
			providers: [new MockTransportProvider(DEFAULT_MOCK_CONFIG)],
		});
		try {
			const marvin = brickIdOf(makeBrickKey(Transport.Mock, 'marvin'));
			await waitFor(() => runtime.aggregator.getBrick(marvin) !== undefined, 2000);

			await runtime.bricks.signIn(marvin);
			assert.equal(runtime.bricks.getActiveBrickId(), marvin);

			const usage = await createBrickFilesystem(runtime.bricks, marvin).files.storage();
			assert.deepEqual(usage, { totalKb: 6000, freeKb: 4000 });
		} finally {
			runtime.dispose();
		}
	});

	it('builds no Bluetooth pairing or presence when the providers are injected', () => {
		const runtime = createRuntime({ extensionPath: '.', log: quiet, startPresence: false, providers: [] });
		assert.equal(runtime.btDiscovery, undefined);
		assert.equal(runtime.btPresence, undefined);
		runtime.dispose();
	});
});
