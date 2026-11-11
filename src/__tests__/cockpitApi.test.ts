/**
 * The public API object (step-5 plan, U6): what other extensions get from `activate()`.
 *
 * Pinned here against narrow fakes of the brick layer: `'active'` resolved at the call (KD1),
 * answers naming the brick by id, the access mode enforced on every change (KD2, KD3), plain
 * data out, and a consumer's subscriptions ending with it (R8). The whole runtime with the mock
 * brick is exercised in U7.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickId, BrickResponse, ChannelState, Transport, makeBrickKey } from '../contracts';
import type { BrickEntry } from '../contracts';
import { ErrorCode } from '../errors/CockpitError';
import type { AccessMode } from '../api/accessPolicy';
import { API_VERSION, CockpitApiDeps, createCockpitApi } from '../api/cockpitApi';

const A = 'A1' as BrickId;
const B = 'B1' as BrickId;

function entry(brickId: BrickId, name: string): BrickEntry {
	return {
		brickId, name: { value: name, source: 'brick', confirmed: true }, paired: true, remembered: false, favorite: false,
		lastSeenAt: 1, channels: [{ brickKey: makeBrickKey(Transport.USB, brickId), transport: Transport.USB, priority: 30, state: ChannelState.Connected, lastSeenAt: 1 }],
	} as BrickEntry;
}

function fakes(mode: AccessMode = 'safe') {
	const sent: { brickId: BrickId; command: BrickCommand }[] = [];
	const logged: string[] = [];
	let active: BrickId | undefined = A;
	let accessMode = mode;
	const listListeners = new Set<() => void>();
	const modeListeners = new Set<(m: AccessMode) => void>();
	const connected: BrickId[] = [];
	const signedOut: BrickId[] = [];
	const answer = (command: BrickCommand): BrickResponse => {
		switch (command.kind) {
		case 'program:status': return { kind: 'program:status', running: false, status: 0x40 };
		case 'system:run': return { kind: 'system:run', status: 0 };
		case 'fs:makeDirectory': return { kind: 'fs:makeDirectory' } as BrickResponse;
		// A reply of the wrong kind, as a confused channel would hand back.
		case 'info': return { kind: 'battery', level: 0 };
		default: return { kind: command.kind } as BrickResponse;
		}
	};
	const deps: CockpitApiDeps = {
		bricks: {
			send: async (brickId: BrickId, command: BrickCommand) => { sent.push({ brickId, command }); return answer(command); },
			getActiveBrickId: () => active,
			setActiveBrick: (brickId: BrickId) => { active = brickId; },
			signOut: async (brickId: BrickId) => { signedOut.push(brickId); },
			isSignedIn: (brickId: BrickId) => brickId === A,
			onActiveBrickChange: () => ({ dispose: () => { /* not under test */ } }),
		} as unknown as CockpitApiDeps['bricks'],
		aggregator: {
			getDiscoveryList: () => [entry(A, 'AAA'), entry(B, 'BBB')],
			getBrick: (brickId: BrickId) => [entry(A, 'AAA'), entry(B, 'BBB')].find((e) => e.brickId === brickId),
			onListChanged: (listener: () => void) => { listListeners.add(listener); return { dispose: () => { listListeners.delete(listener); } }; },
		} as unknown as CockpitApiDeps['aggregator'],
		connect: async (brickId) => { connected.push(brickId); },
		accessMode: () => accessMode,
		onAccessModeChange: (listener) => { modeListeners.add(listener); return { dispose: () => { modeListeners.delete(listener); } }; },
		log: { info: (message) => { logged.push(message); }, warn: (message) => { logged.push(message); } },
	};
	const api = createCockpitApi(deps);
	return {
		api, sent, logged, connected, signedOut,
		setActive: (id: BrickId | undefined) => { active = id; },
		setMode: (m: AccessMode) => { accessMode = m; for (const l of modeListeners) { l(m); } },
		fireList: () => { for (const l of [...listListeners]) { l(); } },
		listListenerCount: () => listListeners.size,
	};
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('Public API (step-5 U6)', () => {
	it('is versioned', () => {
		assert.equal(fakes().api.apiVersion, API_VERSION);
		assert.equal(API_VERSION, 1);
	});

	it('lists every brick as plain data, with its channels and which one is active', () => {
		const consumer = fakes().api.registerConsumer('test');

		const bricks = consumer.listBricks();

		assert.deepEqual(bricks.map((b) => [b.brickId, b.name, b.active, b.signedIn]), [['A1', 'AAA', true, true], ['B1', 'BBB', false, false]]);
		assert.deepEqual(bricks[0].channels, [{ transport: 'usb', state: 'connected' }]);
		assert.doesNotThrow(() => JSON.stringify(bricks));
	});

	it('resolves "active" when the call is made and answers with the brick\'s id', async () => {
		const f = fakes();
		const consumer = f.api.registerConsumer('test');

		const result = await consumer.isProgramRunning('active');
		f.setActive(B);
		await consumer.isProgramRunning('active');

		assert.deepEqual(result, { brickId: 'A1', running: false });
		assert.deepEqual(f.sent.map((s) => s.brickId), ['A1', 'B1']);
	});

	it('refuses "active" when no brick is active, with a typed error', async () => {
		const f = fakes();
		f.setActive(undefined);

		await assert.rejects(f.api.registerConsumer('test').isProgramRunning('active'), (error) => codeOf(error) === ErrorCode.NotConnected);
	});

	it('enforces safe mode on writes, removals, runs and the shell, and sends nothing then', async () => {
		const f = fakes('safe');
		const c = f.api.registerConsumer('test');

		await assert.rejects(c.makeDirectory(A, '/home/root/lms2012/sys/x'), (e) => codeOf(e) === ErrorCode.AccessDenied);
		await assert.rejects(c.remove(A, '/etc/x'), (e) => codeOf(e) === ErrorCode.AccessDenied);
		await assert.rejects(c.runProgram(A, '/home/root/lms2012/sys/ui/Demo.rbf'), (e) => codeOf(e) === ErrorCode.AccessDenied);
		await assert.rejects(c.runShell(A, 'ls'), (e) => codeOf(e) === ErrorCode.AccessDenied);
		await assert.rejects(c.move(A, '/home/root/lms2012/prjs/a', '/home/root/lms2012/sys/a'), (e) => codeOf(e) === ErrorCode.AccessDenied);

		assert.deepEqual(f.sent, []);
	});

	it('allows the shell in full mode, logs the command and its status', async () => {
		const f = fakes('full');

		const result = await f.api.registerConsumer('ev3-c').runShell('active', 'chmod +x /home/root/lms2012/prjs/R/prog');

		assert.deepEqual(result, { brickId: 'A1', status: 0 });
		assert.ok(f.logged.some((line) => line.includes('chmod +x /home/root/lms2012/prjs/R/prog') && line.includes('ev3-c')));
	});

	it('follows a change of the access mode', async () => {
		const f = fakes('safe');
		const c = f.api.registerConsumer('test');
		const modes: string[] = [];
		c.onAccessModeChanged((m) => { modes.push(m); });

		f.setMode('full');

		assert.equal(c.getAccessMode(), 'full');
		assert.deepEqual(modes, ['full']);
		await c.runShell(A, 'ls');
	});

	it('connects and disconnects a brick through the brick layer', async () => {
		const f = fakes();
		const c = f.api.registerConsumer('test');

		await c.connect(B);
		await c.disconnect('active');

		assert.deepEqual(f.connected, ['B1']);
		assert.deepEqual(f.signedOut, ['A1']);
	});

	it('refuses a new subscription from a consumer that has unregistered, and leaves nothing installed', () => {
		const f = fakes();
		const c = f.api.registerConsumer('test');
		c.dispose();

		assert.throws(() => c.onBricksChanged(() => { /* never */ }), (e: unknown) => codeOf(e) === ErrorCode.ConsumerFailed);
		assert.equal(f.listListenerCount(), 0);
	});

	it('refuses a brick id the cockpit does not know, before any command', async () => {
		const f = fakes();

		await assert.rejects(f.api.registerConsumer('test').isProgramRunning('no-such-brick'), (e) => codeOf(e) === ErrorCode.NotConnected);
		assert.deepEqual(f.sent, []);
	});

	it('reports an unexpected reply as a protocol error, not as a lost connection', async () => {
		const f = fakes('full');
		const c = f.api.registerConsumer('test');

		await assert.rejects(c.getBrickInfo('active'), (e) => codeOf(e) === ErrorCode.ProtocolFailed);
	});

	it('ends a consumer\'s subscriptions when it unregisters', () => {
		const f = fakes();
		const c = f.api.registerConsumer('test');
		let calls = 0;
		c.onBricksChanged(() => { calls += 1; });
		f.fireList();
		assert.equal(calls, 1);

		c.dispose();
		f.fireList();

		assert.equal(calls, 1);
		assert.equal(f.listListenerCount(), 0);
	});
});
