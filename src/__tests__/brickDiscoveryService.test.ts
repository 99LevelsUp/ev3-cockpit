import assert from 'node:assert/strict';
import test from 'node:test';
import { TransportMode } from '../types/enums';
import {
	BrickDiscoveryService,
	isLikelyEv3SerialCandidate,
	resolveDiscoveryTransport,
	resolveDiscoveryDetail,
	type BrickDiscoveryServiceDeps,
	type DiscoveryConfig,
	type DiscoveryTransportScanners
} from '../device/brickDiscoveryService';
import type { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import type { BrickRegistry, BrickSnapshot } from '../device/brickRegistry';
import type { BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { SerialCandidate } from '../transport/discovery';
import type { Logger } from '../diagnostics/logger';
import type { MockBrickDefinition } from '../mock/mockCatalog';

// Mock factories
function createMockBrickRegistry(snapshots: BrickSnapshot[] = []): BrickRegistry {
	return {
		getSnapshot: (brickId: string) => snapshots.find((s) => s.brickId === brickId),
		listSnapshots: () => snapshots
	} as BrickRegistry;
}

function createMockProfileStore(profiles: BrickConnectionProfile[] = []): BrickConnectionProfileStore {
	return {
		get: (brickId: string) => profiles.find((p) => p.brickId === brickId),
		list: () => profiles,
		upsert: async () => undefined
	} as unknown as BrickConnectionProfileStore;
}

function createMockScanners(
	usbCandidates: Array<{ path: string; serialNumber?: string }> = [],
	serialCandidates: SerialCandidate[] = [],
	tcpCandidates: Array<{ ip: string; port: number; name?: string; serialNumber?: string }> = []
): DiscoveryTransportScanners {
	return {
		listUsbHidCandidates: async () => usbCandidates,
		listSerialCandidates: async () => serialCandidates,
		listTcpDiscoveryCandidates: async () => tcpCandidates
	};
}

function createMockLogger(): Logger {
	return {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		debug: () => undefined,
		trace: () => undefined
	} as unknown as Logger;
}

function toSafeIdentifier(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function createDefaultConfig(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
	return {
		showMockBricks: false,
		mockBricks: [],
		tcpDiscoveryPort: 3015,
		tcpDiscoveryTimeoutMs: 1500,
		defaultRootPath: '/home/root/lms2012/prjs/',
		...overrides
	};
}

// Tests for isLikelyEv3SerialCandidate
test('isLikelyEv3SerialCandidate returns true for preferred port', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		manufacturer: 'Unknown'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate, 'COM5'), true);
});

test('isLikelyEv3SerialCandidate returns true for EV3 manufacturer', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		manufacturer: 'LEGO'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), true);
});

test('isLikelyEv3SerialCandidate returns true for MINDSTORMS in fingerprint', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		serialNumber: 'MINDSTORMS-123'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), true);
});

test('isLikelyEv3SerialCandidate returns true for _005D in fingerprint', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		pnpId: 'SOMETHING_005D'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), true);
});

test('isLikelyEv3SerialCandidate returns true for Bluetooth SPP ports', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), true);
});

test('isLikelyEv3SerialCandidate returns true for Bluetooth SPP with LEGO MAC', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_VENDOR\\001653123456_...'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), true);
});

test('isLikelyEv3SerialCandidate returns false for generic Bluetooth SPP port without EV3 hints', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_OTHER'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), false);
});

test('isLikelyEv3SerialCandidate returns false for non-EV3 serial port', () => {
	const candidate: SerialCandidate = {
		path: 'COM5',
		manufacturer: 'Generic USB',
		pnpId: 'USB\\VID_1234&PID_5678'
	};
	assert.equal(isLikelyEv3SerialCandidate(candidate), false);
});

// Tests for resolveDiscoveryTransport
test('resolveDiscoveryTransport returns USB for USB profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'usb-auto',
		displayName: 'EV3 USB',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.USB, usbPath: 'auto' }
	};
	assert.equal(resolveDiscoveryTransport('usb-auto', profile), TransportMode.USB);
});

test('resolveDiscoveryTransport returns BT for Bluetooth profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'bt-com5',
		displayName: 'EV3 BT',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.BT, btPort: 'COM5' }
	};
	assert.equal(resolveDiscoveryTransport('bt-com5', profile), TransportMode.BT);
});

