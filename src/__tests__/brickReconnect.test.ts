import { TransportMode } from '../types/enums';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsbReconnectCandidateAvailable, isBtReconnectCandidateAvailable } from '../device/brickReconnect';
import type { UsbReconnectDeps, BtReconnectDeps } from '../device/brickReconnect';
import type { BrickSnapshot } from '../device/brickRegistry';
import type { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import type { PresenceRecord } from '../presence/presenceSource';

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

function makeFakeAggregator(liveRecords: Map<string, PresenceRecord> = new Map()) {
	return {
		hasLiveCandidate: (id: string) => liveRecords.has(id),
		getLiveRecord: (id: string) => liveRecords.get(id)
	};
}

function makeDeps(options: {
	snapshot?: BrickSnapshot | undefined;
	profile?: BrickConnectionProfile | undefined;
	liveRecords?: Map<string, PresenceRecord>;
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
		presenceAggregator: makeFakeAggregator(options.liveRecords ?? new Map()) as never
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

test('returns false if no live USB candidate in aggregator', async () => {
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile(),
		liveRecords: new Map()
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), false);
});

test('returns true if live USB candidate exists in aggregator', async () => {
	const liveRecords = new Map<string, PresenceRecord>([
		['brick-1', {
			candidateId: 'brick-1',
			transport: TransportMode.USB,
			displayName: 'EV3 USB',
			detail: '/dev/usb0',
			connectable: true,
			lastSeenMs: Date.now(),
			connectionParams: { mode: 'usb', usbPath: '/dev/usb0' }
		}]
	]);
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile({ transport: { mode: TransportMode.USB, usbPath: '/dev/usb0' } }),
		liveRecords
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), true);
});

test('returns true and updates profile when live USB path differs', async () => {
	const upsertCalls: BrickConnectionProfile[] = [];
	const liveRecords = new Map<string, PresenceRecord>([
		['brick-1', {
			candidateId: 'brick-1',
			transport: TransportMode.USB,
			displayName: 'EV3 USB',
			detail: '/dev/usb99',
			connectable: true,
			lastSeenMs: Date.now(),
			connectionParams: { mode: 'usb', usbPath: '/dev/usb99' }
		}]
	]);
	const deps = makeDeps({
		snapshot: makeSnapshot(),
		profile: makeProfile({ transport: { mode: TransportMode.USB, usbPath: '/dev/usb0' } }),
		liveRecords,
		upsertCalls
	});
	assert.equal(await isUsbReconnectCandidateAvailable(deps, 'brick-1'), true);
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].transport.usbPath, '/dev/usb99');
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
	liveRecords?: Map<string, PresenceRecord>;
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
		presenceAggregator: makeFakeAggregator(options.liveRecords ?? new Map()) as never
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

test('BT reconnect: returns false if no live BT candidate in aggregator', async () => {
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile(),
		liveRecords: new Map()
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), false);
});

test('BT reconnect: returns true when live connectable candidate exists', async () => {
	const liveRecords = new Map<string, PresenceRecord>([
		['bt-001653aabb01', {
			candidateId: 'bt-001653aabb01',
			transport: TransportMode.BT,
			displayName: 'EV3 BT',
			detail: 'COM5 | 001653AABB01',
			connectable: true,
			lastSeenMs: Date.now(),
			mac: '001653aabb01',
			connectionParams: { mode: 'bt', btPortPath: 'COM5', mac: '001653aabb01' }
		}]
	]);
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile(),
		liveRecords
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), true);
});

test('BT reconnect: updates profile when COM path changed', async () => {
	const upsertCalls: BrickConnectionProfile[] = [];
	const liveRecords = new Map<string, PresenceRecord>([
		['bt-001653aabb01', {
			candidateId: 'bt-001653aabb01',
			transport: TransportMode.BT,
			displayName: 'EV3 BT',
			detail: 'COM8 | 001653AABB01',
			connectable: true,
			lastSeenMs: Date.now(),
			mac: '001653aabb01',
			connectionParams: { mode: 'bt', btPortPath: 'COM8', mac: '001653aabb01' }
		}]
	]);
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile({ transport: { mode: TransportMode.BT, btPortPath: 'COM5' } }),
		liveRecords,
		upsertCalls
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), true);
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].transport.btPortPath, 'COM8');
});

test('BT reconnect: returns false when live candidate is not connectable', async () => {
	const liveRecords = new Map<string, PresenceRecord>([
		['bt-001653aabb01', {
			candidateId: 'bt-001653aabb01',
			transport: TransportMode.BT,
			displayName: 'EV3 BT',
			detail: 'BT live-only | 001653AABB01',
			connectable: false,
			lastSeenMs: Date.now(),
			mac: '001653aabb01',
			connectionParams: { mode: 'bt', btPortPath: undefined, mac: '001653aabb01' }
		}]
	]);
	const deps = makeBtDeps({
		snapshot: makeBtSnapshot(),
		profile: makeBtProfile(),
		liveRecords
	});
	assert.equal(await isBtReconnectCandidateAvailable(deps, 'bt-001653aabb01'), false);
});
