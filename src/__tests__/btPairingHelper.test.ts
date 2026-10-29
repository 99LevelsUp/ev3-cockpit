/**
 * What the TypeScript side makes of the pairing helper's JSON-lines protocol.
 *
 * Every case here is one the hardware cannot stage on demand. A brick that is switched off
 * mid-inquiry, a user who never touches the brick's display, a helper binary that is not
 * installed, a helper that wedges and has to be killed — all of them are ordinary in the
 * field and none of them can be produced reliably by asking someone to hold a brick. So the
 * spawn is injected and the helper is faked, and what is pinned is the mapping from protocol
 * lines to the `{ ok, reason }` the discovery layer consumes.
 *
 * The protocol shapes are copied from what `native/bt-pairing-helper/Program.cs` actually
 * emits, not from an ideal — if that file's `Emit` calls change, these fixtures are the
 * first thing that should fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
	createHelperPairing, scanForBricks, BtPairingEvent, ScannedBrick,
} from '../transports/btPairingHelper';
import { BackendUnavailableError } from '../errors/CockpitError';

const HELPER = 'C:\\fake\\bt-pairing-helper.exe';
const MAC = '00:16:53:51:87:39';

/** What the fake helper process should do on this run. */
interface FakeRun {
	/** stdout lines, written verbatim (so a malformed line can be tested). */
	lines?: string[];
	stderr?: string;
	exitCode?: number | null;
	/** Never emits `close` on its own — the wrapper's kill guard has to end it. */
	neverExits?: boolean;
	/** Thrown synchronously by `spawn`, the way ENOENT arrives. */
	throwOnSpawn?: Error;
}

interface FakeSpawn {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	spawn: (command: string, args: string[], options: unknown) => any;
	killCount: () => number;
	lastCommand: () => string | undefined;
	lastArgs: () => string[] | undefined;
}

function fakeSpawn(run: FakeRun): FakeSpawn {
	let kills = 0;
	let command: string | undefined;
	let args: string[] | undefined;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const spawn = (cmd: string, argv: string[], _options: unknown): any => {
		if (run.throwOnSpawn) { throw run.throwOnSpawn; }
		command = cmd;
		args = argv;

		const stdout = new Readable({ read() { /* pushed below */ } });
		const stderr = new Readable({ read() { /* pushed below */ } });
		const child = new EventEmitter() as EventEmitter & {
			stdout: Readable;
			stderr: Readable;
			kill: () => boolean;
		};
		child.stdout = stdout;
		child.stderr = stderr;
		child.kill = () => {
			kills += 1;
			// A killed process still closes; the signal is what distinguishes it.
			setImmediate(() => child.emit('close', null, 'SIGTERM'));
			return true;
		};

		queueMicrotask(() => {
			for (const line of run.lines ?? []) { stdout.push(`${line}\n`); }
			stdout.push(null);
			if (run.stderr) { stderr.push(run.stderr); }
			stderr.push(null);
			if (!run.neverExits) {
				setImmediate(() => child.emit('close', run.exitCode ?? 0, null));
			}
		});

		return child;
	};

	return {
		spawn,
		killCount: () => kills,
		lastCommand: () => command,
		lastArgs: () => args,
	};
}

/** A pairing run against the fake, with the defaults the tests do not care about. */
function pairWith(run: FakeRun, over: Partial<Parameters<typeof createHelperPairing>[0]> = {}) {
	const fake = fakeSpawn(run);
	const pair = createHelperPairing({
		helperPath: HELPER,
		spawn: fake.spawn,
		...over,
	});
	return { fake, pair };
}

const FOUND = JSON.stringify({
	type: 'found', id: 'Bluetooth#Bluetoothaa-bb', name: 'BBB', alreadyPaired: false, seen: [],
});
const PAIRING_REQUESTED = JSON.stringify({ type: 'pairingRequested', kind: 'ProvidePin' });

