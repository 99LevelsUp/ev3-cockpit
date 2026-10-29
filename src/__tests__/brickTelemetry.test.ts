/**
 * Telemetry over the per-brick command queue, and who decides to run it.
 *
 * Two properties carry this suite. The first is that a frame goes out as a queued
 * `telemetry:frame` rather than straight at the transport — that is what makes telemetry
 * take turns with the heartbeat instead of racing it. The second is that the packet budget
 * is re-read on every tick: a session survives a reconnect that a *link* does not, so a USB
 * brick can come back on the 64-byte HID fallback under a loop built for libusb's 1024.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickKey, BrickResponse, TransportProvider } from '../contracts';
import { makeBrickKey } from '../contracts/brickKey';
import { ActivityMode, ConnectionState, Transport } from '../contracts/enums';
import { ProviderRegistry } from '../transports/providerRegistry';
import { createBrickTelemetry, frameLimitsFor } from '../telemetry/brickTelemetry';
import { TelemetryService } from '../telemetry/telemetryService';
import { TELEMETRY_CADENCE, cadenceFor } from '../telemetry/telemetryConstants';
import { RowLifetime, TelemetryRow } from '../telemetry/telemetryRow';

const USB_KEY = makeBrickKey(Transport.USB, '0016535D7E2D');
const MOCK_KEY = makeBrickKey(Transport.Mock, 'brick-a');

function row(id: string, bytes = 1, lifetime?: RowLifetime): TelemetryRow {
	return {
		id,
		tier: 'sampled',
		lifetime: lifetime ?? { kind: 'repeating', divider: 1 },
		result: { bytes, alignment: bytes === 4 ? 4 : 1 },
		emit: (slot) => new Uint8Array([0xaa, slot & 0xff]),
		parse: (payload, slot, sampledAt) => ({ rowId: id, value: payload[slot], sampledAt }),
	};
}

/** Records every command that reached the queue, and answers frames with zeroed globals. */
function recordingHost(maxPacketBytes?: () => number | undefined) {
	const commands: BrickCommand[] = [];
	return {
		commands,
		send: (_key: BrickKey, command: BrickCommand): Promise<BrickResponse> => {
			commands.push(command);
			if (command.kind !== 'telemetry:frame') {
				throw new Error(`unexpected command ${command.kind}`);
			}
			return Promise.resolve({ kind: 'telemetry:frame', payload: new Uint8Array(64) });
		},
		maxPacketBytes: maxPacketBytes ? () => maxPacketBytes() : undefined,
	};
}

describe('brick telemetry — routing through the queue', () => {
	it('sends a composed frame as a queued telemetry:frame command', async () => {
		const host = recordingHost(() => 1024);
		const telemetry = createBrickTelemetry({
			sender: host, brickKey: USB_KEY, rows: [row('a'), row('b')],
		});

		await telemetry.runTick();

		assert.equal(host.commands.length, 1, 'one frame, one command');
		const [command] = host.commands;
		assert.equal(command.kind, 'telemetry:frame');
		assert.ok(
			command.kind === 'telemetry:frame' && command.payload.length > 0,
			'the frame carries its declared globals and bytecode',
		);
		assert.equal(telemetry.stats.framesSent, 1);
	});

	it('refuses a reply that came back as another command', async () => {
		// The counter-to-reply pairing is wrong somewhere below if this happens. Handing the
		// row parser somebody else's buffer produces readings that look plausible and came
		// from nowhere, so this must surface rather than be coerced.
		const errors: unknown[] = [];
		const telemetry = createBrickTelemetry({
			sender: {
				send: () => Promise.resolve({ kind: 'battery', level: 50 } as BrickResponse),
				maxPacketBytes: () => 1024,
			},
			brickKey: USB_KEY,
			rows: [row('a')],
			onError: (error) => errors.push(error),
		});

		await telemetry.runTick();

		assert.equal(telemetry.stats.framesSent, 0);
		assert.equal(telemetry.stats.framesFailed, 1);
		assert.match(String(errors[0]), /came back as 'battery'/);
	});
});

