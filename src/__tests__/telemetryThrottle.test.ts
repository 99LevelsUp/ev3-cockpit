/**
 * Throttling in the telemetry service (step-6 plan U7; IMPLEMENTATION_PLAN 3.4.1, 3.4.3–3.4.5, 3.7.2;
 * DESIGN §4.5, §9.5).
 *
 * Each loop measures its frames' round trips; the brick's throttle moves its tick by a factor over
 * the plan's. Per brick: one slow brick does not slow another. A change re-announces the plan, so
 * `effectiveIntervalMs` in the data moves with it (D2), and the numbers are there for the display.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickId, BrickResponse, TransportProvider } from '../contracts';
import { ConnectionState, Transport } from '../contracts/enums';
import { ProviderRegistry } from '../transports/providerRegistry';
import { PlanChangeEvent, TelemetryService, ThrottleChangeEvent } from '../telemetry/telemetryService';
import type { ThrottleSettings } from '../telemetry/telemetrySettings';

const A = 'AAA' as BrickId;
const B = 'BBB' as BrickId;
const TACHO = 'ports.motor.A.tacho';
/** USB's usual round trip is 10 ms, so with tailFactor 3 the limit is 30 ms. */
const THROTTLE: ThrottleSettings = { enabled: true, windowSize: 5, tailFactor: 3, step: 1.5, maxSlowdown: 4, calmWindows: 2 };

function provider(transport: Transport): TransportProvider {
	return {
		transport,
		priority: 0,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: true },
		discover: () => Promise.resolve({ transport, items: [] }),
		connect: () => Promise.reject(new Error('not used')),
		disconnect: () => Promise.resolve(),
		sendPacket: () => Promise.resolve(new Uint8Array()),
		dispose: () => { /* nothing held */ },
	};
}

/** Two USB bricks, connected; each frame takes the brick's latency on a clock the test owns. */
function world(throttle: ThrottleSettings | null = THROTTLE) {
	let clock = 0;
	const latency = new Map<BrickId, number>([[A, 5], [B, 5]]);
	let active: BrickId | undefined;
	const disposable = { dispose: () => undefined };
	const activeListeners: ((e: { previousBrickKey: BrickId | undefined; newBrickKey: BrickId | undefined }) => void)[] = [];
	const host = {
		send: (key: string): Promise<BrickResponse> => {
			clock += latency.get(key as BrickId) ?? 0;
			return Promise.resolve({ kind: 'telemetry:frame', payload: new Uint8Array(1024) });
		},
		maxPacketBytes: () => 1024,
		transportOf: () => Transport.USB,
		getActiveBrickKey: () => active,
		getSession: () => ({ connectionState: ConnectionState.Connected }),
		onSessionStateChange: () => disposable,
		onActiveBrickChange: (l: (typeof activeListeners)[number]) => { activeListeners.push(l); return disposable; },
	};
	const registry = new ProviderRegistry();
	registry.register(provider(Transport.USB));
	const service = new TelemetryService({
		host, providerRegistry: registry, now: () => clock, ...(throttle ? { throttle } : {}),
	});
	const plans: PlanChangeEvent[] = [];
	const changes: ThrottleChangeEvent[] = [];
	service.onPlanChange((e) => plans.push(e));
	service.onThrottleChange((e) => changes.push(e));
	return {
		service, latency, plans, changes,
		setActive(next: BrickId | undefined) {
			const previousBrickKey = active;
			active = next;
			for (const l of activeListeners) { l({ previousBrickKey, newBrickKey: next }); }
		},
		/** Runs n frames of a brick's loop, one after another. */
		async frames(brick: BrickId, n: number) {
			for (let i = 0; i < n; i += 1) { await service.loopFor(brick)?.runTick(); }
		},
	};
}

describe('telemetry service — throttling (step-6 U7)', () => {
	it('slows a brick whose round trips grow, and says so in the plan and to the display', async () => {
		const w = world();
		try {
			w.service.claim(B, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.latency.set(B, 40);          // over the 30 ms limit
			w.plans.length = 0;

			await w.frames(B, 5);

			assert.equal(w.service.loopFor(B)?.tickPeriodMs, 150);
			assert.equal(w.plans.at(-1)?.intervals.get(TACHO), 150, 'effectiveIntervalMs moves with it (D2)');
			assert.equal(w.changes.at(-1)?.brickKey, B);
			assert.deepEqual(w.service.throttleOf(B), {
				factor: 1.5, limitMs: 30, p95Ms: 40, stalls: 5, windowSamples: 0, basePeriodMs: 100, periodMs: 150,
			});
		} finally {
			w.service.dispose();
		}
	});

	it('does not slow one brick for another\'s slowness', async () => {
		const w = world();
		try {
			w.service.claim(A, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.service.claim(B, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.latency.set(B, 40);

			await w.frames(A, 5);
			await w.frames(B, 5);

			assert.equal(w.service.loopFor(A)?.tickPeriodMs, 100);
			assert.equal(w.service.loopFor(B)?.tickPeriodMs, 150);
		} finally {
			w.service.dispose();
		}
	});

	it('speeds back up when the brick recovers, to the plan\'s tick and no faster', async () => {
		const w = world();
		try {
			w.service.claim(B, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.latency.set(B, 40);
			await w.frames(B, 5);
			w.latency.set(B, 5);

			await w.frames(B, 10);

			assert.equal(w.service.loopFor(B)?.tickPeriodMs, 100);
			assert.equal(w.service.throttleOf(B)?.factor, 1);
		} finally {
			w.service.dispose();
		}
	});

	it('keeps the brick\'s slowdown through a re-plan, over the new plan\'s tick', async () => {
		const w = world();
		try {
			w.service.claim(B, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.latency.set(B, 40);
			await w.frames(B, 5);

			w.service.claim(B, { rowIds: [TACHO], intervalMs: 60 }, 'ev3-c');

			assert.equal(w.service.loopFor(B)?.tickPeriodMs, 90, '60 ms planned, 1.5 times slower');
		} finally {
			w.service.dispose();
		}
	});

	it('follows a settings change at once: switched off, the plan\'s tick', async () => {
		const w = world();
		try {
			w.service.claim(B, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.latency.set(B, 40);
			await w.frames(B, 5);

			w.service.configureThrottle({ ...THROTTLE, enabled: false });

			assert.equal(w.service.loopFor(B)?.tickPeriodMs, 100);
			assert.equal(w.plans.at(-1)?.intervals.get(TACHO), 100);
		} finally {
			w.service.dispose();
		}
	});

	it('refuses settings out of range even when no brick is read yet (review 1)', () => {
		const w = world(null);
		try {
			assert.throws(() => w.service.configureThrottle({ ...THROTTLE, step: 1 }), /step/);
		} finally {
			w.service.dispose();
		}
	});

	it('does not throttle without throttle settings', async () => {
		const w = world(null);   // undefined would take the default
		try {
			w.service.claim(B, { rowIds: [TACHO], intervalMs: 100 }, 'ev3-c');
			w.latency.set(B, 400);

			await w.frames(B, 10);

			assert.equal(w.service.loopFor(B)?.tickPeriodMs, 100);
			assert.equal(w.service.throttleOf(B), undefined);
		} finally {
			w.service.dispose();
		}
	});
});
