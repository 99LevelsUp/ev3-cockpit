/**
 * The public API over the real runtime and the mock brick (step-5 plan, U7; IMPLEMENTATION_PLAN
 * 4.8 without telemetry): a consumer registers, sees the brick, connects it, puts a file on it,
 * runs and follows a program, and a second consumer works beside the first. The session manager,
 * scheduler, aggregator and brick layer are the shipped ones; only the transport is the mock.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { makeBrickKey, Transport } from '../contracts';
import { ErrorCode } from '../errors/CockpitError';
import { MockTransportProvider } from '../mock/mockTransportProvider';
import { ProviderRegistry } from '../transports/providerRegistry';
import { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import { PresenceAggregator } from '../runtime/presenceAggregator';
import { SessionManager } from '../runtime/sessionManager';
import { BrickManager } from '../runtime/brickManager';
import { createCockpitApi } from '../api/cockpitApi';
import type { AccessMode } from '../api/accessPolicy';
import { waitFor } from './waitFor';

const DEMO = '/home/root/lms2012/prjs/Demo/Demo.rbf';
const KEY = makeBrickKey(Transport.Mock, 'M1');

async function world() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'Robot', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			firmwareVersion: 'V1.09D', filesystem: [{ path: DEMO, content: 'LEGO-rbf-image' }],
		}],
	} as never);
	const registry = new ProviderRegistry();
	registry.register(mock);
	const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 1, removedAfterMisses: 5 });
	const aggregator = new PresenceAggregator(scheduler, registry);
	const sessionManager = new SessionManager({ providerRegistry: registry, heartbeatIntervalMs: 60_000 });
	const bricks = new BrickManager({ sessionManager, aggregator, providerRegistry: registry });
	let mode: AccessMode = 'safe';
	const api = createCockpitApi({
		bricks, aggregator,
		connect: (brickId) => bricks.signIn(brickId),
		accessMode: () => mode,
		onAccessModeChange: () => ({ dispose: () => { /* not under test */ } }),
		programOptions: { pollMs: 20, confirmTimeoutMs: 300, confirmStepMs: 10 },
	});
	await scheduler.scanOnce();
	const brickId = aggregator.getDiscoveryList()[0].brickId;
	return {
		mock, api, brickId, bricks,
		setMode: (m: AccessMode) => { mode = m; },
		done: () => {
			api.dispose(); bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose();
			registry.dispose(); mock.dispose();
		},
	};
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('Public API over the runtime (step-5 U7)', () => {
	it('lists the brick to a new consumer, connects it and makes it the active one', async () => {
		const w = await world();
		const consumer = w.api.registerConsumer('ev3-c');
		const seen: boolean[] = [];
		consumer.onBricksChanged((bricks) => { seen.push(bricks[0].signedIn); });
		assert.equal(consumer.listBricks()[0].name, 'Robot');
		assert.equal(consumer.listBricks()[0].signedIn, false);

		await consumer.connect(w.brickId);

		assert.equal(consumer.listBricks()[0].signedIn, true);
		assert.equal(consumer.getActiveBrickId(), w.brickId);
		assert.ok(seen.includes(true), 'no change was announced');
		assert.equal((await consumer.getBrickInfo('active')).firmwareVersion, 'V1.09D');
		w.done();
	});

	it('puts a file in the projects folder, lists it, reads it back and removes it', async () => {
		const w = await world();
		const consumer = w.api.registerConsumer('ev3-c');
		await consumer.connect(w.brickId);
		const path = '/home/root/lms2012/prjs/Robot/notes.txt';

		await consumer.makeDirectory('active', '/home/root/lms2012/prjs/Robot');
		await consumer.writeFile('active', path, new TextEncoder().encode('hello brick'));

		assert.ok((await consumer.list('active', '/home/root/lms2012/prjs/Robot')).some((e) => e.name.startsWith('notes')));
		assert.equal(new TextDecoder().decode(await consumer.readFile('active', path)), 'hello brick');
		await consumer.remove('active', path);
		assert.equal(await consumer.exists('active', path), false);
		w.done();
	});

	it('refuses a write outside the user areas in safe mode, and allows it in full mode', async () => {
		const w = await world();
		const consumer = w.api.registerConsumer('ev3-explorer');
		await consumer.connect(w.brickId);
		const path = '/home/root/lms2012/sys/notes.txt';

		await assert.rejects(consumer.writeFile('active', path, new Uint8Array([1])), (e) => codeOf(e) === ErrorCode.AccessDenied);
		assert.equal(w.mock.getFilesystem(KEY)?.exists(path), false);

		w.setMode('full');
		await consumer.writeFile('active', path, new Uint8Array([0x41]));
		assert.equal(w.mock.getFilesystem(KEY)?.exists(path), true);
		w.done();
	});

	it('runs a program, follows it until it ends by itself, and stops one in an emergency', async () => {
		const w = await world();
		const consumer = w.api.registerConsumer('ev3-blockly');
		await consumer.connect(w.brickId);
		const states: boolean[] = [];
		consumer.onProgramStateChanged('active', (state) => { states.push(state.running); });

		assert.deepEqual(await consumer.runProgram('active', DEMO), { brickId: w.brickId, running: true });
		await waitFor(() => states.includes(true), 1000);
		w.mock.endProgram(KEY);
		await waitFor(() => states.at(-1) === false, 1000);

		await consumer.runProgram('active', DEMO);
		assert.deepEqual(await consumer.emergencyStop('active'), { brickId: w.brickId, running: false });
		assert.equal(w.mock.motorsStoppedCount(KEY), 1);
		w.done();
	});

	it('says a program is running rather than starting a second one', async () => {
		const w = await world();
		const consumer = w.api.registerConsumer('ev3-c');
		await consumer.connect(w.brickId);
		await consumer.runProgram('active', DEMO);

		await assert.rejects(consumer.runProgram('active', DEMO), (e) => codeOf(e) === ErrorCode.ProgramRunning);
		assert.equal((await consumer.runProgram('active', DEMO, { replace: true })).running, true);
		w.done();
	});

	it('serves two consumers at once, and one leaving ends only its own subscriptions', async () => {
		const w = await world();
		const first = w.api.registerConsumer('ev3-c');
		const second = w.api.registerConsumer('ev3-explorer');
		let firstCalls = 0;
		let secondCalls = 0;
		first.onBricksChanged(() => { firstCalls += 1; });
		second.onBricksChanged(() => { secondCalls += 1; });

		first.dispose();
		await second.connect(w.brickId);

		assert.equal(firstCalls, 0);
		assert.ok(secondCalls > 0);
		assert.ok((await second.list('active', '/home/root/lms2012/prjs')).length >= 1);
		w.done();
	});

	it('disconnects the brick', async () => {
		const w = await world();
		const consumer = w.api.registerConsumer('ev3-c');
		await consumer.connect(w.brickId);

		await consumer.disconnect('active');

		assert.equal(consumer.listBricks()[0].signedIn, false);
		w.done();
	});
});