test('resolveDiscoveryTransport returns TCP for TCP profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'tcp-192-168-1-100',
		displayName: 'EV3 TCP',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.TCP, tcpHost: '192.168.1.100', tcpPort: 5555 }
	};
	assert.equal(resolveDiscoveryTransport('tcp-192-168-1-100', profile), TransportMode.TCP);
});

test('resolveDiscoveryTransport returns MOCK for mock profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'mock-test',
		displayName: 'Mock EV3',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.MOCK }
	};
	assert.equal(resolveDiscoveryTransport('mock-test', profile), TransportMode.MOCK);
});

test('resolveDiscoveryTransport infers USB from brickId prefix', () => {
	assert.equal(resolveDiscoveryTransport('usb-auto', undefined), TransportMode.USB);
});

test('resolveDiscoveryTransport infers BT from brickId prefix', () => {
	assert.equal(resolveDiscoveryTransport('bt-com5', undefined), TransportMode.BT);
});

test('resolveDiscoveryTransport infers TCP from brickId prefix', () => {
	assert.equal(resolveDiscoveryTransport('tcp-192-168-1-100', undefined), TransportMode.TCP);
});

test('resolveDiscoveryTransport infers MOCK from brickId prefix', () => {
	assert.equal(resolveDiscoveryTransport('mock-test', undefined), TransportMode.MOCK);
});

test('resolveDiscoveryTransport returns unknown for unrecognized brickId', () => {
	assert.equal(resolveDiscoveryTransport('unknown-brick', undefined), 'unknown');
});

// Tests for resolveDiscoveryDetail
test('resolveDiscoveryDetail returns usbPath for USB profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'usb-auto',
		displayName: 'EV3 USB',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.USB, usbPath: 'auto' }
	};
	assert.equal(resolveDiscoveryDetail(profile), 'auto');
});

test('resolveDiscoveryDetail returns btPort for Bluetooth profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'bt-com5',
		displayName: 'EV3 BT',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.BT, btPort: 'COM5' }
	};
	assert.equal(resolveDiscoveryDetail(profile), 'COM5');
});

test('resolveDiscoveryDetail returns host:port for TCP profile', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'tcp-192-168-1-100',
		displayName: 'EV3 TCP',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.TCP, tcpHost: '192.168.1.100', tcpPort: 5555 }
	};
	assert.equal(resolveDiscoveryDetail(profile), '192.168.1.100:5555');
});

test('resolveDiscoveryDetail returns serialNumber fallback for TCP without host', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'tcp-001',
		displayName: 'EV3 TCP',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.TCP, tcpSerialNumber: 'ABC123' }
	};
	assert.equal(resolveDiscoveryDetail(profile), 'ABC123');
});

test('resolveDiscoveryDetail returns undefined for profile without details', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'mock-test',
		displayName: 'Mock EV3',
		savedAtIso: '2026-02-17T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.MOCK }
	};
	assert.equal(resolveDiscoveryDetail(profile), undefined);
});

test('resolveDiscoveryDetail returns undefined when profile is undefined', () => {
	assert.equal(resolveDiscoveryDetail(undefined), undefined);
});

// BrickDiscoveryService tests
test('BrickDiscoveryService.scan discovers USB candidates', async () => {
	const scanners = createMockScanners(
		[{ path: 'auto', serialNumber: 'SN001' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'usb-auto');
	assert.equal(candidates[0].displayName, 'EV3 USB (SN001)');
	assert.equal(candidates[0].transport, TransportMode.USB);
	assert.equal(candidates[0].detail, 'auto');
	assert.equal(candidates[0].status, 'UNKNOWN');
	assert.equal(candidates[0].alreadyConnected, false);
});

test('BrickDiscoveryService.scan discovers USB candidates without serial number', async () => {
	const scanners = createMockScanners(
		[{ path: 'hid://device-1' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].displayName, 'EV3 USB (hid://device-1)');
});

test('BrickDiscoveryService.scan discovers Bluetooth candidates', async () => {
	const scanners = createMockScanners(
		[],
		[{
			path: 'COM5',
			manufacturer: 'LEGO',
			pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...'
		}],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653abcdef');
	assert.equal(candidates[0].displayName, 'EV3 Bluetooth (COM5)');
	assert.equal(candidates[0].transport, TransportMode.BT);
	assert.equal(candidates[0].detail, 'LEGO | COM5');
	assert.equal(candidates[0].status, 'UNKNOWN');
});

test('BrickDiscoveryService.scan prefers Bluetooth friendlyName for displayName', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'bt-001653518739',
			displayName: 'OldName',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.BT, btPort: 'COM4' }
		}
	];
	const scanners = createMockScanners(
		[],
		[{
			path: 'COM4',
			manufacturer: 'Microsoft',
			friendlyName: 'BUMBLBEE',
			pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\8&2E3EE818&0&001653518739_C00000000'
		}],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		probeBtCandidatePresence: async () => true,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].displayName, 'BUMBLBEE');
});

