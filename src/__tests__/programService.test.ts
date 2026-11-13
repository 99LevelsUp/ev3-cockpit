/**
 * The program control service (step-5 plan, U3): run, stop, emergency stop and run state for
 * one brick, over the mock brick that behaves as the firmware does (U2).
 *
 * KTD2: the firmware refuses a start into a running slot in silence, so the service checks
 * first (refused unless `replace`) and confirms afterwards. KTD3: emergency stop is the brick's
 * own power-off sequence. KTD4: run state is followed while someone listens, and not otherwise —
 * not even for a program the service started (owner decision D5 of the step-6 plan). Since step 6
 * U9 it is followed through the telemetry row, not a poll of the service's own.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { MockTransportProvider } from '../mock/mockTransportProvider';
import { BrickCommand, BrickResponse, makeBrickKey, Transport } from '../contracts';
import { ErrorCode } from '../errors/CockpitError';
import { ProgramFollow, ProgramService } from '../programs/programService';
import { waitFor } from './waitFor';

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRG = '/home/root/lms2012/prjs/Demo/Demo.rbf';

/** A stand-in for following the program row: counts follows and lets a test say the state. */
function fakeFollow() {
	let tell: ((running: boolean) => void) | undefined;
	const counts = { follows: 0, disposes: 0 };
	const follow: ProgramFollow = {
		follow: (onState) => {
			counts.follows += 1;
			tell = onState;
			return { dispose: () => { counts.disposes += 1; tell = undefined; } };
		},
	};
	return { follow, counts, say: (running: boolean) => tell?.(running) };
}

async function world() {
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
	const row = fakeFollow();
	const service = new ProgramService(send, { confirmTimeoutMs: 200, confirmStepMs: 10 }, row.follow);
	return {
		mock, service, sent, row,
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

	it('follows the run state while anyone listens: one follow for every listener, ended with the last (U9)', async () => {
		const w = await world();
		const first = w.service.onStateChange(() => { /* listening */ });
		const second = w.service.onStateChange(() => { /* listening */ });
		assert.deepEqual(w.row.counts, { follows: 1, disposes: 0 });

		first.dispose();
		assert.deepEqual(w.row.counts, { follows: 1, disposes: 0 }, 'one listener still there');
		second.dispose();
		assert.deepEqual(w.row.counts, { follows: 1, disposes: 1 });
		assert.ok(!w.sent.includes('program:status'), 'no poll of its own (U9)');
		w.done();
	});

	it('refuses to follow without telemetry, and keeps no listener whose follow could not start (U9)', async () => {
		const w = await world();
		const bare = new ProgramService(async () => ({ kind: 'program:stop' }) as BrickResponse);
		assert.throws(() => bare.onStateChange(() => undefined), (error) => codeOf(error) === ErrorCode.SubscriptionFailed);

		let fail = true;
		let say: ((running: boolean) => void) | undefined;
		const flaky = new ProgramService(async () => ({ kind: 'program:stop' }) as BrickResponse, {}, {
			follow: (onState) => {
				if (fail) { throw new Error('the brick is not connected'); }
				say = onState;
				return { dispose: () => undefined };
			},
		});
		const refused: boolean[] = [];
		assert.throws(() => flaky.onStateChange((running) => refused.push(running)), /not connected/);
		fail = false;
		const later = flaky.onStateChange(() => undefined);   // a fresh attempt, not a stale listener's
		say?.(false);
		say?.(true);
		assert.deepEqual(refused, [], 'a listener that was refused hears nothing');
		later.dispose();
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
			{ confirmTimeoutMs: 200, confirmStepMs: 10 });

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
		w.row.say(false);   // the program row: it ended by itself
		w.row.say(false);   // and is read again, still ended

		assert.deepEqual(states, [true, false]);
		w.done();
	});

	it('does not follow the brick when nobody listens, even while a program it started runs', async () => {
		const w = await world();
		await w.service.run(PRG);
		const before = w.sent.length;

		await settle(100);

		assert.equal(w.sent.length, before, 'asked a brick nobody asked about (step-6 plan D5)');
		assert.equal(w.row.counts.follows, 0);
		w.done();
	});
});