describe('brick telemetry — the packet budget is the link\'s, not the session\'s', () => {
	it('narrows the frame when the link falls back to HID mid-session', async () => {
		// `attemptReconnect` reuses its SessionResources and only rewires the executor, so
		// this loop outlives the link it was built for. Twenty 4-byte rows declare 80 bytes
		// of globals: comfortable inside libusb's 1019, past HID's 59. If limits were read
		// once, the second tick would compose the same wide frame for a link a sixteenth the
		// size — and the firmware answers a truncated request rather than complaining.
		let packetBytes = 1024;
		const host = recordingHost(() => packetBytes);
		const rows = Array.from({ length: 20 }, (_, i) => row(`r${i}`, 4));
		const telemetry = createBrickTelemetry({ sender: host, brickKey: USB_KEY, rows });

		await telemetry.runTick();
		const overLibusb = host.commands.length;

		packetBytes = 64;
		await telemetry.runTick();

		const wide = host.commands[0];
		const narrow = host.commands[1];
		assert.equal(overLibusb, 1);
		assert.ok(
			wide.kind === 'telemetry:frame' && narrow.kind === 'telemetry:frame'
			&& narrow.payload.length < wide.payload.length,
			`the HID frame must be smaller: ${
				narrow.kind === 'telemetry:frame' ? narrow.payload.length : '?'} vs ${
				wide.kind === 'telemetry:frame' ? wide.payload.length : '?'}`,
		);
	});

	it('falls back to the transport floor when the link cannot say', () => {
		// USB with no live figure means the HID floor, not the firmware's 1024: chunking
		// small is slow, chunking large is silent truncation.
		assert.equal(frameLimitsFor({ send: () => { throw new Error('unused'); } }, USB_KEY)
			.maxPacketBytes, 64);
	});
});

describe('telemetry cadence', () => {
	it('gives Bluetooth the slowest tick, because it has the least to give', () => {
		// 10.7 commands a second total (DESIGN §9.2), and the heartbeat plus the user's own
		// commands come out of the same budget.
		assert.ok(TELEMETRY_CADENCE[Transport.BT].foregroundMs
			> TELEMETRY_CADENCE[Transport.TCP].foregroundMs);
		assert.ok(TELEMETRY_CADENCE[Transport.TCP].foregroundMs
			> TELEMETRY_CADENCE[Transport.USB].foregroundMs);
	});

	it('never lets a floor sit above its own target', () => {
		for (const transport of Object.values(Transport)) {
			const cadence = TELEMETRY_CADENCE[transport];
			assert.ok(cadence.floorMs <= cadence.foregroundMs, `${transport} floor above target`);
		}
	});

	it('treats an unknown transport as the slowest one measured', () => {
		// Guessing fast on a link that cannot carry it starves the heartbeat; guessing slow
		// only makes the panel slower.
		assert.deepEqual(cadenceFor(undefined), TELEMETRY_CADENCE[Transport.BT]);
	});

	it('takes the transport cadence when the caller names no period', () => {
		const telemetry = createBrickTelemetry({
			sender: recordingHost(() => 1024), brickKey: USB_KEY, rows: [row('a')],
		});
		assert.equal(telemetry.tickPeriodMs, TELEMETRY_CADENCE[Transport.USB].foregroundMs);
	});
});

// ── The service ─────────────────────────────────────────────────────

function fakeProvider(transport: Transport, supportsTelemetryFrames: boolean): TransportProvider {
	return {
		transport,
		capabilities: {
			supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames,
		},
		discover: () => Promise.resolve({ transport, items: [] }),
		connect: () => Promise.resolve({ brickKey: USB_KEY, transport }),
		disconnect: () => Promise.resolve(),
		sendPacket: () => Promise.resolve(new Uint8Array()),
		dispose: () => { /* nothing held */ },
	};
}

