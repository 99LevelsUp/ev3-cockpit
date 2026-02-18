import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	clearBluetoothNameMapCache,
} from '../transport/discovery';

/*
 * For unit tests we stub `listSerialCandidates` and `resolveWindowsBluetoothNameMap`
 * via Module._load interception since those touch hardware/registry.
 * However the design-plan's preferred approach is injection — these tests focus on
 * the pure logic functions we can reach through the public API: name cleaning,
 * MAC extraction, LEGO prefix, and the composition in listBluetoothCandidates.
 *
 * Because listBluetoothCandidates internally calls listSerialCandidates and
 * resolveWindowsBluetoothNameMap (which are difficult to stub without injection),
 * we test the building blocks directly and integration via brickDiscoveryService
 * scan() which accepts injectable scanners.
 */

import {
	isBtSerialCandidate,
	extractMacFromPnpId,
	hasLegoMacPrefix,
} from '../transport/bluetoothPortSelection';

describe('bluetoothDiscovery – building blocks', () => {

	describe('isBtSerialCandidate', () => {
		it('should accept BTHENUM candidate', () => {
			assert.equal(isBtSerialCandidate({
				path: 'COM5',
				manufacturer: 'Microsoft',
				pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805f9b34fb}_LOCALMFG&005D\\001653AABB01_C00000000'
			}), true);
		});

		it('should reject non-BT candidate with non-COM path', () => {
			assert.equal(isBtSerialCandidate({
				path: '/dev/ttyUSB0',
				manufacturer: 'FTDI',
				pnpId: 'USB\\VID_0403&PID_6001\\A12345'
			}), false);
		});
	});

	describe('extractMacFromPnpId', () => {
		it('should extract MAC from standard BTHENUM path', () => {
			assert.equal(
				extractMacFromPnpId('BTHENUM\\{00001101-0000-1000-8000-00805f9b34fb}_LOCALMFG&005D\\001653AABB01_C00000000'),
				'001653aabb01'
			);
		});

		it('should return undefined for non-BT pnpId', () => {
			assert.equal(extractMacFromPnpId('USB\\VID_0403&PID_6001\\A12345'), undefined);
		});

		it('should return undefined for undefined input', () => {
			assert.equal(extractMacFromPnpId(undefined), undefined);
		});
	});

	describe('hasLegoMacPrefix', () => {
		it('should detect LEGO OUI prefix', () => {
			assert.equal(
				hasLegoMacPrefix('BTHENUM\\001653AABB01_C00000000'),
				true
			);
		});

		it('should reject non-LEGO MAC', () => {
			assert.equal(
				hasLegoMacPrefix('BTHENUM\\AABBCCDDEEFF_C00000000'),
				false
			);
		});
	});
});

describe('bluetoothDiscovery – clearBluetoothNameMapCache', () => {
	it('should not throw when called', () => {
		assert.doesNotThrow(() => clearBluetoothNameMapCache());
	});
});

