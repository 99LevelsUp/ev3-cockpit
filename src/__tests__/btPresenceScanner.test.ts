import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub vscode before importing the scanner
const disposableInstances: Array<{ callback: () => void }> = [];
const vscodeStub = {
	Disposable: class {
		constructor(public callback: () => void) {
			disposableInstances.push(this);
		}
		dispose(): void {
			this.callback();
		}
	}
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad.call(this, request, parent, isMain);
};

import { createBtPresenceScanner } from '../activation/btPresenceScanner';
import type { BluetoothCandidate } from '../transport/discovery';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('btPresenceScanner', () => {
	let connectedBricks: string[];
	let disconnectedBricks: string[];
	let upsertedProfiles: Array<{ brickId: string; displayName: string }>;
	let scanResults: BluetoothCandidate[];
	let snapshotList: Array<{ brickId: string; transport: string; status: string }>;

	function makeOptions(overrides?: Partial<{
		fastIntervalMs: number;
		slowIntervalMs: number;
	}>) {
		connectedBricks = [];
		disconnectedBricks = [];
		upsertedProfiles = [];
		snapshotList = [];

		return {
			listBluetoothCandidates: async () => scanResults,
			brickRegistry: {
				getSnapshot: (id: string) =>
					snapshotList.find((s) => s.brickId === id) as { status: string; transport: string } | undefined,
				listSnapshots: () => snapshotList
			},
			profileStore: {
				upsert: async (p: { brickId: string; displayName: string }) => {
					upsertedProfiles.push(p);
				}
			},
			logger: { info: () => {}, warn: () => {}, error: () => {} },
			fastIntervalMs: overrides?.fastIntervalMs ?? 50,
			slowIntervalMs: overrides?.slowIntervalMs ?? 200,
			resolveDefaultRootPath: () => '/home/root/lms2012/prjs/',
			toSafeIdentifier: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_'),
			resolveActivateOnConnect: () => true,
			connectBrick: async (brickId: string) => {
				connectedBricks.push(brickId);
			},
			disconnectBrick: async (brickId: string) => {
				disconnectedBricks.push(brickId);
			}
		};
	}

	beforeEach(() => {
		scanResults = [];
		disposableInstances.length = 0;
	});

	it('should connect detected BT brick on first scan', async () => {
		scanResults = [{ path: 'COM5', mac: '001653aabb01', displayName: 'EV3', hasLegoPrefix: true }];
		const opts = makeOptions();
		const disposable = createBtPresenceScanner(opts as never);

		await delay(100);
		disposable.dispose();

		assert.ok(connectedBricks.includes('bt-001653aabb01'), 'Expected bt-001653aabb01 to be connected');
		assert.ok(upsertedProfiles.length >= 1);
		assert.equal(upsertedProfiles[0].brickId, 'bt-001653aabb01');
	});

	it('should use COM path as fallback brickId when no MAC', async () => {
		scanResults = [{ path: 'COM7', mac: undefined, displayName: undefined, hasLegoPrefix: false }];
		const opts = makeOptions();
		const disposable = createBtPresenceScanner(opts as never);

		await delay(100);
		disposable.dispose();

		assert.ok(connectedBricks.includes('bt-COM7'));
	});

	it('should not reconnect already-connected bricks', async () => {
		scanResults = [{ path: 'COM5', mac: '001653aabb01', displayName: 'EV3', hasLegoPrefix: true }];
		const opts = makeOptions();
		snapshotList = [{ brickId: 'bt-001653aabb01', transport: 'bt', status: 'READY' }];
		const disposable = createBtPresenceScanner(opts as never);

		await delay(100);
		disposable.dispose();

		assert.equal(connectedBricks.length, 0, 'Should not connect already-READY brick');
	});

	it('should disconnect BT bricks that disappear', async () => {
		scanResults = [];
		const opts = makeOptions();
		snapshotList = [{ brickId: 'bt-001653aabb01', transport: 'bt', status: 'READY' }];
		const disposable = createBtPresenceScanner(opts as never);

		await delay(100);
		disposable.dispose();

		assert.ok(disconnectedBricks.includes('bt-001653aabb01'));
	});

	it('should not disconnect non-BT bricks', async () => {
		scanResults = [];
		const opts = makeOptions();
		snapshotList = [{ brickId: 'usb-some-path', transport: 'usb', status: 'READY' }];
		const disposable = createBtPresenceScanner(opts as never);

		await delay(100);
		disposable.dispose();

		assert.equal(disconnectedBricks.length, 0);
	});

	it('should use fast interval when BT candidates found', async () => {
		let scanCount = 0;
		const opts = makeOptions({ fastIntervalMs: 30, slowIntervalMs: 500 });
		opts.listBluetoothCandidates = async () => {
			scanCount++;
			return [{ path: 'COM5', mac: '001653aabb01', displayName: 'EV3', hasLegoPrefix: true }];
		};
		// Mark as READY so no connect calls pile up
		snapshotList = [{ brickId: 'bt-001653aabb01', transport: 'bt', status: 'READY' }];
		const disposable = createBtPresenceScanner(opts as never);

		await delay(200);
		disposable.dispose();

		// With 30ms fast interval and 200ms wait, should scan multiple times
		assert.ok(scanCount >= 3, `Expected at least 3 scans, got ${scanCount}`);
	});

	it('should use slow interval when no BT candidates', async () => {
		let scanCount = 0;
		const opts = makeOptions({ fastIntervalMs: 10, slowIntervalMs: 150 });
		opts.listBluetoothCandidates = async () => {
			scanCount++;
			return [];
		};
		const disposable = createBtPresenceScanner(opts as never);

		await delay(250);
		disposable.dispose();

		// With 150ms slow interval and 250ms wait, should scan ~2 times
		assert.ok(scanCount <= 4, `Expected at most 4 scans (slow interval), got ${scanCount}`);
	});

	it('should handle scan errors gracefully', async () => {
		let errorCount = 0;
		const opts = makeOptions({ slowIntervalMs: 30 });
		opts.listBluetoothCandidates = async () => {
			errorCount++;
			throw new Error('COM port access denied');
		};
		const disposable = createBtPresenceScanner(opts as never);

		await delay(150);
		disposable.dispose();

		// Should have retried despite errors
		assert.ok(errorCount >= 2, `Expected at least 2 error attempts, got ${errorCount}`);
	});

	it('should stop scanning after dispose', async () => {
		let scanCount = 0;
		const opts = makeOptions({ fastIntervalMs: 20, slowIntervalMs: 20 });
		opts.listBluetoothCandidates = async () => {
			scanCount++;
			return [];
		};
		const disposable = createBtPresenceScanner(opts as never);

		await delay(80);
		disposable.dispose();
		const countAtDispose = scanCount;

		await delay(100);
		assert.equal(scanCount, countAtDispose, 'Should not scan after dispose');
	});

	it('should skip empty COM paths', async () => {
		scanResults = [{ path: '  ', mac: '001653aabb01', displayName: 'EV3', hasLegoPrefix: true }];
		const opts = makeOptions();
		const disposable = createBtPresenceScanner(opts as never);

		await delay(100);
		disposable.dispose();

		assert.equal(connectedBricks.length, 0, 'Should skip candidate with blank path');
	});
});
