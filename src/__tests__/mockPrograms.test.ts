/**
 * The mock brick runs programs the way the firmware does (step-5 plan, U2, KTD7), so the
 * program service and the public API can be tested, and used in the development host, without
 * a brick: a start into a running user slot is refused in silence, a missing file loads as
 * size 0 and does not start, and stop, status, emergency stop and the shell answer.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { MockTransportProvider } from '../mock/mockTransportProvider';
import { makeBrickKey, Transport } from '../contracts';

const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRG = '/home/root/lms2012/prjs/Demo/Demo.rbf';

async function brick() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			filesystem: [{ path: PRG, content: 'LEGO-rbf-image' }],
		}],
	} as never);
	await mock.connect(KEY);
	return mock;
}

describe('Mock brick programs (step-5 U2)', () => {
	it('loads and starts a program that is on the brick, and reports it running', async () => {
		const mock = await brick();

		const run = await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });

		assert.deepEqual(run, { kind: 'program:run', imageBytes: 'LEGO-rbf-image'.length });
		assert.deepEqual(await mock.executeCommand(KEY, { kind: 'program:status' }), { kind: 'program:status', running: true, status: 0x10 });
		mock.dispose();
	});

	it('finds a program by the firmware\'s relative path from its sys folder', async () => {
		const mock = await brick();

		const run = await mock.executeCommand(KEY, { kind: 'program:run', path: '../prjs/Demo/Demo' });

		assert.equal(run.kind === 'program:run' && run.imageBytes > 0, true);
		mock.dispose();
	});

	it('loads a missing file as size 0 and starts nothing', async () => {
		const mock = await brick();

		const run = await mock.executeCommand(KEY, { kind: 'program:run', path: '/home/root/lms2012/prjs/None/None.rbf' });

		assert.deepEqual(run, { kind: 'program:run', imageBytes: 0 });
		assert.deepEqual(await mock.executeCommand(KEY, { kind: 'program:status' }), { kind: 'program:status', running: false, status: 0x40 });
		mock.dispose();
	});

	it('refuses in silence a start while a program runs, as the firmware does', async () => {
		const mock = await brick();
		await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });

		const second = await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });

		assert.deepEqual(second, { kind: 'program:run', imageBytes: 0 }, 'the load on a busy slot writes nothing');
		mock.dispose();
	});

	it('stops a program, and an emergency stop stops it and every motor', async () => {
		const mock = await brick();
		await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });
		await mock.executeCommand(KEY, { kind: 'program:stop' });
		assert.equal((await mock.executeCommand(KEY, { kind: 'program:status' }) as { running: boolean }).running, false);

		await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });
		await mock.executeCommand(KEY, { kind: 'program:emergencyStop' });

		assert.equal((await mock.executeCommand(KEY, { kind: 'program:status' }) as { running: boolean }).running, false);
		assert.equal(mock.motorsStoppedCount(KEY), 1);
		mock.dispose();
	});

	it('runs a shell command, records it and answers status 0', async () => {
		const mock = await brick();

		const result = await mock.executeCommand(KEY, { kind: 'system:run', command: 'chmod +x /home/root/lms2012/prjs/Demo/prog' });

		assert.deepEqual(result, { kind: 'system:run', status: 0 });
		assert.deepEqual(mock.shellCommands(KEY), ['chmod +x /home/root/lms2012/prjs/Demo/prog']);
		mock.dispose();
	});

	it('ends a running program on request, as a program on a brick ends by itself', async () => {
		const mock = await brick();
		await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });

		mock.endProgram(KEY);

		assert.equal((await mock.executeCommand(KEY, { kind: 'program:status' }) as { running: boolean }).running, false);
		mock.dispose();
	});
});
