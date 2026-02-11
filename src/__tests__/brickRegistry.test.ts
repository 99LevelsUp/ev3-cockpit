import assert from 'node:assert/strict';
import test from 'node:test';
import { BrickRegistry } from '../device/brickRegistry';

const mockFs = { listDirectory: async () => ({ folders: [], files: [], path: '/', truncated: false, totalBytes: 0 }) } as never;
const mockControl = { emergencyStopAll: async () => undefined } as never;

test('BrickRegistry tracks active brick and active alias resolution', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'usb-auto',
		displayName: 'EV3 USB',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	assert.equal(registry.getActiveBrickId(), 'usb-auto');
	assert.equal(registry.resolveFsService('active'), mockFs);
	assert.equal(registry.resolveFsService('usb-auto'), mockFs);

	registry.markActiveUnavailable('disconnect');
	assert.equal(registry.getActiveBrickId(), undefined);
	assert.equal(registry.resolveFsService('active'), undefined);

	const snapshot = registry.getSnapshot('usb-auto');
	assert.ok(snapshot);
	assert.equal(snapshot?.status, 'UNAVAILABLE');
	assert.equal(snapshot?.isActive, false);
});

test('BrickRegistry preserves known bricks and sorts active first', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'tcp-active',
		displayName: 'EV3 TCP',
		role: 'standalone',
		transport: 'tcp',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});
	registry.markUnavailable('tcp-active', 'offline');
	registry.upsertReady({
		brickId: 'usb-auto',
		displayName: 'EV3 USB',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	const snapshots = registry.listSnapshots();
	assert.equal(snapshots.length, 2);
	assert.equal(snapshots[0].brickId, 'usb-auto');
	assert.equal(snapshots[0].isActive, true);
	assert.equal(snapshots[1].brickId, 'tcp-active');
	assert.equal(snapshots[1].status, 'UNAVAILABLE');
});

test('BrickRegistry updates runtime metrics for tree busy indicators', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'tcp-active',
		displayName: 'EV3 TCP',
		role: 'standalone',
		transport: 'tcp',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	registry.updateRuntimeMetrics('tcp-active', {
		busyCommandCount: 2,
		schedulerState: 'running'
	});
	const snapshot = registry.getSnapshot('tcp-active');
	assert.equal(snapshot?.busyCommandCount, 2);
	assert.equal(snapshot?.schedulerState, 'running');

	registry.markUnavailable('tcp-active', 'disconnect');
	const unavailable = registry.getSnapshot('tcp-active');
	assert.equal(unavailable?.busyCommandCount, 0);
	assert.equal(unavailable?.schedulerState, undefined);
});

test('BrickRegistry stores last operation metadata', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'usb-auto',
		displayName: 'EV3 USB',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	registry.noteOperation('usb-auto', 'Deploy sync completed');
	const snapshot = registry.getSnapshot('usb-auto');
	assert.equal(snapshot?.lastOperation, 'Deploy sync completed');
	assert.ok(snapshot?.lastOperationAtIso);
});

test('BrickRegistry.setActiveBrick switches active brick', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'brick-a',
		displayName: 'EV3 A',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});
	registry.upsertReady({
		brickId: 'brick-b',
		displayName: 'EV3 B',
		role: 'standalone',
		transport: 'tcp',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	// brick-b is active (last registered)
	assert.equal(registry.getActiveBrickId(), 'brick-b');

	// switch to brick-a
	const changed = registry.setActiveBrick('brick-a');
	assert.equal(changed, true);
	assert.equal(registry.getActiveBrickId(), 'brick-a');

	// verify isActive flags
	const snapA = registry.getSnapshot('brick-a');
	const snapB = registry.getSnapshot('brick-b');
	assert.equal(snapA?.isActive, true);
	assert.equal(snapB?.isActive, false);

	// active alias resolves to new active
	assert.equal(registry.resolveFsService('active'), mockFs);
});

test('BrickRegistry.setActiveBrick returns false for unknown brick', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'brick-a',
		displayName: 'EV3 A',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	const result = registry.setActiveBrick('nonexistent');
	assert.equal(result, false);
	// active brick unchanged
	assert.equal(registry.getActiveBrickId(), 'brick-a');
});
