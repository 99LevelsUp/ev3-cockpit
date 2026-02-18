import { TransportMode } from '../types/enums';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsbReconnectCandidateAvailable, isBtReconnectCandidateAvailable } from '../device/brickReconnect';
import type { UsbReconnectDeps, BtReconnectDeps } from '../device/brickReconnect';
import type { BrickSnapshot } from '../device/brickRegistry';
import type { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import type { UsbHidCandidate, BluetoothCandidate } from '../transport/discovery';

function makeSnapshot(overrides: Partial<BrickSnapshot> = {}): BrickSnapshot {
	return {
		brickId: 'brick-1',
		displayName: 'EV3',
		role: 'standalone',
		transport: TransportMode.USB,
		rootPath: '/home/root/',
		status: 'UNAVAILABLE',
		isActive: false,
		...overrides
	};
}

function makeProfile(overrides: Partial<BrickConnectionProfile> = {}): BrickConnectionProfile {
	return {
		brickId: 'brick-1',
		displayName: 'EV3',
		savedAtIso: new Date().toISOString(),
		rootPath: '/home/root/',
		transport: { mode: TransportMode.USB, usbPath: '/dev/usb0' },
		...overrides
	};
}

function makeDeps(options: {
	snapshot?: BrickSnapshot | undefined;
	profile?: BrickConnectionProfile | undefined;
	candidates?: UsbHidCandidate[];
	upsertCalls?: BrickConnectionProfile[];
}): UsbReconnectDeps {
	const upsertCalls = options.upsertCalls ?? [];
	return {
		brickRegistry: {
			getSnapshot: () => options.snapshot
		} as never,
		profileStore: {
			get: () => options.profile,
			upsert: async (p: BrickConnectionProfile) => { upsertCalls.push(p); }
		} as never,
		listUsbHidCandidates: async () => options.candidates ?? []
	};
}

test('returns false if snapshot is missing', async () => {
	const deps = makeDeps({ snapshot: undefined, profile: makeProfile() });
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

test('returns false if transport is not usb', async () => {
	const deps = makeDeps({
		snapshot: makeSnapshot({ transport: TransportMode.TCP }),
		profile: makeProfile()
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

test('returns false if profile is missing', async () => {
	const deps = makeDeps({ snapshot: makeSnapshot(), profile: undefined });
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

test('returns false if profile transport mode is not usb', async () => {
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile({ transport: { mode: TransportMode.TCP } })
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

test('returns false if no USB candidates', async () => {
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile(),
		candidates: []
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

test('returns true if configured path matches a candidate', async () => {
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile({ transport: { mode: TransportMode.USB, usbPath: '/dev/usb0' } }),
		candidates: [{ path: '/dev/usb0' }, { path: '/dev/usb1' }]
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), true);
});

test('returns true if no configured path and exactly 1 candidate, updates profile', async () => {
	const upsertCalls: BrickConnectionProfile[] = [];
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile({ transport: { mode: TransportMode.USB, usbPath: '' } }),
		candidates: [{ path: '/dev/usb99' }],
		upsertCalls
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), true);
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].transport.usbPath, '/dev/usb99');
});

test('returns false if no configured path and multiple candidates', async () => {
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile({ transport: { mode: TransportMode.USB, usbPath: '' } }),
		candidates: [{ path: '/dev/usb0' }, { path: '/dev/usb1' }]
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

// ── BT Reconnect Tests ─────────────────────────────────────────────

function makeBtSnapshot(overrides: Partial<BrickSnapshot> = {}): BrickSnapshot {
	return {
		brickId: 'bt-001653aabb01',
		displayName: 'EV3 BT',
		role: 'standalone',
		transport: TransportMode.BT,
		rootPath: '/home/root/',
		status: 'UNAVAILABLE',
		isActive: false,
		...overrides
	};
}

function makeBtProfile(overrides: Partial<BrickConnectionProfile> = {}): BrickConnectionProfile {
	return {
		brickId: 'bt-001653aabb01',
		displayName: 'EV3 BT',
		savedAtIso: new Date().toISOString(),
		rootPath: '/home/root/',
		transport: { mode: TransportMode.BT, btPortPath: 'COM5' },
		...overrides
	};
}

function makeBtDeps(options: {
	snapshot?: BrickSnapshot | undefined;
	profile?: BrickConnectionProfile | undefined;
	candidates?: BluetoothCandidate[];
	upsertCalls?: BrickConnectionProfile[];
}): BtReconnectDeps {
	const upsertCalls = options.upsertCalls ?? [];
	return {
		brickRegistry: {
			getSnapshot: () => options.snapshot
		} as never,
		profileStore: {
			get: () => options.profile,
			upsert: async (p: BrickConnectionProfile) => { upsertCalls.push(p); }
		} as never,
		listBluetoothCandidates: async () => options.candidates ?? []
	};
}

test('BT reconnect: returns false if snapshot is missing', async () => {
	const deps = makeBtDeps({ snapshot: undefined, profile: makeBtProfile() });
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), false);
});

test('BT reconnect: returns false if transport is not bt', async () => {
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot({ transport: TransportMode.USB }),
		profile: makeBtProfile()
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), false);
});

test('BT reconnect: returns false if profile is missing', async () => {
	const deps = makeBtDeps({ snapshot: makeBtSnapshot(), profile: undefined });
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), false);
});

test('BT reconnect: returns false if no BT candidates', async () => {
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile(),
		candidates: []
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), false);
});

test('BT reconnect: returns true when MAC matches candidate', async () => {
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile(),
		candidates: [{ path: 'COM5', mac: '001653aabb01', displayName: 'EV3', hasLegoPrefix: true }]
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), true);
});

test('BT reconnect: updates profile when MAC matches but COM path changed', async () => {
	const upsertCalls: BrickConnectionProfile[] = [];
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile({ transport: { mode: TransportMode.BT, btPortPath: 'COM5' } }),
		candidates: [{ path: 'COM8', mac: '001653aabb01', displayName: 'EV3', hasLegoPrefix: true }],
		upsertCalls
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), true);
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].transport.btPortPath, 'COM8');
});

test('BT reconnect: falls back to configured COM path match', async () => {
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot({ brickId: 'bt-COM5' }),
		profile: makeBtProfile({ brickId: 'bt-COM5', transport: { mode: TransportMode.BT, btPortPath: 'COM5' } }),
		candidates: [{ path: 'COM5', mac: undefined, displayName: undefined, hasLegoPrefix: false }]
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-COM5'), true);
});

test('BT reconnect: uses single candidate when no match found', async () => {
	const upsertCalls: BrickConnectionProfile[] = [];
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot({ brickId: 'bt-COM5' }),
		profile: makeBtProfile({ brickId: 'bt-COM5', transport: { mode: TransportMode.BT, btPortPath: 'COM5' } }),
		candidates: [{ path: 'COM9', mac: undefined, displayName: undefined, hasLegoPrefix: false }],
		upsertCalls
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-COM5'), true);
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].transport.btPortPath, 'COM9');
});

test('BT reconnect: returns false when multiple candidates and no match', async () => {
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot({ brickId: 'bt-COM5' }),
		profile: makeBtProfile({ brickId: 'bt-COM5', transport: { mode: TransportMode.BT, btPortPath: 'COM5' } }),
		candidates: [
			{ path: 'COM7', mac: undefined, displayName: undefined, hasLegoPrefix: false },
			{ path: 'COM9', mac: undefined, displayName: undefined, hasLegoPrefix: false }
		]
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-COM5'), false);
});