describe('createHelperPairing — outcomes the helper reports', () => {
	it('reports success when the helper pairs', async () => {
		const { pair } = pairWith({
			lines: [FOUND, PAIRING_REQUESTED, JSON.stringify({ type: 'result', status: 'Paired', ok: true })],
			exitCode: 0,
		});
		assert.deepEqual(await pair(MAC), { ok: true });
	});

	it('treats an already-paired brick as success, though the helper sends no result line', async () => {
		// Program.cs returns 0 straight after `alreadyPaired` — the idempotent path emits no
		// `result`, so reading only `result` would report failure on a brick that is fine.
		const { pair } = pairWith({
			lines: [
				JSON.stringify({ type: 'found', id: 'x', name: 'BBB', alreadyPaired: true, seen: [] }),
				JSON.stringify({ type: 'alreadyPaired', mac: MAC }),
			],
			exitCode: 0,
		});
		assert.deepEqual(await pair(MAC), { ok: true });
	});

	it('explains a brick the inquiry never saw', async () => {
		const { pair } = pairWith({
			lines: [
				JSON.stringify({ type: 'inquiryTimedOut', seen: [], status: 'EnumerationCompleted', atMs: 45000 }),
				JSON.stringify({ type: 'result', status: 'NotFound', ok: false }),
			],
			exitCode: 3,
		});
		const result = await pair(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /not find|not found/i);
	});

	it('carries the status string when Windows refuses', async () => {
		const { pair } = pairWith({
			lines: [FOUND, JSON.stringify({ type: 'result', status: 'Failed', ok: false })],
			exitCode: 1,
		});
		const result = await pair(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /Failed/);
	});

	it('says who has to act when nobody confirms on the brick', async () => {
		// AuthenticationTimeout is the "the brick asked and nobody pressed" case, measured
		// twice on hardware. Wording it like a generic failure sends the user looking at the
		// radio instead of at the brick in front of them.
		const { pair } = pairWith({
			lines: [FOUND, JSON.stringify({ type: 'result', status: 'AuthenticationTimeout', ok: false })],
			exitCode: 1,
		});
		const result = await pair(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /brick/i);
		assert.notEqual(result.reason, (await pairWith({
			lines: [FOUND, JSON.stringify({ type: 'result', status: 'Failed', ok: false })],
			exitCode: 1,
		}).pair(MAC)).reason);
	});

	it('passes the helper\'s own error message through', async () => {
		const { pair } = pairWith({
			lines: [JSON.stringify({ type: 'error', message: 'not a MAC address: nonsense' })],
			exitCode: 2,
		});
		const result = await pair(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /not a MAC address/);
	});
});

describe('createHelperPairing — the helper misbehaving', () => {
	it('falls back to stderr when the helper dies without saying anything', async () => {
		const { pair } = pairWith({
			lines: [],
			stderr: 'Unhandled Exception: System.IO.FileNotFoundException',
			exitCode: 2,
		});
		const result = await pair(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /FileNotFoundException/);
	});

	it('does not treat silence as success, even on exit code 0', async () => {
		// A helper that exits cleanly having reported nothing has not paired anything. Reading
		// the exit code alone would call this a success and leave the caller believing a brick
		// is paired that is not.
		const { pair } = pairWith({ lines: [], exitCode: 0 });
		const result = await pair(MAC);
		assert.equal(result.ok, false);
	});

	it('ignores a malformed line and keeps reading the ones after it', async () => {
		const { pair } = pairWith({
			lines: [FOUND, '{ this is not json', JSON.stringify({ type: 'result', status: 'Paired', ok: true })],
			exitCode: 0,
		});
		assert.deepEqual(await pair(MAC), { ok: true });
	});

	it('kills a helper that never exits, and says so', async () => {
		const { fake, pair } = pairWith(
			{ lines: [FOUND], neverExits: true },
			{ killAfterMs: 50 }
		);
		const result = await pair(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /timed out/i);
		assert.equal(fake.killCount(), 1);
	});
});

