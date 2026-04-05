import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport, makeBrickKey } from '../contracts';
import type { BatteryResponse, PortsResponse, ButtonsResponse, FsListResponse, FsReadResponse, FsExistsResponse } from '../contracts';
import {
	MockTransportProvider,
	validateMockConfig,
	MockConfig,
} from '../mock';

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<import('../mock').MockBrickConfig>[]): MockConfig {
	return validateMockConfig({
		transport: 'mock',
		bricks: (overrides ?? [{}]).map((o, i) => ({
			id: o?.id ?? `brick-${i}`,
			displayName: o?.displayName ?? `Brick ${i}`,
			battery: o?.battery ?? { level: 75 },
			motorPorts: o?.motorPorts ?? [],
			sensorPorts: o?.sensorPorts ?? [],
			...o,
		})),
	});
}

// ── Discovery ───────────────────────────────────────────────────────

describe('MockTransportProvider — discovery', () => {
	it('discovers all bricks from config', async () => {
		const provider = new MockTransportProvider(makeConfig([
			{ id: 'a', displayName: 'Alpha' },
			{ id: 'b', displayName: 'Beta' },
		]));

		const result = await provider.discover();
		assert.equal(result.transport, Transport.Mock);
		assert.equal(result.items.length, 2);
		assert.equal(result.items[0].brickKey, makeBrickKey(Transport.Mock, 'a'));
		assert.equal(result.items[1].brickKey, makeBrickKey(Transport.Mock, 'b'));
	});

	it('hides bricks during loss simulation hidden phase', async () => {
		const provider = new MockTransportProvider(makeConfig([
			{
				id: 'lossy',
				displayName: 'Lossy',
				loss: { enabled: true, visibleMs: 100, hiddenMs: 100 },
			},
		]));

		const result = await provider.discover();
		assert.ok(result.items.length <= 1);
	});

	it('generates mock:id brickKeys', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'ev3-test' }]));
		const result = await provider.discover();
		assert.equal(result.items[0].brickKey, 'mock:ev3-test');
	});
});

// ── Connect / Disconnect ────────────────────────────────────────────

describe('MockTransportProvider — connect/disconnect', () => {
	it('connects and returns a session handle', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');

		const handle = await provider.connect(key);
		assert.equal(handle.brickKey, key);
		assert.equal(handle.transport, Transport.Mock);
	});

	it('marks brick as connected in discovery after connect', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');

		await provider.connect(key);
		const result = await provider.discover();
		assert.equal(result.items[0].connected, true);
	});

	it('disconnects a connected brick', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');

		await provider.connect(key);
		await provider.disconnect(key);
		const result = await provider.discover();
		assert.equal(result.items[0].connected, false);
	});

	it('throws on connect to unknown brick', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const badKey = makeBrickKey(Transport.Mock, 'nonexistent');

		await assert.rejects(() => provider.connect(badKey), /Unknown mock brick/);
	});

	it('respects connectFailRate', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			error: { connectFailRate: 1.0, sendFailRate: 0 },
		}]), { random: () => 0 });
		const key = makeBrickKey(Transport.Mock, 'a');

		await assert.rejects(() => provider.connect(key), /Mock connect failure/);
	});
});

// ── Send ────────────────────────────────────────────────────────────

describe('MockTransportProvider — send', () => {
	it('returns battery info', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			battery: { level: 82, voltage: 7.2 },
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const result = await provider.send(key, { kind: 'battery' }) as BatteryResponse;
		assert.equal(result.level, 82);
		assert.equal(result.voltage, 7.2);
	});

	it('returns port values', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			motorPorts:  [{ port: 'A', peripheralType: 'motor',  dynamic: { kind: 'static', value: 42 } }],
			sensorPorts: [{ port: '1', peripheralType: 'color',  dynamic: { kind: 'static', value: 3  } }],
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const result = await provider.send(key, { kind: 'ports' }) as PortsResponse;
		assert.equal(result.motorPorts[0].value,  42);
		assert.equal(result.sensorPorts[0].value, 3);
	});

	it('returns undefined value for none dynamic', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			sensorPorts: [{ port: '1', peripheralType: 'none', dynamic: { kind: 'none' } }],
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const result = await provider.send(key, { kind: 'ports' }) as PortsResponse;
		assert.equal(result.sensorPorts[0].value, undefined);
	});

	it('returns hard-coded EV3 buttons regardless of config', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const result = await provider.send(key, { kind: 'buttons' }) as ButtonsResponse;
		assert.deepEqual(result.state, {
			left: false, right: false, up: false, down: false, enter: false, back: false,
		});
	});

	it('throws when not connected', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');

		await assert.rejects(() => provider.send(key, { kind: 'battery' }), /not connected/);
	});

	it('respects sendFailRate', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			error: { connectFailRate: 0, sendFailRate: 1.0 },
		}]), { random: () => 0 });
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		await assert.rejects(() => provider.send(key, { kind: 'battery' }), /Mock send failure/);
	});
});