test('BrickDiscoveryService.scan resolves Bluetooth MAC from ampersand-form pnpId', async () => {
	const scanners = createMockScanners(
		[],
		[{
			path: 'COM4',
			manufacturer: 'Microsoft',
			pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\8&2E3EE818&0&001653518739_C00000000'
		}],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => true,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653518739');
});

test('BrickDiscoveryService.scan filters non-EV3 serial ports', async () => {
	const scanners = createMockScanners(
		[],
		[{
			path: 'COM5',
			manufacturer: 'Generic USB',
			pnpId: 'USB\\VID_1234&PID_5678'
		}],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan discovers TCP candidates', async () => {
	const scanners = createMockScanners(
		[],
		[],
		[{ ip: '192.168.1.100', port: 5555, name: 'MyEV3', serialNumber: 'ABC123' }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'tcp-192-168-1-100-5555');
	// Uses discovered name since it's valid (12 chars or less)
	assert.equal(candidates[0].displayName, 'MyEV3');
	assert.equal(candidates[0].transport, TransportMode.TCP);
	assert.equal(candidates[0].detail, 'MyEV3 | SN ABC123');
	assert.equal(candidates[0].status, 'UNKNOWN');
});

test('BrickDiscoveryService.scan discovers TCP candidates without name or serialNumber', async () => {
	const scanners = createMockScanners(
		[],
		[],
		[{ ip: '192.168.1.100', port: 5555 }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].detail, '192.168.1.100:5555');
});

test('BrickDiscoveryService.scan includes mock bricks when enabled', async () => {
	const mockBricks: MockBrickDefinition[] = [
		{ brickId: 'mock-master', displayName: 'Master', role: 'master' },
		{ brickId: 'mock-slave', displayName: 'Slave', role: 'slave', parentDisplayName: 'Master' }
	];
	const scanners = createMockScanners([], [], []);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig({ showMockBricks: true, mockBricks });

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 2);
	const master = candidates.find((c) => c.candidateId === 'mock-master');
	const slave = candidates.find((c) => c.candidateId === 'mock-slave');
	assert.ok(master);
	assert.equal(master.displayName, 'Master');
	assert.equal(master.detail, 'Mock | master');
	assert.ok(slave);
	assert.equal(slave.displayName, 'Slave');
	assert.equal(slave.detail, 'Mock | slave of Master');
});

test('BrickDiscoveryService.scan excludes mock bricks when disabled', async () => {
	const mockBricks: MockBrickDefinition[] = [
		{ brickId: 'mock-master', displayName: 'Master', role: 'master' }
	];
	const scanners = createMockScanners([], [], []);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig({ showMockBricks: false, mockBricks });

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan includes stored profiles not currently discovered', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'usb-stored',
			displayName: 'Stored EV3',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.USB, usbPath: 'stored-path' }
		}
	];
	const scanners = createMockScanners([], [], []);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'usb-stored');
	assert.equal(candidates[0].displayName, 'Stored EV3');
	assert.equal(candidates[0].transport, TransportMode.USB);
	assert.equal(candidates[0].status, 'UNAVAILABLE');
});

test('BrickDiscoveryService.scan deduplicates candidates', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'usb-auto',
			displayName: 'Stored Name',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.USB, usbPath: 'auto' }
		}
	];
	const scanners = createMockScanners(
		[{ path: 'auto', serialNumber: 'SN001' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	// Should only have one candidate (discovered USB takes precedence)
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'usb-auto');
});