describe('bluetoothDiscovery – brickDiscoveryService BT integration', () => {
	// Test via BrickDiscoveryService.scan() which accepts injectable scanners

	// Minimal imports for scan testing
	const { BrickDiscoveryService } = require('../device/brickDiscoveryService');

	const defaultConfig = {
		showMockBricks: false,
		mockBricks: [],
		tcpDiscoveryPort: 3015,
		tcpDiscoveryTimeoutMs: 2000,
		defaultRootPath: '/home/root/lms2012/prjs/'
	};

	function makeTestService(btCandidates: Array<{
		path: string;
		mac?: string;
		displayName?: string;
		hasLegoPrefix: boolean;
	}>) {
		const brickRegistry = {
			getSnapshot: () => undefined,
			listSnapshots: () => []
		};
		const profileStore = {
			get: () => undefined,
			list: () => []
		};
		const scanners = {
			listUsbHidCandidates: async () => [],
			listTcpDiscoveryCandidates: async () => [],
			listBluetoothCandidates: async () => btCandidates
		};
		const logger = {
			info: () => {},
			warn: () => {},
			error: () => {}
		};
		return new BrickDiscoveryService({
			brickRegistry,
			profileStore,
			scanners,
			logger,
			toSafeIdentifier: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
		});
	}

	it('should produce BT candidates from scanner results', async () => {
		const service = makeTestService([
			{ path: 'COM5', mac: '001653aabb01', displayName: 'EV3-BB01', hasLegoPrefix: true },
			{ path: 'COM7', mac: undefined, displayName: undefined, hasLegoPrefix: false }
		]);

		const candidates = await service.scan(defaultConfig);

		const btCandidates = candidates.filter((c: { transport: string }) => c.transport === 'bt');
		assert.equal(btCandidates.length, 2);

		const macCandidate = btCandidates.find((c: { candidateId: string }) => c.candidateId === 'bt-001653aabb01');
		assert.ok(macCandidate, 'Expected candidate with MAC-based ID');
		assert.equal(macCandidate.transport, 'bt');
		assert.ok(macCandidate.detail?.includes('COM5'));
		assert.ok(macCandidate.detail?.includes('001653AABB01'));

		const comCandidate = btCandidates.find((c: { candidateId: string }) => c.candidateId === 'bt-COM7');
		assert.ok(comCandidate, 'Expected candidate with COM-based ID');
		assert.equal(comCandidate.transport, 'bt');
		assert.equal(comCandidate.detail, 'COM7');
	});

	it('should deduplicate BT candidates by brickId', async () => {
		const service = makeTestService([
			{ path: 'COM5', mac: '001653aabb01', displayName: 'EV3-1', hasLegoPrefix: true },
			{ path: 'COM6', mac: '001653aabb01', displayName: 'EV3-2', hasLegoPrefix: true }
		]);

		const candidates = await service.scan(defaultConfig);
		const btCandidates = candidates.filter((c: { transport: string }) => c.transport === 'bt');
		assert.equal(btCandidates.length, 1);
		assert.equal(btCandidates[0].candidateId, 'bt-001653aabb01');
	});

	it('should skip BT candidates with empty path', async () => {
		const service = makeTestService([
			{ path: '', mac: '001653aabb01', displayName: 'EV3-1', hasLegoPrefix: true },
			{ path: '  ', mac: '001653aabb02', displayName: 'EV3-2', hasLegoPrefix: true }
		]);

		const candidates = await service.scan(defaultConfig);
		const btCandidates = candidates.filter((c: { transport: string }) => c.transport === 'bt');
		assert.equal(btCandidates.length, 0);
	});

	it('should use MAC-based fallback name when displayName is absent', async () => {
		const service = makeTestService([
			{ path: 'COM5', mac: '001653aabb01', displayName: undefined, hasLegoPrefix: true }
		]);

		const candidates = await service.scan(defaultConfig);
		const btCandidates = candidates.filter((c: { transport: string }) => c.transport === 'bt');
		assert.equal(btCandidates.length, 1);
		assert.ok(btCandidates[0].displayName.includes('BB01'));
	});

	it('should use COM port fallback name when no MAC or displayName', async () => {
		const service = makeTestService([
			{ path: 'COM8', mac: undefined, displayName: undefined, hasLegoPrefix: false }
		]);

		const candidates = await service.scan(defaultConfig);
		const btCandidates = candidates.filter((c: { transport: string }) => c.transport === 'bt');
		assert.equal(btCandidates.length, 1);
		assert.ok(btCandidates[0].displayName.includes('COM8'));
	});

	it('should handle empty BT scanner results', async () => {
		const service = makeTestService([]);
		const candidates = await service.scan(defaultConfig);
		const btCandidates = candidates.filter((c: { transport: string }) => c.transport === 'bt');
		assert.equal(btCandidates.length, 0);
	});

	it('should handle scanner returning undefined (optional scanner)', async () => {
		// Simulate no BT scanner registered
		const brickRegistry = {
			getSnapshot: () => undefined,
			listSnapshots: () => []
		};
		const profileStore = {
			get: () => undefined,
			list: () => []
		};
		const scanners = {
			listUsbHidCandidates: async () => [],
			listTcpDiscoveryCandidates: async () => []
			// listBluetoothCandidates is not provided
		};
		const logger = { info: () => {}, warn: () => {}, error: () => {} };
		const service = new BrickDiscoveryService({
			brickRegistry,
			profileStore,
			scanners,
			logger,
			toSafeIdentifier: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
		});

		const candidates = await service.scan(defaultConfig);
		// Should work without BT scanner — no crash
		assert.ok(Array.isArray(candidates));
	});
});
