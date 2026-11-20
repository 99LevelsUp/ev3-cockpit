/**
 * A stop does not wait behind a run: it reaches the brick at once, even while a run is still
 * confirming its start, and a run asked before it whose start is not sent yet starts nothing.
 * Over the mock brick, which keeps the user slot as the firmware does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse, makeBrickKey, Transport } from '../core/contracts';
import { ErrorCode } from '../core/errors/CockpitError';
import { MockTransportProvider } from '../core/mock/mockTransportProvider';
import { ProgramService } from '../core/programs/programService';
import { waitFor } from './waitFor';

const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRG = '/home/root/lms2012/prjs/Demo/Demo.rbf';

async function world() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			filesystem: [{ path: PRG, content: 'LEGO-rbf-image' }],
		}],
	} as never);
	await mock.connect(KEY);
	/** What reached the brick and what the test saw happen, in order. */
	const events: string[] = [];
	let hold: ((command: BrickCommand) => Promise<void> | undefined) | undefined;
	let answer: ((command: BrickCommand) => BrickResponse | undefined) | undefined;
	const send = async (command: BrickCommand): Promise<BrickResponse> => {
		await hold?.(command);
		events.push(command.kind);
		return answer?.(command) ?? mock.executeCommand(KEY, command);
	};
	const service = new ProgramService(send, { confirmTimeoutMs: 300, confirmStepMs: 10 });
	return {
		mock, service, events,
		holdWith: (f: typeof hold) => { hold = f; },
		answerWith: (f: typeof answer) => { answer = f; },
		done: () => { service.dispose(); mock.dispose(); },
	};
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('Stopping a program does not wait behind a run', () => {
	it('sends the stop while a run is still confirming its start, before the confirmation ends', async () => {
		const w = await world();
		// The brick takes the start but never shows the program running: the run keeps asking
		// for its whole confirmation window.
		w.answerWith((command) => (command.kind === 'program:run' ? { kind: 'program:run', imageBytes: 14 } : undefined));

		const running = w.service.run(PRG).then((started) => { w.events.push('run settled'); return started; });
		await waitFor(() => w.events.includes('program:run'), 1000);
		await w.service.stop('VS Code');
		w.events.push('stop settled');
		await running;

		assert.ok(w.events.includes('program:stop'), 'the stop never reached the brick');
		assert.ok(w.events.indexOf('program:stop') < w.events.indexOf('run settled'),
			`the stop waited for the run's confirmation: ${w.events.join(', ')}`);
		assert.ok(w.events.indexOf('stop settled') < w.events.indexOf('run settled'), 'the stop returned only after the run');
		w.done();
	});

	it('starts nothing when a stop comes while a run is still checking the slot', async () => {
		const w = await world();
		let release: () => void = () => { /* replaced below */ };
		const held = new Promise<void>((resolve) => { release = resolve; });
		let first = true;
		// The run's first question, whether a program runs, is held on its way.
		w.holdWith((command) => {
			if (command.kind === 'program:status' && first) { first = false; return held; }
			return undefined;
		});

		const running = w.service.run(PRG);
		await waitFor(() => !first, 1000);
		const stopped = w.service.stop('VS Code');
		release();

		await assert.rejects(running, (error) => codeOf(error) === ErrorCode.ProgramCancelled);
		await stopped;
		assert.equal(w.events.includes('program:run'), false, 'a start went out after the stop');
		assert.equal(await w.service.isRunning(), false);
		w.done();
	});
});