test('BrickDiscoveryService.scan sorts candidates by transport mode', async () => {
	const mockBricks: MockBrickDefinition[] = [
		{ brickId: 'mock-test', displayName: 'Mock', role: 'standalone' }
	];
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[{ path: 'COM5', manufacturer: 'LEGO' }],
		[{ ip: '192.168.1.100', port: 5555 }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig({ showMockBricks: true, mockBricks });

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 4);
	// USB should be first (rank 0)
	assert.equal(candidates[0].transport, TransportMode.USB);
	// BT should be second (rank 1)
	assert.equal(candidates[1].transport, TransportMode.BT);
	// TCP should be third (rank 2)
	assert.equal(candidates[2].transport, TransportMode.TCP);
	// MOCK should be last (rank 3)
	assert.equal(candidates[3].transport, TransportMode.MOCK);
});

test('BrickDiscoveryService.scan sorts by displayName within same transport', async () => {
	const scanners = createMockScanners(
		[{ path: 'zebra' }, { path: 'alpha' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 2);
	assert.equal(candidates[0].candidateId, 'usb-alpha');
	assert.equal(candidates[1].candidateId, 'usb-zebra');
});

test('BrickDiscoveryService.scan prefers connected brick name', async () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'usb-auto',
			displayName: 'ConnectedEV3',
			status: 'READY',
			isActive: true,
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/home/root/lms2012/prjs/'
		}
	];
	const scanners = createMockScanners(
		[{ path: 'auto', serialNumber: 'SN001' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(snapshots),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].displayName, 'ConnectedEV3');
});

test('BrickDiscoveryService.scan prefers remembered profile name over discovered', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'usb-auto',
			displayName: 'StoredEV3',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.USB, usbPath: 'auto' }
		}
	];
	const scanners = createMockScanners(
		[{ path: 'auto', serialNumber: 'SN001' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].displayName, 'StoredEV3');
});

test('BrickDiscoveryService.scan uses discovered TCP name as fallback', async () => {
	const scanners = createMockScanners(
		[],
		[],
		[{ ip: '192.168.1.100', port: 5555, name: 'FoundEV3' }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].displayName, 'FoundEV3');
});

test('BrickDiscoveryService.scan marks connected bricks as alreadyConnected', async () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'usb-auto',
			displayName: 'Connected',
			status: 'READY',
			isActive: true,
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/home/root/lms2012/prjs/'
		}
	];
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(snapshots),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].alreadyConnected, true);
	assert.equal(candidates[0].status, 'READY');
});

test('BrickDiscoveryService.scan marks connecting bricks as alreadyConnected', async () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'usb-auto',
			displayName: 'Connecting',
			status: 'CONNECTING',
			isActive: false,
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/home/root/lms2012/prjs/'
		}
	];
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(snapshots),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].alreadyConnected, true);
	assert.equal(candidates[0].status, 'CONNECTING');
});

test('BrickDiscoveryService.scan filters empty USB paths', async () => {
	const scanners = createMockScanners(
		[{ path: '' }, { path: '  ' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan filters non-COM serial ports', async () => {
	const scanners = createMockScanners(
		[],
		[
			{ path: '/dev/ttyUSB0', manufacturer: 'LEGO' },
			{ path: 'LPT1', manufacturer: 'LEGO' }
		],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan excludes "active" candidateId', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'active',
			displayName: 'Active Brick',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.USB, usbPath: 'auto' }
		}
	];
	const scanners = createMockScanners([], [], []);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan includes active registry entries', async () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'registry-only',
			displayName: 'Registry EV3',
			status: 'UNAVAILABLE',
			isActive: false,
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/home/root/lms2012/prjs/'
		}
	];
	const scanners = createMockScanners([], [], []);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(snapshots),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'registry-only');
	assert.equal(candidates[0].displayName, 'Registry EV3');
});

test('BrickDiscoveryService.scan drops stale legacy BT snapshot when superseded by MAC candidate on same COM', async () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'bt-com4',
			displayName: 'Legacy COM4',
			status: 'AVAILABLE',
			isActive: false,
			role: 'standalone',
			transport: TransportMode.BT,
			rootPath: '/home/root/lms2012/prjs/'
		}
	];
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'bt-com4',
			displayName: 'Legacy COM4',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.BT, btPort: 'COM4' }
		}
	];
	const scanners = createMockScanners(
		[],
		[{
			path: 'COM4',
			manufacturer: 'LEGO',
			pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653518739_...'
		}],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(snapshots),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		probeBtCandidatePresence: async () => true,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653518739');
	assert.equal(candidates[0].status, 'AVAILABLE');
});

