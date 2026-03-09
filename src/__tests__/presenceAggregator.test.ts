import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { TransportMode } from '../types/enums';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from '../presence/presenceSource';

type ModuleLoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
type ModuleWithLoad = typeof Module & { _load: ModuleLoadFn };

const originalLoad = (Module as ModuleWithLoad)._load;

function installVscodeMock(): void {
	(Module as ModuleWithLoad)._load = ((requested: string, parent: unknown, isMain: boolean) => {
		if (requested === 'vscode') {
			return {
				workspace: {
					getConfiguration: () => ({
						get: () => undefined
					})
				}
			};
		}
		return originalLoad(requested, parent, isMain);
	}) as ModuleLoadFn;
}

function removeVscodeMock(): void {
	(Module as ModuleWithLoad)._load = originalLoad;
}

// Install mock before any imports that need vscode
installVscodeMock();

// Now safe to import modules that transitively require vscode
const { BrickRegistry } = require('../device/brickRegistry') as typeof import('../device/brickRegistry');
const { BrickConnectionProfileStore } = require('../device/brickConnectionProfiles') as typeof import('../device/brickConnectionProfiles');
const { PresenceAggregator } = require('../presence/presenceAggregator') as typeof import('../presence/presenceAggregator');

// Restore after loading
removeVscodeMock();

function createFakeProfileStore(): InstanceType<typeof BrickConnectionProfileStore> {
	const storage = {
		_data: new Map<string, unknown>(),
		get(key: string) { return this._data.get(key); },
		update(key: string, value: unknown) { this._data.set(key, value); return Promise.resolve(); }
	};
	return new BrickConnectionProfileStore(storage as never, { persistenceEnabled: false });
}