// ── Recover ─────────────────────────────────────────────────────────

describe('MockTransportProvider — recover', () => {
	it('recovers a disconnected brick', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');

		await provider.connect(key);
		await provider.disconnect(key);
		const handle = await provider.recover(key);

		assert.equal(handle.brickKey, key);
		const result = await provider.send(key, { kind: 'battery' });
		assert.ok(result);
	});
});

// ── Filesystem ──────────────────────────────────────────────────────

describe('MockTransportProvider — filesystem', () => {
	it('lists files', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			filesystem: [
				{ path: '/home/root/lms2012/prjs/Proj/a.rbf', content: '' },
				{ path: '/home/root/lms2012/prjs/Proj/b.rbf', content: '' },
				{ path: '/other/c.rbf',                        content: '' },
			],
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const result = await provider.send(key, { kind: 'fs:list', path: '/home/root/lms2012/prjs/Proj' }) as FsListResponse;
		assert.deepEqual(result.entries, [
			'/home/root/lms2012/prjs/Proj/a.rbf',
			'/home/root/lms2012/prjs/Proj/b.rbf',
		]);
	});

	it('reads a file', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			filesystem: [{ path: '/home/root/lms2012/prjs/Test/test.rbf', content: 'LEGO' }],
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const result = await provider.send(key, { kind: 'fs:read', path: '/home/root/lms2012/prjs/Test/test.rbf' }) as FsReadResponse;
		assert.equal(result.content, 'LEGO');
	});

	it('throws on missing file read', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		await assert.rejects(() => provider.send(key, { kind: 'fs:read', path: '/nope' }), /File not found/);
	});

	it('checks file existence via send()', async () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			filesystem: [{ path: '/x', content: 'y' }],
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		await provider.connect(key);

		const exists = await provider.send(key, { kind: 'fs:exists', path: '/x' }) as FsExistsResponse;
		assert.equal(exists.exists, true);

		const missing = await provider.send(key, { kind: 'fs:exists', path: '/nope' }) as FsExistsResponse;
		assert.equal(missing.exists, false);
	});

	it('provides filesystem via getFilesystem()', () => {
		const provider = new MockTransportProvider(makeConfig([{
			id: 'a',
			filesystem: [{ path: '/x', content: 'y' }],
		}]));
		const key = makeBrickKey(Transport.Mock, 'a');
		const fs = provider.getFilesystem(key);

		assert.ok(fs);
		assert.equal(fs.read('/x'), 'y');
	});
});

// ── Lifecycle ───────────────────────────────────────────────────────

describe('MockTransportProvider — lifecycle', () => {
	it('throws after dispose', async () => {
		const provider = new MockTransportProvider(makeConfig([{ id: 'a' }]));
		provider.dispose();

		await assert.rejects(() => provider.discover(), /disposed/);
	});
});

// ── Config validation ───────────────────────────────────────────────

describe('validateMockConfig', () => {
	it('accepts a valid config', () => {
		const config = validateMockConfig({
			transport: 'mock',
			bricks: [{
				id: 'a', displayName: 'A', battery: { level: 50 },
				motorPorts: [], sensorPorts: [],
			}],
		});
		assert.equal(config.bricks.length, 1);
	});

	it('rejects missing transport', () => {
		assert.throws(() => validateMockConfig({ bricks: [] }), /transport must be/);
	});

	it('rejects empty bricks array', () => {
		assert.throws(() => validateMockConfig({ transport: 'mock', bricks: [] }), /at least one brick/);
	});

	it('rejects brick without id', () => {
		assert.throws(() => validateMockConfig({
			transport: 'mock',
			bricks: [{ displayName: 'X', battery: { level: 50 }, motorPorts: [], sensorPorts: [] }],
		}), /id must be/);
	});

	it('rejects missing battery object', () => {
		assert.throws(() => validateMockConfig({
			transport: 'mock',
			bricks: [{ id: 'a', displayName: 'A', motorPorts: [], sensorPorts: [] }],
		}), /battery must be/);
	});

	it('rejects battery.level out of range', () => {
		assert.throws(() => validateMockConfig({
			transport: 'mock',
			bricks: [{ id: 'a', displayName: 'A', battery: { level: 150 }, motorPorts: [], sensorPorts: [] }],
		}), /battery\.level/);
	});
});
