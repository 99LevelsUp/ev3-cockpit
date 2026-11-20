/**
 * Deploying files and starting a program as one operation, over the mock brick: it checks first
 * that nothing runs, then puts each file on the brick — leaving one whose MD5 already matches —
 * then starts the program and says how the start ended. A stop on the brick before the start ends
 * it, naming who stopped, and nothing starts.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse, makeBrickKey, Transport } from '../core/contracts';
import { CancelledError, ErrorCode, TimeoutError } from '../core/errors/CockpitError';
import { FilesystemService } from '../core/fs/filesystemService';
import { FileTransferService } from '../core/fs/fileTransferService';
import { MockTransportProvider } from '../core/mock/mockTransportProvider';
import { deployAndRun, MAX_INLINE_BYTES } from '../core/programs/deployAndRun';
import { ProgramService } from '../core/programs/programService';
import { waitFor } from './waitFor';

const KEY = makeBrickKey(Transport.Mock, 'M1');
const FOLDER = '/home/root/lms2012/prjs/Robot';
const PRG = `${FOLDER}/Robot.rbf`;
const IMAGE = 'LEGO-rbf-image';
const NOTES = `${FOLDER}/notes.txt`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function world() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			filesystem: [{ path: PRG, content: IMAGE }],
		}],
	} as never);
	await mock.connect(KEY);
	const sent: BrickCommand['kind'][] = [];
	let hold: ((command: BrickCommand) => Promise<void> | undefined) | undefined;
	let fail: ((command: BrickCommand) => Error | undefined) | undefined;
	const send = async (command: BrickCommand): Promise<BrickResponse> => {
		sent.push(command.kind);
		await hold?.(command);
		const reply = await mock.executeCommand(KEY, command);
		const failure = fail?.(command);
		if (failure) { throw failure; }
		return reply;
	};
	const services = {
		programs: new ProgramService(send, { confirmTimeoutMs: 300, confirmStepMs: 10 }),
		files: new FilesystemService(send),
		transfer: new FileTransferService(send),
	};
	return {
		mock, sent, services,
		holdWith: (f: typeof hold) => { hold = f; },
		failWith: (f: typeof fail) => { fail = f; },
		content: (p: string) => mock.getFilesystem(KEY)?.read(p),
		count: (kind: BrickCommand['kind']) => sent.filter((k) => k === kind).length,
		done: () => { services.programs.dispose(); mock.dispose(); },
	};
}

describe('Deploying files and starting a program', () => {
	it('fails with program_running and puts nothing on the brick when a program runs already', async () => {
		const w = await world();
		await w.services.programs.run(PRG);

		await assert.rejects(
			deployAndRun(w.services, { files: [{ path: NOTES, content: bytes('hello') }], program: PRG }),
			(error) => (error as { code?: unknown }).code === ErrorCode.ProgramRunning,
		);

		assert.equal(w.count('fs:beginWrite'), 0, 'a file went to the brick');
		assert.equal(w.content(NOTES), undefined);
		w.done();
	});

	it('leaves a file whose MD5 matches, uploads one that changed, and still starts the program', async () => {
		const w = await world();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
		try {
			const local = path.join(dir, 'notes.txt');
			fs.writeFileSync(local, 'from disk');

			const result = await deployAndRun(w.services, {
				files: [
					{ path: PRG, content: bytes(IMAGE), skipIfSame: true },
					{ path: NOTES, localPath: local, skipIfSame: true },
				],
				program: PRG,
			});

			assert.deepEqual(result, { outcome: 'started', uploaded: [NOTES], skipped: [PRG] });
			assert.equal(w.count('fs:beginWrite'), 1, 'the unchanged file was uploaded too');
			assert.equal(w.content(NOTES), 'from disk');
			assert.equal(await w.services.programs.isRunning(), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		w.done();
	});

	for (const stop of ['stop', 'emergencyStop'] as const) {
		it(`ends with cancelled naming who stopped when ${stop} comes during the upload, and starts nothing`, async () => {
			const w = await world();
			let release: () => void = () => { /* replaced below */ };
			const held = new Promise<void>((resolve) => { release = resolve; });
			// The first file's upload is on its way when the brick is stopped.
			w.holdWith((command) => (command.kind === 'fs:beginWrite' && w.count('fs:beginWrite') === 1 ? held : undefined));

			const deploying = deployAndRun(w.services, {
				files: [{ path: NOTES, content: bytes('first') }, { path: `${FOLDER}/second.txt`, content: bytes('second') }],
				program: PRG,
			});
			await waitFor(() => w.count('fs:beginWrite') === 1, 1000);
			const stopped = w.services.programs[stop]('VS Code');
			release();

			await assert.rejects(deploying, (error) => {
				assert.ok(error instanceof CancelledError, `not cancelled: ${String(error)}`);
				assert.equal(error.code, ErrorCode.Cancelled);
				assert.equal(error.stoppedBy, 'VS Code');
				assert.match(error.message, /VS Code/);
				return true;
			});
			await stopped;
			assert.equal(w.count('program:run'), 0, 'a start went out after the stop');
			assert.equal(w.count('fs:beginWrite'), 1, 'the upload went on after the stop');
			assert.equal(await w.services.programs.isRunning(), false);
			w.done();
		});
	}

	it('reports a start whose reply was lost as uncertain, and does not start it again', async () => {
		const w = await world();
		w.failWith((command) => (command.kind === 'program:run' ? new TimeoutError('no reply within its budget') : undefined));

		const result = await deployAndRun(w.services, { files: [], program: PRG });

		assert.equal(result.outcome, 'uncertain');
		assert.equal(w.count('program:run'), 1, 'the start was sent again');
		w.done();
	});

	it('refuses inline content over its limit before anything reaches the brick', async () => {
		const w = await world();

		await assert.rejects(deployAndRun(w.services, {
			files: [{ path: NOTES, content: new Uint8Array(MAX_INLINE_BYTES + 1) }],
			program: PRG,
		}), /4096/);

		assert.deepEqual(w.sent, [], 'something was sent');
		w.done();
	});
});