function createNoopLogger() {
	const noop = () => {};
	return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function createFakeSource(transport: TransportMode): PresenceSource & {
	emit(records: Map<string, PresenceRecord>): void;
	records: Map<string, PresenceRecord>;
} {
	const listeners: PresenceChangeCallback[] = [];
	const records = new Map<string, PresenceRecord>();
	return {
		transport,
		records,
		start() {},
		stop() {},
		getPresent() { return records; },
		onChange(cb: PresenceChangeCallback) { listeners.push(cb); },
		emit(newRecords: Map<string, PresenceRecord>) {
			records.clear();
			for (const [k, v] of newRecords) {
				records.set(k, v);
			}
			for (const listener of listeners) {
				listener(records);
			}
		}
	};
}

function makeRecord(
	candidateId: string,
	transport: TransportMode,
	overrides?: Partial<PresenceRecord>
): PresenceRecord {
	const defaults: Record<TransportMode, PresenceRecord['connectionParams']> = {
		[TransportMode.USB]: { mode: 'usb', usbPath: '/dev/hid0' },
		[TransportMode.TCP]: { mode: 'tcp', tcpHost: '192.168.1.1', tcpPort: 5555 },
		[TransportMode.BT]: { mode: 'bt', btPortPath: 'COM3', mac: '001653aabbcc' },
		[TransportMode.MOCK]: { mode: 'mock' }
	};
	return {
		candidateId,
		transport,
		displayName: `Test ${candidateId}`,
		detail: candidateId,
		connectable: true,
		lastSeenMs: Date.now(),
		connectionParams: defaults[transport],
		...overrides
	};
}

function createAggregator(overrides?: {
	registry?: InstanceType<typeof BrickRegistry>;
	profileStore?: InstanceType<typeof BrickConnectionProfileStore>;
	goneTtl?: Partial<{ usb: number; bt: number; tcp: number; mock: number }>;
	candidateChangeCoalesceMs?: number;
}) {
	const registry = overrides?.registry ?? new BrickRegistry();
	const profileStore = overrides?.profileStore ?? createFakeProfileStore();
	return new PresenceAggregator(
		{
			brickRegistry: registry,
			profileStore,
			logger: createNoopLogger(),
			toSafeIdentifier: (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
		},
		{
			goneTtl: {
				usb: 3000,
				bt: 45000,
				tcp: 10000,
				mock: Infinity,
				...overrides?.goneTtl
			},
			reaperIntervalMs: 60000,
			defaultRootPath: '/home/root/lms2012/prjs/',
			candidateChangeCoalesceMs: overrides?.candidateChangeCoalesceMs ?? 0
		}
	);
}

test('getCandidates returns empty when no sources added', () => {
	const agg = createAggregator();
	const result = agg.getCandidates({ showMockBricks: true });
	assert.equal(result.length, 0);
});

test('mergeFromSource adds records to master map and fires candidatesChanged', () => {
	const registry = new BrickRegistry();
	const agg = createAggregator({ registry });
	const tcpSource = createFakeSource(TransportMode.TCP);
	agg.addSource(tcpSource);

	let changed = 0;
	agg.onCandidatesChanged(() => { changed += 1; });

	const records = new Map<string, PresenceRecord>();
	records.set('tcp-192-168-1-1-5555', makeRecord('tcp-192-168-1-1-5555', TransportMode.TCP));
	tcpSource.emit(records);

	assert.equal(changed, 1);
	assert.equal(agg.getPresent().size, 1);

	// Aggregator no longer pushes AVAILABLE entries into the registry;
	// discovery is read-only until the user explicitly connects.
	const snapshot = registry.getSnapshot('tcp-192-168-1-1-5555');
	assert.equal(snapshot, undefined);
});

test('getCandidates sorts USB > BT > TCP > Mock', () => {
	const agg = createAggregator();
	const usbSource = createFakeSource(TransportMode.USB);
	const tcpSource = createFakeSource(TransportMode.TCP);
	const btSource = createFakeSource(TransportMode.BT);
	const mockSource = createFakeSource(TransportMode.MOCK);
	agg.addSource(usbSource);
	agg.addSource(tcpSource);
	agg.addSource(btSource);
	agg.addSource(mockSource);

	tcpSource.emit(new Map([['tcp-a', makeRecord('tcp-a', TransportMode.TCP)]]));
	usbSource.emit(new Map([['usb-a', makeRecord('usb-a', TransportMode.USB)]]));
	btSource.emit(new Map([['bt-a', makeRecord('bt-a', TransportMode.BT)]]));
	mockSource.emit(new Map([['mock-a', makeRecord('mock-a', TransportMode.MOCK)]]));

	const candidates = agg.getCandidates({ showMockBricks: true });
	assert.equal(candidates.length, 4);
	assert.equal(candidates[0].transport, 'usb');
	assert.equal(candidates[1].transport, 'bt');
	assert.equal(candidates[2].transport, 'tcp');
	assert.equal(candidates[3].transport, 'mock');
});

test('getCandidates filters mock bricks when showMockBricks is false', () => {
	const agg = createAggregator();
	const mockSource = createFakeSource(TransportMode.MOCK);
	agg.addSource(mockSource);

	mockSource.emit(new Map([['mock-ev3', makeRecord('mock-ev3', TransportMode.MOCK)]]));
	const candidates = agg.getCandidates({ showMockBricks: false });
	assert.equal(candidates.length, 0);
});

test('getCandidates includes stored profiles not seen live', async () => {
	const profileStore = createFakeProfileStore();
	await profileStore.upsert({
		brickId: 'usb-old-device',
		displayName: 'Old EV3',
		savedAtIso: new Date().toISOString(),
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.USB, usbPath: '/dev/old' }
	});
	const agg = createAggregator({ profileStore });
	const candidates = agg.getCandidates({ showMockBricks: false });
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidateId, 'usb-old-device');
	assert.equal(candidates[0].status, 'UNAVAILABLE');
});

test('getCandidates marks live brick as AVAILABLE', () => {
	const agg = createAggregator();
	const tcpSource = createFakeSource(TransportMode.TCP);
	agg.addSource(tcpSource);

	tcpSource.emit(new Map([['tcp-x', makeRecord('tcp-x', TransportMode.TCP)]]));
	const candidates = agg.getCandidates({ showMockBricks: false });
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].status, 'AVAILABLE');
});