test('BrickDiscoveryService.scan caches discovered profiles', async () => {
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	await service.scan(config);

	const cachedProfile = service.getDiscoveredProfile('usb-auto');
	assert.ok(cachedProfile);
	assert.equal(cachedProfile.brickId, 'usb-auto');
	assert.equal(cachedProfile.transport.mode, TransportMode.USB);
	assert.equal(cachedProfile.transport.usbPath, 'auto');
});

test('BrickDiscoveryService.scan clears cache on new scan', async () => {
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	await service.scan(config);
	assert.ok(service.getDiscoveredProfile('usb-auto'));

	// Scan again with empty results
	const emptyScanners = createMockScanners([], [], []);
	const emptyDeps: BrickDiscoveryServiceDeps = {
		...deps,
		scanners: emptyScanners
	};
	const emptyService = new BrickDiscoveryService(emptyDeps);
	await emptyService.scan(config);

	assert.equal(emptyService.getDiscoveredProfile('usb-auto'), undefined);
});

test('BrickDiscoveryService.getDiscoveredProfile returns undefined for unknown candidateId', () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners(),
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const profile = service.getDiscoveredProfile('unknown');

	assert.equal(profile, undefined);
});

test('BrickDiscoveryService.updateDiscoveredProfile updates existing profile', async () => {
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	await service.scan(config);

	const updatedProfile: BrickConnectionProfile = {
		brickId: 'usb-auto',
		displayName: 'Updated Name',
		savedAtIso: '2026-02-17T12:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.USB, usbPath: 'auto' }
	};
	service.updateDiscoveredProfile('usb-auto', updatedProfile);

	const retrieved = service.getDiscoveredProfile('usb-auto');
	assert.equal(retrieved?.displayName, 'Updated Name');
});

test('BrickDiscoveryService.updateDiscoveredProfile does not add new profile', () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners(),
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const profile: BrickConnectionProfile = {
		brickId: 'usb-new',
		displayName: 'New Brick',
		savedAtIso: '2026-02-17T12:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.USB, usbPath: 'new' }
	};
	service.updateDiscoveredProfile('usb-new', profile);

	assert.equal(service.getDiscoveredProfile('usb-new'), undefined);
});

test('BrickDiscoveryService.listDiscoveredProfiles returns all cached profiles', async () => {
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[{ path: 'COM5', manufacturer: 'LEGO', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...' }],
		[{ ip: '192.168.1.100', port: 5555 }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	await service.scan(config);

	const profiles = service.listDiscoveredProfiles();
	assert.equal(profiles.size, 3);
	assert.ok(profiles.get('usb-auto'));
	assert.ok(profiles.get('bt-001653abcdef'));
	assert.ok(profiles.get('tcp-192-168-1-100-5555'));
});

test('BrickDiscoveryService.listDiscoveredProfiles returns empty map initially', () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners(),
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const profiles = service.listDiscoveredProfiles();
	assert.equal(profiles.size, 0);
});

test('BrickDiscoveryService.connectDiscoveredBrick connects cached profile', async () => {
	const scanners = createMockScanners(
		[{ path: 'auto' }],
		[],
		[]
	);
	let upsertedProfile: BrickConnectionProfile | undefined;
	let connectedBrickId: string | undefined;
	const mockProfileStore = {
		...createMockProfileStore(),
		upsert: async (profile: BrickConnectionProfile) => {
			upsertedProfile = profile;
		}
	} as unknown as BrickConnectionProfileStore;
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: mockProfileStore,
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	await service.scan(config);
	await service.connectDiscoveredBrick('usb-auto', mockProfileStore, async (brickId) => {
		connectedBrickId = brickId;
	});

	assert.ok(upsertedProfile);
	assert.equal(upsertedProfile.brickId, 'usb-auto');
	assert.equal(connectedBrickId, 'usb-auto');
});

test('BrickDiscoveryService.connectDiscoveredBrick connects stored profile', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'usb-stored',
			displayName: 'Stored EV3',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.USB, usbPath: 'stored' }
		}
	];
	let connectedBrickId: string | undefined;
	const mockProfileStore = {
		...createMockProfileStore(storedProfiles),
		upsert: async () => undefined
	} as unknown as BrickConnectionProfileStore;
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: mockProfileStore,
		scanners: createMockScanners(),
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	await service.connectDiscoveredBrick('usb-stored', mockProfileStore, async (brickId) => {
		connectedBrickId = brickId;
	});

	assert.equal(connectedBrickId, 'usb-stored');
});

