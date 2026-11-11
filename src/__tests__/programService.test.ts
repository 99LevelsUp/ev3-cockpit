/**
 * The program control service (step-5 plan, U3): run, stop, emergency stop and run state for
 * one brick, over the mock brick that behaves as the firmware does (U2).
 *
 * KTD2: the firmware refuses a start into a running slot in silence, so the service checks
 * first (refused unless `replace`) and confirms afterwards. KTD3: emergency stop is the brick's
 * own power-off sequence. KTD4: run state is polled while someone listens or a program the
 * service started runs, and not otherwise.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { MockTransportProvider } from '../mock/mockTransportProvider';
import { BrickCommand, BrickResponse, makeBrickKey, Transport } from '../contracts';
import { ErrorCode } from '../errors/CockpitError';
import { ProgramService } from '../programs/programService';
import { waitFor } from './waitFor';

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRG = '/home/root/lms2012/prjs/Demo/Demo.rbf';

async function world(options: { pollMs?: number } = {}) {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			filesystem: [{ path: PRG, content: 'LEGO-rbf-image' }],
		}],
	} as never);
	await mock.connect(KEY);
	const sent: BrickCommand['kind'][] = [];
	let override: ((command: BrickCommand) => BrickResponse | undefined) | undefined;
	const send = async (command: BrickCommand): Promise<BrickResponse> => {
		sent.push(command.kind);
		return override?.(command) ?? mock.executeCommand(KEY, command);
	};
	const service = new ProgramService(send, { pollMs: options.pollMs ?? 20, confirmTimeoutMs: 200, confirmStepMs: 10 });
	return {
		mock, service, sent,
		setOverride: (f: typeof override) => { override = f; },
		done: () => { service.dispose(); mock.dispose(); },
	};
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('Program control service (step-5 U3)', () => {
	it('runs a program and says it runs', async () => {
		const w = await world();

		assert.equal(await w.service.run(PRG), true);

		assert.equal(await w.service.isRunning(), true);
		w.done();
	});

	it('refuses to run while a program runs, unless asked to replace it', async () => {
		const w = await world();
		await w.service.run(PRG);

		await assert.rejects(w.service.run(PRG), (error) => codeOf(error) === ErrorCode.ProgramRunning);
		await w.service.run(PRG, { replace: true });

		assert.equal(await w.service.isRunning(), true);
		assert.ok(w.sent.includes('program:stop'), 'replaced without stopping first: the firmware would refuse the start');
		w.done();
	});

	it('says the program is not on the brick', async () => {
		const w = await world();

		await assert.rejects(w.service.run('/home/root/lms2012/prjs/None/None.rbf'),
			(error) => codeOf(error) === ErrorCode.ProgramNotFound);
		w.done();
	});

	it('does not claim a refusal when the slot never shows running: a short program may have ended already', async () => {
		const w = await world();
		w.setOverride((command) => command.kind === 'program:run' ? { kind: 'program:run', imageBytes: 14 } : undefined);

		assert.equal(await w.service.run(PRG), false, 'said it was seen running');
		w.done();
	});

	it('runs one program at a time when two callers ask at once: the second is told one runs', async () => {
		const w = await world();

		const results = await Promise.allSettled([w.service.run(PRG), w.service.run(PRG)]);

		assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
		const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
		assert.equal(codeOf(rejected?.reason), ErrorCode.ProgramRunning);
		w.done();
	});

	it('stops following a started program once the brick no longer answers', async () => {
		const w = await world();
		await w.service.run(PRG);
		w.setOverride(() => { throw new Error('brick gone'); });
		await settle(60);
		const after = w.sent.length;

		await settle(100);

		assert.equal(w.sent.length, after, 'kept asking a brick that is gone, with nobody listening');
		w.done();
	});

	it('tells every listener even when one of them throws, and the run still succeeds', async () => {
		const w = await world();
		const seen: boolean[] = [];
		w.service.onStateChange(() => { throw new Error('a consumer bug'); });
		w.service.onStateChange((running) => { seen.push(running); });

		assert.equal(await w.service.run(PRG), true);

		assert.deepEqual(seen, [true]);
		w.done();
	});

	it('stops a program', async () => {
		const w = await world();
		await w.service.run(PRG);

		await w.service.stop();

		assert.equal(await w.service.isRunning(), false);
		w.done();
	});

	it('stops in an emergency with the brick\'s power-off sequence, motors included', async () => {
		const w = await world();
		await w.service.run(PRG);

		await w.service.emergencyStop();

		assert.equal(await w.service.isRunning(), false);
		assert.equal(w.mock.motorsStoppedCount(KEY), 1);
		w.done();
	});

	it('tells a listener when a program starts and when it ends by itself, once each', async () => {
		const w = await world();
		const states: boolean[] = [];
		w.service.onStateChange((running) => { states.push(running); });

		await w.service.run(PRG);
		await waitFor(() => states.length === 1, 1000);
		w.mock.endProgram(KEY);
		await waitFor(() => states.length === 2, 1000);
		await settle(80);

		assert.deepEqual(states, [true, false]);
		w.done();
	});

	it('does not poll the brick when nobody listens and no program it started runs', async () => {
		const w = await world();
		await w.service.run(PRG);
		await w.service.stop();
		const before = w.sent.length;

		await settle(100);

		assert.equal(w.sent.length, before, 'kept polling a brick nobody asked about');
		w.done();
	});

	it('polls while a program it started runs, and stops once it ended', async () => {
		const w = await world();
		await w.service.run(PRG);
		await settle(60);
		assert.ok(w.sent.filter((kind) => kind === 'program:status').length >= 3, 'did not follow the running program');

		w.mock.endProgram(KEY);
		await settle(60);
		const after = w.sent.length;
		await settle(80);

		assert.equal(w.sent.length, after);
		w.done();
	});
});
