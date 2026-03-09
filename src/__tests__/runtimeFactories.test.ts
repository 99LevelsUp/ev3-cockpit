import assert from 'node:assert/strict';
import test from 'node:test';
import { TransportMode } from '../types/enums';
import { sortBrickSnapshotsForTree, toTransportOverrides } from '../activation/runtimeHelpers';
import { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import { BrickSnapshot } from '../device/brickRegistry';

test('sortBrickSnapshotsForTree prioritizes favorites, then active, then display name', () => {
	const snapshots: BrickSnapshot[] = [
		{
			brickId: 'beta',
			displayName: 'Beta',
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/beta/',
			status: 'READY',
			isActive: false
		},
		{
			brickId: 'alpha',
			displayName: 'Alpha',
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/alpha/',
			status: 'READY',
			isActive: true
		},
		{
			brickId: 'gamma',
			displayName: 'Gamma',
			role: 'standalone',
			transport: TransportMode.USB,
			rootPath: '/gamma/',
			status: 'READY',
			isActive: false
		}
	];

	assert.deepEqual(
		sortBrickSnapshotsForTree(snapshots, ['gamma']),
		[snapshots[2], snapshots[1], snapshots[0]]
	);
});

test('toTransportOverrides returns undefined when profile transport is missing', () => {
	assert.equal(toTransportOverrides(undefined), undefined);
});

test('toTransportOverrides maps all supported transport override fields', () => {
	const profile: BrickConnectionProfile = {
		brickId: 'brick-1',
		displayName: 'Brick 1',
		savedAtIso: '2026-03-09T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: {
			mode: TransportMode.BT,
			usbPath: 'hid://device',
			tcpHost: '192.168.0.1',
			tcpPort: 5555,
			tcpUseDiscovery: true,
			tcpSerialNumber: 'EV3-123',
			btPortPath: 'COM7'
		}
	};

	assert.deepEqual(toTransportOverrides(profile), profile.transport);
});