test('BrickDiscoveryService.connectDiscoveredBrick throws for unknown candidateId', async () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners(),
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	await assert.rejects(
		async () => {
			await service.connectDiscoveredBrick('unknown', createMockProfileStore(), async () => undefined);
		},
		{ message: 'Selected Brick is no longer available. Scan again.' }
	);
});

test('BrickDiscoveryService.scan normalizes brick names with length validation', async () => {
	const scanners = createMockScanners(
		[],
		[],
		[{ ip: '192.168.1.100', port: 5555, name: '   ValidName   ' }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates[0].displayName, 'ValidName');
});

test('BrickDiscoveryService.scan rejects brick names longer than 12 characters', async () => {
	const scanners = createMockScanners(
		[],
		[],
		[{ ip: '192.168.1.100', port: 5555, name: 'ThisNameIsTooLongForEV3' }]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	// Should fall back to default name format
	assert.equal(candidates[0].displayName, 'EV3 TCP (192.168.1.100:5555)');
});

test('BrickDiscoveryService.scan handles empty scans gracefully', async () => {
	const scanners = createMockScanners([], [], []);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan skips legacy BT profile duplicate when MAC candidate is present on same port', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'bt-other',
			displayName: 'StoredBT',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.BT, btPort: 'COM5' }
		}
	];
	const scanners = createMockScanners(
		[],
		[{ path: 'COM5', manufacturer: 'LEGO', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653AABBCC_...' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	// Legacy bt-* profile on the same COM port should not duplicate the MAC-based candidate.
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653aabbcc');
	assert.equal(candidates[0].displayName, 'EV3 Bluetooth (COM5)');
});

test('BrickDiscoveryService.scan uses preferredBluetoothPort config', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM9', manufacturer: 'Unknown' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig({ preferredBluetoothPort: 'COM9' });

	const candidates = await service.scan(config);

	// Should discover COM9 because it's the preferred port
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-com9');
});

test('BrickDiscoveryService.scan skips Bluetooth candidate when presence probe rejects it', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM4', manufacturer: 'LEGO', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => false,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan includes Bluetooth candidate when presence probe confirms it', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM4', manufacturer: 'LEGO', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => true,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653abcdef');
	assert.equal(candidates[0].status, 'AVAILABLE');
});

test('BrickDiscoveryService.scan does not accept serial candidate from address-only fallback when probe fails', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM4', manufacturer: 'LEGO', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => false,
		isBtAddressPresent: async (address) => address === '001653ABCDEF',
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan includes live BT device without COM as non-connectable candidate', async () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners([], [], []),
		listBtLiveDevices: async () => [
			{
				address: '001653ABCDEF',
				displayName: 'TRZTINA'
			}
		],
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653abcdef');
	assert.equal(candidates[0].displayName, 'TRZTINA');
	assert.equal(candidates[0].status, 'UNAVAILABLE');
	assert.match(candidates[0].detail ?? '', /no COM/i);
});

test('BrickDiscoveryService.scan ignores live BT device with remembered COM when probe fails', async () => {
	const storedProfiles: BrickConnectionProfile[] = [
		{
			brickId: 'bt-001653abcdef',
			displayName: 'TRZTINA',
			savedAtIso: '2026-02-16T00:00:00.000Z',
			rootPath: '/home/root/lms2012/prjs/',
			transport: { mode: TransportMode.BT, btPort: 'COM4' }
		}
	];
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(storedProfiles),
		scanners: createMockScanners([], [], []),
		listBtLiveDevices: async () => [
			{
				address: '001653ABCDEF',
				displayName: 'TRZTINA'
			}
		],
		probeBtCandidatePresence: async () => false,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653abcdef');
	assert.equal(candidates[0].status, 'UNAVAILABLE');
});