test('getCandidates marks connected brick from registry', () => {
	const registry = new BrickRegistry();
	registry.upsertConnecting({
		brickId: 'tcp-x',
		displayName: 'EV3',
		role: 'unknown',
		transport: TransportMode.TCP,
		rootPath: '/home/root/lms2012/prjs/'
	});
	const agg = createAggregator({ registry });
	const tcpSource = createFakeSource(TransportMode.TCP);
	agg.addSource(tcpSource);

	tcpSource.emit(new Map([['tcp-x', makeRecord('tcp-x', TransportMode.TCP)]]));
	const candidates = agg.getCandidates({ showMockBricks: false });
	assert.equal(candidates[0].status, 'CONNECTING');
	assert.equal(candidates[0].alreadyConnected, true);
});

test('connectDiscoveredBrick upserts profile and calls executeConnect', async () => {
	const profileStore = createFakeProfileStore();
	const agg = createAggregator({ profileStore });
	const tcpSource = createFakeSource(TransportMode.TCP);
	agg.addSource(tcpSource);

	tcpSource.emit(new Map([['tcp-x', makeRecord('tcp-x', TransportMode.TCP)]]));
	agg.getCandidates({ showMockBricks: false });

	let connectedBrickId: string | undefined;
	await agg.connectDiscoveredBrick('tcp-x', profileStore, async (brickId) => {
		connectedBrickId = brickId;
	});
	assert.equal(connectedBrickId, 'tcp-x');
	assert.ok(profileStore.get('tcp-x'));
});

test('connectDiscoveredBrick throws when candidate not found', async () => {
	const profileStore = createFakeProfileStore();
	const agg = createAggregator({ profileStore });
	agg.getCandidates({ showMockBricks: false });

	await assert.rejects(
		() => agg.connectDiscoveredBrick('nonexistent', profileStore, async () => {}),
		{ message: /no longer available/i }
	);
});

test('non-connectable BT candidate allows BT connect', async () => {
	const profileStore = createFakeProfileStore();
	const agg = createAggregator({ profileStore });
	const btSource = createFakeSource(TransportMode.BT);
	agg.addSource(btSource);

	const record = makeRecord('bt-001653aabbcc', TransportMode.BT, { connectable: false });
	btSource.emit(new Map([['bt-001653aabbcc', record]]));
	agg.getCandidates({ showMockBricks: false });

	let connected = false;
	await agg.connectDiscoveredBrick('bt-001653aabbcc', profileStore, async () => {
		connected = true;
	});
	assert.ok(connected);
});

test('hasLiveCandidate returns correct values', () => {
	const agg = createAggregator();
	const usbSource = createFakeSource(TransportMode.USB);
	agg.addSource(usbSource);

	assert.equal(agg.hasLiveCandidate('usb-x'), false);
	usbSource.emit(new Map([['usb-x', makeRecord('usb-x', TransportMode.USB)]]));
	assert.equal(agg.hasLiveCandidate('usb-x'), true);
});

test('getCandidates deduplicates live records vs stored profiles', async () => {
	const profileStore = createFakeProfileStore();
	await profileStore.upsert({
		brickId: 'tcp-x',
		displayName: 'EV3 stored',
		savedAtIso: new Date().toISOString(),
		rootPath: '/home/root/lms2012/prjs/',
		transport: { mode: TransportMode.TCP, tcpHost: '1.2.3.4', tcpPort: 5555 }
	});
	const agg = createAggregator({ profileStore });
	const tcpSource = createFakeSource(TransportMode.TCP);
	agg.addSource(tcpSource);

	tcpSource.emit(new Map([['tcp-x', makeRecord('tcp-x', TransportMode.TCP)]]));
	const candidates = agg.getCandidates({ showMockBricks: false });
	const tcpXCandidates = candidates.filter((c) => c.candidateId === 'tcp-x');
	assert.equal(tcpXCandidates.length, 1);
	assert.equal(tcpXCandidates[0].status, 'AVAILABLE');
});

test('candidate change notifications are coalesced when configured', async () => {
	const agg = createAggregator({ candidateChangeCoalesceMs: 20 });
	const tcpSource = createFakeSource(TransportMode.TCP);
	agg.addSource(tcpSource);

	let changed = 0;
	agg.onCandidatesChanged(() => {
		changed += 1;
	});

	tcpSource.emit(new Map([['tcp-a', makeRecord('tcp-a', TransportMode.TCP)]]));
	tcpSource.emit(new Map([['tcp-b', makeRecord('tcp-b', TransportMode.TCP)]]));
	assert.equal(changed, 0);

	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(changed, 1);
});