/** A host whose active brick and session states the test drives by hand. */
function fakeHost(states: Map<BrickKey, ConnectionState>) {
	const stateListeners: ((e: { brickKey: BrickKey; newState: ConnectionState }) => void)[] = [];
	const activeListeners: ((e: {
		previousBrickKey: BrickKey | undefined; newBrickKey: BrickKey | undefined;
	}) => void)[] = [];
	let active: BrickKey | undefined;

	const disposable = { dispose: () => { /* listeners live as long as the test */ } };
	return {
		host: {
			send: (): Promise<BrickResponse> =>
				Promise.resolve({ kind: 'telemetry:frame', payload: new Uint8Array(64) }),
			maxPacketBytes: () => 1024,
			getActiveBrickKey: () => active,
			getSession: (key: BrickKey) => {
				const state = states.get(key);
				return state === undefined ? undefined : { connectionState: state };
			},
			onSessionStateChange: (listener: (e: {
				brickKey: BrickKey; newState: ConnectionState;
			}) => void) => { stateListeners.push(listener); return disposable; },
			onActiveBrickChange: (listener: (e: {
				previousBrickKey: BrickKey | undefined; newBrickKey: BrickKey | undefined;
			}) => void) => { activeListeners.push(listener); return disposable; },
		},
		setActive(next: BrickKey | undefined) {
			const previousBrickKey = active;
			active = next;
			for (const l of activeListeners) { l({ previousBrickKey, newBrickKey: next }); }
		},
		setState(brickKey: BrickKey, newState: ConnectionState) {
			states.set(brickKey, newState);
			for (const l of stateListeners) { l({ brickKey, newState }); }
		},
	};
}

describe('telemetry service — who runs a loop', () => {
	it('runs the active connected brick in foreground and everything else minimal', () => {
		const other = makeBrickKey(Transport.USB, 'OTHER');
		const states = new Map([
			[USB_KEY, ConnectionState.Connected],
			[other, ConnectionState.Connected],
		]);
		const driver = fakeHost(states);
		const registry = new ProviderRegistry();
		registry.register(fakeProvider(Transport.USB, true));

		const service = new TelemetryService({ host: driver.host, providerRegistry: registry });
		try {
			driver.setActive(USB_KEY);
			assert.equal(service.modeOf(USB_KEY), ActivityMode.Foreground);
			assert.equal(service.modeOf(other), ActivityMode.Minimal,
				'a connected brick that is not active keeps its heartbeat and nothing more');
		} finally {
			service.dispose();
		}
	});

	it('hands the loop over when the active brick changes', () => {
		const other = makeBrickKey(Transport.USB, 'OTHER');
		const states = new Map([
			[USB_KEY, ConnectionState.Connected],
			[other, ConnectionState.Connected],
		]);
		const driver = fakeHost(states);
		const registry = new ProviderRegistry();
		registry.register(fakeProvider(Transport.USB, true));

		const service = new TelemetryService({ host: driver.host, providerRegistry: registry });
		try {
			driver.setActive(USB_KEY);
			driver.setActive(other);
			assert.equal(service.modeOf(USB_KEY), ActivityMode.Minimal, 'the old brick stood down');
			assert.equal(service.modeOf(other), ActivityMode.Foreground);
		} finally {
			service.dispose();
		}
	});

	it('stops the loop when the active brick stops being connected', () => {
		const states = new Map([[USB_KEY, ConnectionState.Connected]]);
		const driver = fakeHost(states);
		const registry = new ProviderRegistry();
		registry.register(fakeProvider(Transport.USB, true));

		const service = new TelemetryService({ host: driver.host, providerRegistry: registry });
		try {
			driver.setActive(USB_KEY);
			assert.equal(service.modeOf(USB_KEY), ActivityMode.Foreground);

			driver.setState(USB_KEY, ConnectionState.Reconnecting);
			assert.equal(service.modeOf(USB_KEY), ActivityMode.Minimal,
				'a reconnecting brick has no link to compose frames for');

			driver.setState(USB_KEY, ConnectionState.Connected);
			assert.equal(service.modeOf(USB_KEY), ActivityMode.Foreground, 'and it comes back');
		} finally {
			service.dispose();
		}
	});

	it('leaves a transport that cannot execute frames alone', () => {
		// The mock dispatches typed commands and has no bytecode interpreter. Starting a loop
		// on it would throw once per tick for as long as the brick stayed active.
		const states = new Map([[MOCK_KEY, ConnectionState.Connected]]);
		const driver = fakeHost(states);
		const registry = new ProviderRegistry();
		registry.register(fakeProvider(Transport.Mock, false));

		const service = new TelemetryService({ host: driver.host, providerRegistry: registry });
		try {
			driver.setActive(MOCK_KEY);
			assert.equal(service.modeOf(MOCK_KEY), ActivityMode.Minimal);
			assert.equal(service.loopFor(MOCK_KEY), undefined);
		} finally {
			service.dispose();
		}
	});
});
