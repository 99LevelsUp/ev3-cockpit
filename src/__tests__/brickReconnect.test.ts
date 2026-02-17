import { TransportMode } from '../types/enums';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsbReconnectCandidateAvailable } from '../device/brickReconnect';
import type { UsbReconnectDeps } from '../device/brickReconnect';
import type { BrickSnapshot } from '../device/brickRegistry';
import type { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import type { UsbHidCandidate } from '../transport/discovery';

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
		profile: makeProfile({ transport: { mode: TransportMode.BT } })
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