describe('createHelperPairing — host and process wiring', () => {
	it('reports a missing helper as a backend problem, not a pairing failure', async () => {
		// ENOENT means the extension shipped without its helper, or the path is wrong. That is
		// an install fault and reads differently from "the brick refused" — the caller should
		// be able to tell them apart rather than showing a user a pairing error.
		const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
		const { pair } = pairWith({ throwOnSpawn: enoent });
		await assert.rejects(() => pair(MAC), BackendUnavailableError);
	});

	it('passes the mac, pin and windows through to the helper', async () => {
		const { fake, pair } = pairWith(
			{ lines: [JSON.stringify({ type: 'result', status: 'Paired', ok: true })], exitCode: 0 },
			{ pin: '9999', inquirySeconds: 20 }
		);
		await pair(MAC);
		assert.equal(fake.lastCommand(), HELPER);
		const args = fake.lastArgs() ?? [];
		assert.deepEqual(args.slice(args.indexOf('--mac'), args.indexOf('--mac') + 2), ['--mac', MAC]);
		assert.deepEqual(args.slice(args.indexOf('--pin'), args.indexOf('--pin') + 2), ['--pin', '9999']);
		assert.deepEqual(
			args.slice(args.indexOf('--inquiry-seconds'), args.indexOf('--inquiry-seconds') + 2),
			['--inquiry-seconds', '20']
		);
	});

	it('reports events in the order the helper emitted them', async () => {
		// The UI prompt hangs off this. `found` with alreadyPaired:false is the moment to tell
		// the user to look at the brick — by `pairingRequested` the brick is already asking.
		const seen: BtPairingEvent[] = [];
		const { pair } = pairWith(
			{
				lines: [
					JSON.stringify({ type: 'searching', mac: MAC }),
					FOUND,
					PAIRING_REQUESTED,
					JSON.stringify({ type: 'result', status: 'Paired', ok: true }),
				],
				exitCode: 0,
			},
			{ onEvent: (event) => seen.push(event) }
		);
		await pair(MAC);
		assert.deepEqual(seen.map((event) => event.type), [
			'searching', 'found', 'pairingRequested', 'result',
		]);
	});

	it('forwards a line type it has never heard of rather than throwing', async () => {
		// The helper is ours and will grow fields. A wrapper that rejects unknown types turns
		// every future helper change into a breaking one.
		const seen: BtPairingEvent[] = [];
		const { pair } = pairWith(
			{
				lines: [
					JSON.stringify({ type: 'somethingNew', detail: 42 }),
					JSON.stringify({ type: 'result', status: 'Paired', ok: true }),
				],
				exitCode: 0,
			},
			{ onEvent: (event) => seen.push(event) }
		);
		assert.deepEqual(await pair(MAC), { ok: true });
		assert.equal(seen[0].type, 'somethingNew');
	});
});

// ════════════════════════════════════════════════════════════════════
// Scanning
// ════════════════════════════════════════════════════════════════════

const device = (over: Record<string, unknown> = {}) => JSON.stringify({
	type: 'device', mac: '00:16:53:51:87:39', name: 'BBB', paired: false, signal: -40, atMs: 100,
	...over,
});

function scanWith(run: FakeRun, over: Partial<Parameters<typeof scanForBricks>[0]> = {}) {
	const fake = fakeSpawn(run);
	const scan = scanForBricks({ helperPath: HELPER, spawn: fake.spawn, ...over });
	return { fake, scan };
}

