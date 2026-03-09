import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider.js';
import { TransportMode } from '../types/enums.js';
import {
	buildDiscoveredProfile,
	resolveDiscoveryDetail,
	resolveDiscoveryTransport,
	resolveLiveCandidateStatus,
	resolveNonConnectableReason,
	resolvePreferredDiscoveryDisplayName,
	resolveStoredCandidateStatus,
	shouldIncludeDiscoveryCandidate,
	sortDiscoveryCandidates
} from '../presence/presenceCandidateHelpers.js';
import type { PresenceRecord } from '../presence/presenceSource.js';

function makeRecord(
	candidateId: string,
	transport: TransportMode,
	overrides?: Partial<PresenceRecord>
): PresenceRecord {
	const defaults: Record<TransportMode, PresenceRecord['connectionParams']> = {
		[TransportMode.USB]: { mode: 'usb', usbPath: '/dev/hid0' },
		[TransportMode.TCP]: { mode: 'tcp', tcpHost: '192.168.0.10', tcpPort: 5555, tcpSerialNumber: '001' },
		[TransportMode.BT]: { mode: 'bt', btPortPath: 'COM7', mac: '001653aabbcc' },
		[TransportMode.MOCK]: { mode: 'mock' }
	};
	return {
		candidateId,
		transport,
		displayName: `Brick ${candidateId}`,
		detail: candidateId,
		connectable: true,
		lastSeenMs: Date.now(),
		connectionParams: defaults[transport],
		...overrides
	};
}

test('resolvePreferredDiscoveryDisplayName prefers connected then remembered then live', () => {
	assert.equal(
		resolvePreferredDiscoveryDisplayName({
			connectedDisplayName: 'READY_BRICK',
			rememberedDisplayName: 'Stored',
			liveDisplayName: 'Live',
			fallbackDisplayName: 'Fallback'
		}),
		'READY_BRICK'
	);
	assert.equal(
		resolvePreferredDiscoveryDisplayName({
			rememberedDisplayName: 'Stored',
			liveDisplayName: 'Live',
			fallbackDisplayName: 'Fallback'
		}),
		'Stored'
	);
	assert.equal(
		resolvePreferredDiscoveryDisplayName({
			liveDisplayName: 'Live',
			fallbackDisplayName: 'Fallback'
		}),
		'Live'
	);
	assert.equal(
		resolvePreferredDiscoveryDisplayName({
			liveDisplayName: 'prilis_dlouhy_nazev_bricku',
			fallbackDisplayName: 'Fallback'
		}),
		'Fallback'
	);
});

test('resolveLiveCandidateStatus maps transport-specific availability rules', () => {
	const usbError = makeRecord('usb-a', TransportMode.USB, { connectable: false });
	const btVisible = makeRecord('bt-a', TransportMode.BT, { connectable: false });
	const tcpReady = makeRecord('tcp-a', TransportMode.TCP);

	assert.equal(resolveLiveCandidateStatus(undefined, usbError), 'ERROR');
	assert.equal(resolveLiveCandidateStatus(undefined, btVisible), 'AVAILABLE');
	assert.equal(resolveLiveCandidateStatus({ status: 'CONNECTING' }, tcpReady), 'CONNECTING');
	assert.equal(resolveLiveCandidateStatus({ status: 'ERROR' }, tcpReady), 'ERROR');
});

test('resolveStoredCandidateStatus and transport/detail helpers normalize profile metadata', () => {
	const tcpProfile = {
		brickId: 'tcp-a',
		displayName: 'TCP Brick',
		savedAtIso: '2026-03-09T00:00:00.000Z',
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.TCP, tcpHost: '10.0.0.5', tcpPort: 3015, tcpUseDiscovery: false, tcpSerialNumber: 'ABC' }
	};

	assert.equal(resolveStoredCandidateStatus(undefined, 'UNAVAILABLE'), 'UNAVAILABLE');
	assert.equal(resolveStoredCandidateStatus({ status: 'READY' }, 'UNAVAILABLE'), 'READY');
	assert.equal(resolveDiscoveryTransport('tcp-a', tcpProfile), 'tcp');
	assert.equal(resolveDiscoveryDetail(tcpProfile), '10.0.0.5:3015');
	assert.equal(resolveDiscoveryTransport('usb-a'), 'usb');
	assert.equal(resolveDiscoveryTransport('mock-a'), 'mock');
});

test('buildDiscoveredProfile and non-connectable reason preserve transport data', () => {
	const usbRecord = makeRecord('usb-a', TransportMode.USB, { connectable: false });
	const btRecord = makeRecord('bt-a', TransportMode.BT, { connectable: false });
	const built = buildDiscoveredProfile(usbRecord, 'EV3', '/home/root/lms2012/prjs/', '2026-03-09T00:00:00.000Z');

	assert.equal(built.brickId, 'usb-a');
	assert.equal(built.transport.mode, 'usb');
	assert.equal(built.transport.usbPath, '/dev/hid0');
	assert.match(resolveNonConnectableReason(usbRecord) ?? '', /name probe failed/i);
	assert.match(resolveNonConnectableReason(btRecord) ?? '', /com mapping/i);
});

test('sortDiscoveryCandidates and filtering enforce panel ordering rules', () => {
	const candidates: BrickPanelDiscoveryCandidate[] = [
		{ candidateId: 'mock-a', displayName: 'Mock', transport: 'mock', status: 'AVAILABLE', alreadyConnected: false },
		{ candidateId: 'tcp-b', displayName: 'Tcp', transport: 'tcp', status: 'AVAILABLE', alreadyConnected: false },
		{ candidateId: 'usb-c', displayName: 'Usb', transport: 'usb', status: 'AVAILABLE', alreadyConnected: false },
		{ candidateId: 'bt-d', displayName: 'Bt', transport: 'bt', status: 'AVAILABLE', alreadyConnected: false }
	];

	assert.equal(shouldIncludeDiscoveryCandidate('mock-a', false), false);
	assert.equal(shouldIncludeDiscoveryCandidate('active', true), false);
	assert.equal(shouldIncludeDiscoveryCandidate('tcp-b', true), true);
	assert.deepEqual(
		sortDiscoveryCandidates(candidates).map((candidate) => candidate.transport),
		['usb', 'bt', 'tcp', 'mock']
	);
});
