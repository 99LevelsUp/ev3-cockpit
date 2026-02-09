import assert from 'node:assert/strict';
import test from 'node:test';
import { BrickSessionManager, BrickRuntimeSession } from '../device/brickSessionManager';

interface FakeScheduler {
	state: string;
	queueSize: number;
	disposed: boolean;
	getState(): string;
	getQueueSize(): number;
	dispose(): void;
}

interface FakeClient {
	closed: boolean;
	close(): Promise<void>;
}

function createFakeSession(brickId: string, state = 'idle', queueSize = 0): BrickRuntimeSession<FakeScheduler, FakeClient> {
	const scheduler: FakeScheduler = {
		state,
		queueSize,
		disposed: false,
		getState() {
			return this.state;
		},
		getQueueSize() {
			return this.queueSize;
		},
		dispose() {
			this.disposed = true;
		}
	};
	const commandClient: FakeClient = {
		closed: false,
		async close() {
			this.closed = true;
		}
	};
	return {
		brickId,
		scheduler,
		commandClient
	};
}

test('BrickSessionManager prepareSession replaces old session and closes it', async () => {
	let createCount = 0;
	const sessions: Array<BrickRuntimeSession<FakeScheduler, FakeClient>> = [];
	const manager = new BrickSessionManager<FakeScheduler, FakeClient>((brickId) => {
		createCount += 1;
		const session = createFakeSession(brickId);
		sessions.push(session);
		return session;
	});

	await manager.prepareSession('usb-auto');
	await manager.prepareSession('usb-auto');

	assert.equal(createCount, 2);
	assert.equal(sessions[0].scheduler.disposed, true);
	assert.equal(sessions[0].commandClient.closed, true);
	assert.equal(sessions[1].scheduler.disposed, false);
	assert.equal(sessions[1].commandClient.closed, false);
	assert.equal(manager.isSessionAvailable('usb-auto'), true);
});

test('BrickSessionManager runtime snapshot includes busy in-flight command', async () => {
	const manager = new BrickSessionManager<FakeScheduler, FakeClient>((brickId) =>
		createFakeSession(brickId, 'running', 2)
	);
	await manager.prepareSession('tcp-a');

	const snapshot = manager.getRuntimeSnapshot('tcp-a');
	assert.ok(snapshot);
	assert.equal(snapshot?.schedulerState, 'running');
	assert.equal(snapshot?.queuedCommands, 2);
	assert.equal(snapshot?.busyCommandCount, 3);
});

test('BrickSessionManager tracks and clears program sessions per brick', () => {
	const manager = new BrickSessionManager<FakeScheduler, FakeClient>((brickId) => createFakeSession(brickId));

	manager.markProgramStarted('brick-a', '/home/root/lms2012/prjs/a.rbf', 'run-command', 'tcp');
	manager.markProgramStarted('brick-b', '/home/root/lms2012/prjs/b.rbf', 'deploy-project-run', 'usb');

	assert.equal(manager.getLastRunProgramPath('brick-a'), '/home/root/lms2012/prjs/a.rbf');
	assert.equal(manager.getRestartCandidatePath('brick-b'), '/home/root/lms2012/prjs/b.rbf');

	const singleClear = manager.clearProgramSession('brick-a');
	assert.equal(singleClear?.scope, 'single');
	assert.equal(singleClear?.brickId, 'brick-a');
	assert.equal(manager.getLastRunProgramPath('brick-a'), undefined);
	assert.equal(manager.getLastRunProgramPath('brick-b'), '/home/root/lms2012/prjs/b.rbf');

	const allClear = manager.clearProgramSession();
	assert.equal(allClear?.scope, 'all');
	assert.equal(manager.getLastRunProgramPath('brick-b'), undefined);
});

test('BrickSessionManager closeAllSessions disposes all runtimes', async () => {
	const created: Array<BrickRuntimeSession<FakeScheduler, FakeClient>> = [];
	const manager = new BrickSessionManager<FakeScheduler, FakeClient>((brickId) => {
		const session = createFakeSession(brickId);
		created.push(session);
		return session;
	});

	await manager.prepareSession('brick-a');
	await manager.prepareSession('brick-b');
	await manager.closeAllSessions();

	assert.equal(manager.isSessionAvailable('brick-a'), false);
	assert.equal(manager.isSessionAvailable('brick-b'), false);
	assert.equal(created.every((session) => session.scheduler.disposed), true);
	assert.equal(created.every((session) => session.commandClient.closed), true);
});
