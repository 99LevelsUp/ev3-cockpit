/**
 * The program control service (step-5 plan, U3): run, stop, emergency stop and run state for
 * one brick, over the mock brick that behaves as the firmware does (U2).
 *
 * KTD2: the firmware refuses a start into a running slot in silence, so the service checks
 * first (refused unless `replace`) and confirms afterwards. KTD3: emergency stop is the brick's
 * own power-off sequence. KTD4: run state is polled while someone listens, and not otherwise —
 * not even for a program the service started (owner decision D5 of the step-6 plan).
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

	it('keeps polling for a listener through lost replies', async () => {
		const w = await world();
		w.service.onStateChange(() => { /* listening */ });
		let lost = 0;
		w.setOverride((command) => {
			if (command.kind === 'program:status' && lost < 3) { lost += 1; throw new Error('a lost reply'); }
			return undefined;
		});
		await waitFor(() => lost >= 3, 2000);
		const before = w.sent.length;

		await waitFor(() => w.sent.length > before, 2000);

		w.done();
	});

	it('stops polling as soon as the last listener leaves', async () => {
		const w = await world();
		const listening = w.service.onStateChange(() => { /* listening */ });
		await waitFor(() => w.sent.includes('program:status'), 1000);

		listening.dispose();
		const after = w.sent.length;
		await settle(100);

		assert.equal(w.sent.length, after, 'kept polling with nobody listening');
		w.done();
	});

	it('never starts a program after an emergency stop asked while the start was on its way', async () => {
		const w = await world();
		let release: () => void = () => { /* replaced below */ };
		const held = new Promise<void>((resolve) => { release = resolve; });
		let firstStatus = true;
		const statusGate = async (command: BrickCommand): Promise<BrickResponse> => {
			if (command.kind === 'program:status' && firstStatus) { firstStatus = false; await held; }
			return w.mock.executeCommand(KEY, command);
		};
		const service = new ProgramService(async (command) => { w.sent.push(command.kind); return statusGate(command); },
			{ pollMs: 20, confirmTimeoutMs: 200, confirmStepMs: 10 });

		const running = service.run(PRG);   // waits on its first status question
		await settle(10);
		const stopped = service.emergencyStop();
		release();

		await assert.rejects(running, (error) => codeOf(error) === ErrorCode.ProgramCancelled);
		await stopped;
		assert.equal(await service.isRunning(), false, 'the program started after the emergency stop');
		assert.equal(w.sent.includes('program:run'), false);
		service.dispose();
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

	it('does not poll again after a poll that was on its way when the last listener left', async () => {
		const w = await world();
		let release: () => void = () => { /* replaced below */ };
		const held = new Promise<void>((resolve) => { release = resolve; });
		let holding = true;
		const service = new ProgramService(async (command) => {
			w.sent.push(command.kind);
			if (command.kind === 'program:status' && holding) { holding = false; await held; }
			return w.mock.executeCommand(KEY, command);
		}, { pollMs: 20, confirmTimeoutMs: 200, confirmStepMs: 10 });
		const listening = service.onStateChange(() => { /* listening */ });
		await waitFor(() => !holding, 1000);   // the first poll is on its way

		listening.dispose();
		const after = w.sent.length;   // counted before the reply comes back: no poll may follow it
		release();
		await settle(130);

		assert.equal(w.sent.length, after, 'the poll on its way scheduled another one for nobody');
		service.dispose();
		w.done();
	});

	it('does not poll the brick when nobody listens, even while a program it started runs', async () => {
		const w = await world();
		await w.service.run(PRG);
		const before = w.sent.length;

		await settle(100);

		assert.equal(w.sent.length, before, 'polled a brick nobody asked about (step-6 plan D5)');
		w.done();
	});
});