describe('scanForBricks', () => {
	it('reports the bricks the helper saw', async () => {
		const { scan } = scanWith({
			lines: [
				device({ mac: '00:16:53:51:87:39', name: 'BBB', paired: true, signal: -35 }),
				device({ mac: '00:16:53:42:D9:F2', name: 'CCC', paired: false, signal: -43 }),
				JSON.stringify({ type: 'scanComplete', count: 2, atMs: 20000 }),
			],
			exitCode: 0,
		});
		const bricks = await scan.done;
		assert.deepEqual(bricks.map((b) => b.name), ['BBB', 'CCC']);
		assert.equal(bricks[0].paired, true);
		assert.equal(bricks[1].signal, -43);
	});

	it('records what is visible and sorts nothing', async () => {
		// Ordering is a question about the person looking at the screen, not about the radio.
		// The UI sorts — by signal, so the brick someone is carrying rises to the top as they
		// walk over, or however else that screen needs it. This layer only owes an accurate
		// record, in the order it learned it.
		const { scan } = scanWith({
			lines: [
				device({ mac: '00:16:53:00:00:01', name: 'weak-unpaired', paired: false, signal: -80 }),
				device({ mac: '00:16:53:00:00:02', name: 'strong-unpaired', paired: false, signal: -20 }),
				device({ mac: '00:16:53:00:00:03', name: 'paired', paired: true, signal: -90 }),
			],
			exitCode: 0,
		});
		assert.deepEqual((await scan.done).map((b) => b.name),
			['weak-unpaired', 'strong-unpaired', 'paired']);
	});

	it('drops anything that is not a brick', async () => {
		// The radio hears headphones and phones too. A picker that offers them is a bug.
		const { scan } = scanWith({
			lines: [
				device({ mac: '13:82:B1:7F:FC:2A', name: 'GOGHBTM45', paired: true }),
				device({ mac: '00:16:53:51:87:39', name: 'BBB' }),
			],
			exitCode: 0,
		}, { ouiFilter: '001653' });
		assert.deepEqual((await scan.done).map((b) => b.name), ['BBB']);
	});

	it('follows a brick that moves and one that leaves', async () => {
		// The list is a live view: bricks are switched on and off and carried out of range
		// while somebody is looking at it.
		const snapshots: string[][] = [];
		const { scan } = scanWith({
			lines: [
				device({ mac: '00:16:53:00:00:01', name: 'stays', signal: -70 }),
				device({ mac: '00:16:53:00:00:02', name: 'leaves', signal: -30 }),
				JSON.stringify({ type: 'deviceUpdated', mac: '00:16:53:00:00:01', signal: -10, atMs: 900 }),
				JSON.stringify({ type: 'deviceLost', mac: '00:16:53:00:00:02', atMs: 1000 }),
			],
			exitCode: 0,
		}, { onChange: (bricks: ScannedBrick[]) => snapshots.push(bricks.map((b) => b.name)) });

		const final = await scan.done;
		assert.deepEqual(final.map((b) => b.name), ['stays']);
		assert.equal(final[0].signal, -10);
		// The list was offered as it changed, not only at the end.
		assert.deepEqual(snapshots[0], ['stays']);
		assert.deepEqual(snapshots[snapshots.length - 1], ['stays']);
		assert.ok(snapshots.length >= 4, `expected a snapshot per change, got ${snapshots.length}`);
	});

	it('stops the helper when the caller has seen enough', async () => {
		// Someone picks their brick the moment it appears, usually seconds before the window
		// closes. Leaving the helper scanning would hold the radio against the connect that
		// follows.
		const { fake, scan } = scanWith({ lines: [device({ name: 'BBB' })], neverExits: true });
		await new Promise((resolve) => setTimeout(resolve, 20));
		scan.cancel();

		assert.deepEqual((await scan.done).map((b) => b.name), ['BBB']);
		assert.equal(fake.killCount(), 1);
	});

	it('says how many it found when the scan ends on its own', async () => {
		let reported: number | undefined;
		const { scan } = scanWith({
			lines: [device(), JSON.stringify({ type: 'scanComplete', count: 1, atMs: 20000 })],
			exitCode: 0,
		}, { onComplete: (count: number) => { reported = count; } });
		await scan.done;
		assert.equal(reported, 1);
	});
});