test('BrickDiscoveryService.connectDiscoveredBrick explains missing COM for live BT candidate', async () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners([], [], []),
		listBtLiveDevices: async () => [
			{
				address: '001653ABCDEF',
				displayName: 'TRZTINA'
			}
		],
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	await service.scan(createDefaultConfig());

	await assert.rejects(
		async () => {
			await service.connectDiscoveredBrick('bt-001653abcdef', createMockProfileStore(), async () => undefined);
		},
		/error.+COM port|SPP COM port/i
	);
});

test('BrickDiscoveryService.scan includes paired EV3 fallback candidate when not live', async () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners([], [], []),
		listBtLiveDevices: async () => [],
		listBtPairedDevices: async () => [
			{
				address: '0016535D7E2D',
				displayName: 'Szalinka'
			}
		],
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-0016535d7e2d');
	assert.equal(candidates[0].displayName, 'Szalinka');
	assert.equal(candidates[0].status, 'UNAVAILABLE');
	assert.match(candidates[0].detail ?? '', /paired only/i);
});

test('BrickDiscoveryService.scan keeps paired EV3 fallback candidate even with old timestamps', async () => {
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners([], [], []),
		listBtLiveDevices: async () => [],
		listBtPairedDevices: async () => [
			{
				address: '00165342D9F2',
				displayName: 'TRZTINA',
				lastSeenAtIso: '2024-03-22T19:11:36.415Z',
				lastConnectedAtIso: '2024-03-22T19:11:36.415Z'
			}
		],
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-00165342d9f2');
	assert.equal(candidates[0].status, 'UNAVAILABLE');
});

test('BrickDiscoveryService.scan skips paired fallback when mapped COM probe fails', async () => {
	const scanners = createMockScanners(
		[],
		[{
			path: 'COM4',
			manufacturer: 'Microsoft',
			pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\8&2E3EE818&0&001653518739_C00000000'
		}],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => false,
		listBtLiveDevices: async () => [],
		listBtPairedDevices: async () => [
			{
				address: '001653518739',
				displayName: 'BUMBLBEE'
			}
		],
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 0);
});

test('BrickDiscoveryService.scan keeps paired-only candidate unavailable even with stale AVAILABLE snapshot', async () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'bt-0016535d7e2d',
			displayName: 'Szalinka',
			status: 'AVAILABLE',
			isActive: false,
			role: 'standalone',
			transport: TransportMode.BT,
			rootPath: '/home/root/lms2012/prjs/'
		}
	];
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(snapshots),
		profileStore: createMockProfileStore(),
		scanners: createMockScanners([], [], []),
		listBtLiveDevices: async () => [],
		listBtPairedDevices: async () => [
			{
				address: '0016535D7E2D',
				displayName: 'Szalinka'
			}
		],
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);

	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-0016535d7e2d');
	assert.equal(candidates[0].status, 'UNAVAILABLE');
});

test('BrickDiscoveryService.scan does not probe already connected Bluetooth candidate', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM4', manufacturer: 'LEGO', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\001653ABCDEF_...' }],
		[]
	);
	let probeCalls = 0;
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry([
			{
				brickId: 'bt-001653abcdef',
				displayName: 'EV3 BT',
				role: 'unknown',
				transport: TransportMode.BT,
				rootPath: '/home/root/lms2012/prjs/',
				status: 'READY',
				isActive: false,
				lastSeenAtIso: '2026-02-17T00:00:00.000Z'
			}
		]),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => {
			probeCalls += 1;
			return false;
		},
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const config = createDefaultConfig();

	const candidates = await service.scan(config);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-001653abcdef');
	assert.equal(probeCalls, 0);
});

test('BrickDiscoveryService.scan includes generic Bluetooth COM candidate when probe confirms presence', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM9', manufacturer: 'Microsoft', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\...' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => true,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'bt-com9');
});

test('BrickDiscoveryService.scan excludes generic Bluetooth COM candidate when probe rejects presence', async () => {
	const scanners = createMockScanners(
		[],
		[{ path: 'COM9', manufacturer: 'Microsoft', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\...' }],
		[]
	);
	const deps: BrickDiscoveryServiceDeps = {
		brickRegistry: createMockBrickRegistry(),
		profileStore: createMockProfileStore(),
		scanners,
		probeBtCandidatePresence: async () => false,
		logger: createMockLogger(),
		toSafeIdentifier
	};
	const service = new BrickDiscoveryService(deps);
	const candidates = await service.scan(createDefaultConfig());

	assert.equal(candidates.length, 0);
});
