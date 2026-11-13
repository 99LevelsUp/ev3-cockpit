/**
 * While a program runs, its brick's telemetry slows down (step-6 plan U9; owner decision D11).
 *
 * Measured on three bricks: each telemetry command costs a running program about 2 ms, whoever
 * asked for it, and at the USB foreground cadence that broke the rule written before the run.
 * So while the program row says running, the tick is at least the user's `programRunningTickMs`
 * — for the panel and every consumer; their grants stay, `effectiveIntervalMs` shows the reads.
 *
 * The fake brick answers frames with the mock's own interpreter, so the program state reaches the
 * service through the real bytecode, not a shortcut.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickId, BrickResponse, TransportProvider } from '../contracts';
import { ConnectionState, Transport } from '../contracts/enums';
import { executeTelemetryFrame, MockBrickView } from '../mock/mockFrameInterpreter';
import { ProviderRegistry } from '../transports/providerRegistry';
import { PlanChangeEvent, TelemetryService } from '../telemetry/telemetryService';

const A = 'AAA' as BrickId;
const TACHO = 'ports.motor.A.tacho';

function provider(transport: Transport): TransportProvider {
	return {
		transport, priority: 0,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: true },
		discover: () => Promise.resolve({ transport, items: [] }),
		connect: () => Promise.reject(new Error('not used')),
		disconnect: () => Promise.resolve(),
		sendPacket: () => Promise.resolve(new Uint8Array()),
		dispose: () => { /* nothing held */ },
	};
}

function world(programRunningTickMs: number, transport = Transport.USB) {
	let programRunning = false;
	const empty = { typeCode: 126, mode: 0, value: Number.NaN };
	const view: MockBrickView = {
		sensor: () => empty, motor: () => empty,
		batteryLevel: 80, batteryVoltage: 7.5, brickName: 'AAA', firmwareVersion: 'V1.10E',
		bluetoothOn: true, bluetoothVisible: true, bluetoothPeers: 0, wifiOn: false, wifiPresent: false,
		get programRunning() { return programRunning; },
	};
	const listeners = { state: [] as ((e: { brickKey: BrickId; newState: ConnectionState }) => void)[] };
	const none = { dispose: () => { /* lives as long as the test */ } };
	const host = {
		send: (_key: string, command: { kind: string; payload?: Uint8Array }): Promise<BrickResponse> =>
			Promise.resolve({ kind: 'telemetry:frame', payload: executeTelemetryFrame(command.payload as Uint8Array, view) } as BrickResponse),
		maxPacketBytes: () => 1024,
		transportOf: () => transport,
		getActiveBrickKey: () => A,
		getSession: () => ({ connectionState: ConnectionState.Connected }),
		onSessionStateChange: (l: (e: { brickKey: BrickId; newState: ConnectionState }) => void) => { listeners.state.push(l); return none; },
		onActiveBrickChange: () => none,
		onRouteChange: () => none,
	};
	const registry = new ProviderRegistry();
	registry.register(provider(transport));
	const service = new TelemetryService({ host, providerRegistry: registry, programPreset: { programRunningTickMs, programStatusIntervalMs: 1000 } });
	const plans: PlanChangeEvent[] = [];
	service.onPlanChange((e) => plans.push(e));
	const loop = () => {
		const running = service.loopFor(A);
		assert.ok(running, 'the active brick runs a loop');
		return running;
	};
	return {
		service, plans, loop,
		program(on: boolean) { programRunning = on; },
		/** Ticks until the event-tier program row has come up and been read. */
		async read() { for (let i = 0; i < 5; i += 1) { await loop().runTick(); } },
	};
}

describe('Telemetry while a program runs (step-6 U9, D11)', () => {
	it('slows the loop to the floor while the program row says running, and comes back after', async () => {
		const w = world(200);
		try {
			assert.equal(w.loop().tickPeriodMs, 100, 'the USB foreground cadence');

			w.program(true);
			await w.read();
			assert.equal(w.loop().tickPeriodMs, 200);
			assert.equal(w.plans.at(-1)?.intervals.get(TACHO), 200, 'the read model hears the slower reads');

			w.program(false);
			await w.read();
			assert.equal(w.loop().tickPeriodMs, 100);
			assert.equal(w.plans.at(-1)?.intervals.get(TACHO), 100);
		} finally {
			w.service.dispose();
		}
	});

	it('leaves a tick that is already slower than the floor as it is', async () => {
		const w = world(200, Transport.BT);
		try {
			assert.equal(w.loop().tickPeriodMs, 500);
			w.program(true);
			await w.read();
			assert.equal(w.loop().tickPeriodMs, 500);
		} finally {
			w.service.dispose();
		}
	});

	it('does nothing with the preset at 0', async () => {
		const w = world(0);
		try {
			w.program(true);
			await w.read();
			assert.equal(w.loop().tickPeriodMs, 100);
		} finally {
			w.service.dispose();
		}
	});

	it('applies a changed setting at once, also while a program runs, and refuses one out of range', async () => {
		const w = world(200);
		try {
			w.program(true);
			await w.read();
			w.service.configureProgramPreset({ programRunningTickMs: 300, programStatusIntervalMs: 1000 });
			assert.equal(w.loop().tickPeriodMs, 300);
			w.service.configureProgramPreset({ programRunningTickMs: 0, programStatusIntervalMs: 1000 });
			assert.equal(w.loop().tickPeriodMs, 100, 'turned off while the program still runs');
			assert.throws(() => w.service.configureProgramPreset({ programRunningTickMs: -1, programStatusIntervalMs: 1000 }), /programRunningTickMs/);
		} finally {
			w.service.dispose();
		}
	});
});
