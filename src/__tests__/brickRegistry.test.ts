import assert from 'node:assert/strict';
import test from 'node:test';
import { BrickRegistry, BrickStatusChangeEvent } from '../device/brickRegistry';

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

test('BrickRegistry.updateDisplayName updates a single brick label', () => {
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

	const updated = registry.updateDisplayName('brick-a', 'Alpha');
	assert.equal(updated?.displayName, 'Alpha');
	assert.equal(registry.getSnapshot('brick-a')?.displayName, 'Alpha');
});

test('BrickRegistry.updateDisplayNameForMatching updates all matching labels', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'usb-a',
		displayName: 'Shared',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});
	registry.upsertReady({
		brickId: 'tcp-a',
		displayName: 'Shared',
		role: 'standalone',
		transport: 'tcp',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});
	registry.upsertReady({
		brickId: 'bt-a',
		displayName: 'Other',
		role: 'standalone',
		transport: 'bt',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	const updatedIds = registry.updateDisplayNameForMatching('shared', 'Renamed').sort();
	assert.deepEqual(updatedIds, ['tcp-a', 'usb-a']);
	assert.equal(registry.getSnapshot('usb-a')?.displayName, 'Renamed');
	assert.equal(registry.getSnapshot('tcp-a')?.displayName, 'Renamed');
	assert.equal(registry.getSnapshot('bt-a')?.displayName, 'Other');
});

test('BrickRegistry.upsertAvailable creates AVAILABLE record', () => {
	const registry = new BrickRegistry();
	const snapshot = registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3 USB',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(snapshot.status, 'AVAILABLE');
	assert.equal(snapshot.isActive, false);
	assert.equal(snapshot.displayName, 'EV3 USB');
});

test('BrickRegistry.upsertAvailable does not overwrite READY brick', () => {
	const registry = new BrickRegistry();
	registry.upsertReady({
		brickId: 'usb-001',
		displayName: 'EV3 USB',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});
	const snapshot = registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3 USB Renamed',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(snapshot.status, 'READY');
	assert.equal(snapshot.displayName, 'EV3 USB Renamed');
});

test('BrickRegistry.upsertAvailable updates existing AVAILABLE', () => {
	const registry = new BrickRegistry();
	registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3 USB',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	const snapshot = registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3 USB Renamed',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(snapshot.status, 'AVAILABLE');
	assert.equal(snapshot.displayName, 'EV3 USB Renamed');
});

test('BrickRegistry.removeStale removes AVAILABLE bricks not in active set', () => {
	const registry = new BrickRegistry();
	registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3 USB 1',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	registry.upsertAvailable({
		brickId: 'usb-002',
		displayName: 'EV3 USB 2',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	registry.upsertReady({
		brickId: 'tcp-001',
		displayName: 'EV3 TCP',
		role: 'standalone',
		transport: 'tcp',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});

	const removed = registry.removeStale(new Set(['usb-001']));
	assert.deepEqual(removed, ['usb-002']);
	assert.ok(registry.getSnapshot('usb-001'));
	assert.equal(registry.getSnapshot('usb-002'), undefined);
	assert.ok(registry.getSnapshot('tcp-001'));
});

test('BrickRegistry.onStatusChange fires on status transitions', () => {
	const registry = new BrickRegistry();
	const events: BrickStatusChangeEvent[] = [];
	registry.onStatusChange((e) => events.push(e));

	registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(events.length, 1);
	assert.equal(events[0].oldStatus, undefined);
	assert.equal(events[0].newStatus, 'AVAILABLE');

	registry.upsertConnecting({
		brickId: 'usb-001',
		displayName: 'EV3',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(events.length, 2);
	assert.equal(events[1].oldStatus, 'AVAILABLE');
	assert.equal(events[1].newStatus, 'CONNECTING');

	registry.upsertReady({
		brickId: 'usb-001',
		displayName: 'EV3',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/',
		fsService: mockFs,
		controlService: mockControl
	});
	assert.equal(events.length, 3);
	assert.equal(events[2].newStatus, 'READY');

	registry.markUnavailable('usb-001', 'lost');
	assert.equal(events.length, 4);
	assert.equal(events[3].newStatus, 'UNAVAILABLE');
});

test('BrickRegistry.onStatusChange unsubscribe works', () => {
	const registry = new BrickRegistry();
	const events: BrickStatusChangeEvent[] = [];
	const unsubscribe = registry.onStatusChange((e) => events.push(e));

	registry.upsertAvailable({
		brickId: 'usb-001',
		displayName: 'EV3',
		role: 'unknown',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(events.length, 1);

	unsubscribe();
	registry.upsertConnecting({
		brickId: 'usb-001',
		displayName: 'EV3',
		role: 'standalone',
		transport: 'usb',
		rootPath: '/home/root/lms2012/prjs/'
	});
	assert.equal(events.length, 1);
});
