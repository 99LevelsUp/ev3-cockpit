/**
 * The telemetry service runs one loop per brick that someone wants read (step-6 plan U5;
 * IMPLEMENTATION_PLAN 3.3.2, 3.3.5, 3.7.3, 3.7.6; DESIGN §9.3).
 *
 * The active brick is read for the cockpit's panel; any other connected brick is read only for the
 * rows a claim names, at the interval it was granted. One loop per brick carries both: the
 * foreground is a claim like the others, so the active brick changing re-plans a loop rather than
 * restarting it, and a restart would read the static rows again and settle every port afresh.
 * Claims outlive a lost link and end with the session.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickId, BrickResponse, TransportProvider } from '../contracts';
import { ActivityMode, ConnectionState, Transport } from '../contracts/enums';
import { ErrorCode } from '../errors/CockpitError';
import { ProviderRegistry } from '../transports/providerRegistry';
import { createEv3RowRegistry } from '../telemetry/rowRegistry';
import { ClaimsEndedEvent, TelemetryService, TelemetryValuesEvent } from '../telemetry/telemetryService';
import type { TelemetryRow } from '../telemetry/telemetryRow';

const A = 'AAA' as BrickId;
const B = 'BBB' as BrickId;

function provider(transport: Transport, supportsTelemetryFrames = true): TransportProvider {
	return {
		transport,
		priority: 0,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames },
		discover: () => Promise.resolve({ transport, items: [] }),
		connect: () => Promise.reject(new Error('not used')),
		disconnect: () => Promise.resolve(),
		sendPacket: () => Promise.resolve(new Uint8Array()),
		dispose: () => { /* nothing held */ },
	};
}

type Listener<T> = (event: T) => void;

/** A brick layer the test drives by hand: sessions, the active brick and each brick's route. */
function fakeBricks() {
	const states = new Map<BrickId, ConnectionState>();
	const routes = new Map<BrickId, Transport>();
	let active: BrickId | undefined;
	/** The transport each frame went out on, in order; held sends wait for `releaseSends`. */
	const sent: (Transport | undefined)[] = [];
	const held: (() => void)[] = [];
	let holding = false;
	const onState: Listener<{ brickKey: BrickId; newState: ConnectionState }>[] = [];
	const onActive: Listener<{ previousBrickKey: BrickId | undefined; newBrickKey: BrickId | undefined }>[] = [];
	const onRoute: Listener<{ brickKey: BrickId }>[] = [];
	const disposable = { dispose: () => { /* listeners live as long as the test */ } };
	const listen = <T>(list: Listener<T>[]) => (listener: Listener<T>) => { list.push(listener); return disposable; };

	return {
		host: {
			send: (key: string): Promise<BrickResponse> => {
				sent.push(routes.get(key as BrickId));
				const reply: BrickResponse = { kind: 'telemetry:frame', payload: new Uint8Array(1024) };
				if (!holding) { return Promise.resolve(reply); }
				return new Promise((resolve) => { held.push(() => resolve(reply)); });
			},
			maxPacketBytes: () => 1024,
			transportOf: (key: string) => routes.get(key as BrickId),
			getActiveBrickKey: () => active,
			getSession: (key: string) => {
				const state = states.get(key as BrickId);
				return state === undefined ? undefined : { connectionState: state };
			},
			onSessionStateChange: listen(onState),
			onActiveBrickChange: listen(onActive),
			onRouteChange: listen(onRoute),
		},
		sent,
		holdSends() { holding = true; },
		releaseSends() { holding = false; for (const release of held.splice(0)) { release(); } },
		connect(brick: BrickId, transport = Transport.USB) {
			routes.set(brick, transport);
			states.set(brick, ConnectionState.Connected);
			for (const l of onState) { l({ brickKey: brick, newState: ConnectionState.Connected }); }
		},
		setActive(next: BrickId | undefined) {
			const previousBrickKey = active;
			active = next;
			for (const l of onActive) { l({ previousBrickKey, newBrickKey: next }); }
		},
		/** The link went; the brick is still signed in and comes back by itself. */
		loseLink(brick: BrickId) {
			routes.delete(brick);
			states.set(brick, ConnectionState.Reconnecting);
			for (const l of onState) { l({ brickKey: brick, newState: ConnectionState.Reconnecting }); }
		},
		disconnect(brick: BrickId) {
			routes.delete(brick);
			states.set(brick, ConnectionState.Disconnected);
			for (const l of onState) { l({ brickKey: brick, newState: ConnectionState.Disconnected }); }
		},
		/** As the brick layer signs a brick out: the sign-in is gone before the route event fires. */
		signOut(brick: BrickId) {
			routes.delete(brick);
			states.delete(brick);
			for (const l of onState) { l({ brickKey: brick, newState: ConnectionState.Reconnecting }); }
			for (const l of onRoute) { l({ brickKey: brick }); }
		},
		moveRoute(brick: BrickId, transport: Transport) {
			routes.set(brick, transport);
			for (const l of onState) { l({ brickKey: brick, newState: ConnectionState.Connected }); }
			for (const l of onRoute) { l({ brickKey: brick }); }
		},
	};
}

function world(options: { tickPeriodMs?: number } = {}) {
	const bricks = fakeBricks();
	const registry = new ProviderRegistry();
	registry.register(provider(Transport.USB));
	registry.register(provider(Transport.BT));
	registry.register(provider(Transport.TCP, false));
	const service = new TelemetryService({ host: bricks.host, providerRegistry: registry, ...options });
	return { bricks, service };
}

const idsOf = (rows: readonly TelemetryRow[] | undefined) => (rows ?? []).map((row) => row.id);
const shapeOf = (rows: readonly TelemetryRow[]) => rows.map((row) => [
	row.id, row.lifetime.kind === 'repeating' ? row.lifetime.divider : row.lifetime.kind,
]);
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('telemetry service — loops for claims (step-6 U5)', () => {
	it('reads the active brick as before: every row, sampled each tick, event rows every fifth, static once', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(A);
			bricks.setActive(A);

			const loop = service.loopFor(A);
			assert.deepEqual(shapeOf(loop?.rows ?? []), shapeOf(createEv3RowRegistry().all()));
			assert.equal(loop?.tickPeriodMs, 100);
		} finally {
			service.dispose();
		}
	});

	it('runs a second loop for a claimed brick that is not active, with only the rows claimed', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(A);
			bricks.connect(B);
			bricks.setActive(A);

			const ticket = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 400 }, 'ev3-c');

			assert.equal(service.modeOf(A), ActivityMode.Foreground);
			assert.equal(service.modeOf(B), ActivityMode.Subscribed);
			assert.deepEqual(idsOf(service.loopFor(B)?.rows), ['ports.motor.A.tacho']);
			assert.equal(service.loopFor(B)?.tickPeriodMs, 400);
			assert.deepEqual(ticket.grant, { 'ports.motor.A.tacho': 400 });
			assert.deepEqual(service.grantOf(ticket.handle), { 'ports.motor.A.tacho': 400 });
		} finally {
			service.dispose();
		}
	});

	it('stands a brick down to minimal when its last claim is released; a second release does nothing', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(B);
			const first = service.claim(B, { rowIds: ['system.battery.level'], intervalMs: 1000 }, 'one');
			const second = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'two');

			service.release(second.handle);
			assert.equal(service.modeOf(B), ActivityMode.Subscribed);
			assert.deepEqual(idsOf(service.loopFor(B)?.rows), ['system.battery.level']);
			assert.equal(service.loopFor(B)?.tickPeriodMs, 1000, 'the tick follows the claims that remain');

			service.release(first.handle);
			assert.equal(service.modeOf(B), ActivityMode.Minimal);
			assert.equal(service.loopFor(B), undefined);
			service.release(first.handle);
			assert.equal(service.grantOf(first.handle), undefined);
		} finally {
			service.dispose();
		}
	});

	it('keeps one loop through the active brick leaving and coming back, re-planned rather than restarted', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(A);
			bricks.connect(B);
			bricks.setActive(A);
			service.claim(A, { rowIds: ['ports.motor.A.tacho'], intervalMs: 300 }, 'ev3-c');
			const loop = service.loopFor(A);

			bricks.setActive(B);
			assert.equal(service.loopFor(A), loop, 'the same loop: retired one-shots and port modes kept');
			assert.equal(service.modeOf(A), ActivityMode.Subscribed);
			assert.deepEqual(idsOf(loop?.rows), ['ports.motor.A.tacho']);
			assert.equal(loop?.tickPeriodMs, 300);
			assert.equal(service.modeOf(B), ActivityMode.Foreground);

			bricks.setActive(A);
			assert.equal(service.loopFor(A), loop);
			assert.equal(service.modeOf(A), ActivityMode.Foreground);
			assert.equal(loop?.rows.length, createEv3RowRegistry().all().length);
			assert.equal(loop?.tickPeriodMs, 100);
			assert.equal(service.modeOf(B), ActivityMode.Minimal);
		} finally {
			service.dispose();
		}
	});

	it('keeps the claims while the link is lost and reads them again when it is back', () => {
		const { bricks, service } = world();
		const ended: ClaimsEndedEvent[] = [];
		service.onClaimsEnded((event) => ended.push(event));
		try {
			bricks.connect(B);
			const ticket = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');

			bricks.loseLink(B);
			assert.equal(service.loopFor(B), undefined, 'no link to compose frames for');
			assert.equal(service.modeOf(B), ActivityMode.Minimal);
			assert.deepEqual(service.grantOf(ticket.handle), { 'ports.motor.A.tacho': 200 });

			bricks.connect(B);
			assert.equal(service.modeOf(B), ActivityMode.Subscribed);
			assert.deepEqual(idsOf(service.loopFor(B)?.rows), ['ports.motor.A.tacho']);
			assert.deepEqual(ended, []);
		} finally {
			service.dispose();
		}
	});

	it('ends every claim on a brick that disconnects, and says which (4.5.4)', () => {
		const { bricks, service } = world();
		const ended: ClaimsEndedEvent[] = [];
		service.onClaimsEnded((event) => ended.push(event));
		try {
			bricks.connect(A);
			bricks.connect(B);
			const onB = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');
			const onA = service.claim(A, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');

			bricks.disconnect(B);

			assert.deepEqual(ended, [{ brickKey: B, handles: [onB.handle] }]);
			assert.equal(service.grantOf(onB.handle), undefined);
			assert.equal(service.loopFor(B), undefined);
			assert.equal(service.modeOf(B), ActivityMode.None, 'a disconnected session is no session');
			assert.equal(service.modeOf(A), ActivityMode.Subscribed, 'another brick\'s claims are untouched');

			bricks.connect(B);
			assert.equal(service.modeOf(B), ActivityMode.Minimal, 'an ended claim does not come back with the brick');
			assert.ok(service.grantOf(onA.handle));
		} finally {
			service.dispose();
		}
	});

	it('ends the claims of a brick that is signed out, whose session is gone before the event', () => {
		const { bricks, service } = world();
		const ended: ClaimsEndedEvent[] = [];
		service.onClaimsEnded((event) => ended.push(event));
		try {
			bricks.connect(B);
			const ticket = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');

			bricks.signOut(B);

			assert.deepEqual(ended, [{ brickKey: B, handles: [ticket.handle] }], 'ended once, not per event');
			assert.equal(service.modeOf(B), ActivityMode.None);
		} finally {
			service.dispose();
		}
	});

	it('says nothing when the active brick goes with no claim on it: the panel is not a consumer', () => {
		const { bricks, service } = world();
		const ended: ClaimsEndedEvent[] = [];
		service.onClaimsEnded((event) => ended.push(event));
		try {
			bricks.connect(A);
			bricks.setActive(A);

			bricks.signOut(A);

			assert.deepEqual(ended, []);
			assert.equal(service.loopFor(A), undefined);
		} finally {
			service.dispose();
		}
	});

	it('restarts a claimed brick that is not active at its new transport\'s floor; the grant stays (D2)', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(A);
			bricks.connect(B);
			bricks.setActive(A);
			const ticket = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 100 }, 'ev3-c');
			const before = service.loopFor(B);

			bricks.moveRoute(B, Transport.BT);

			const after = service.loopFor(B);
			assert.notEqual(after, before, 'the loop is built for one transport');
			assert.equal(after?.tickPeriodMs, 250, 'Bluetooth\'s floor');
			assert.deepEqual(service.grantOf(ticket.handle), { 'ports.motor.A.tacho': 100 });
		} finally {
			service.dispose();
		}
	});

	it('grants a claim against the brick\'s transport now, not the one its claims were last planned on', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(B);
			const first = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');
			service.release(first.handle);
			bricks.moveRoute(B, Transport.BT);

			const ticket = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 10 }, 'ev3-c');

			assert.deepEqual(ticket.grant, { 'ports.motor.A.tacho': 250 }, 'Bluetooth\'s floor, not USB\'s 50 ms');
		} finally {
			service.dispose();
		}
	});

	it('sends a restarted loop\'s first frame only after the retired loop\'s frame has settled', async () => {
		// The retired frame may command a sensor mode; arriving after the new loop's, it would switch the
		// device behind the new loop's back (review of U5, round 2).
		const { bricks, service } = world();
		try {
			bricks.connect(B);
			service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');
			bricks.holdSends();
			const retired = service.loopFor(B)?.runTick();
			bricks.moveRoute(B, Transport.BT);
			const fresh = service.loopFor(B)?.runTick();
			await new Promise((resolve) => setImmediate(resolve));

			assert.equal(bricks.sent.length, 1, 'one frame outstanding for the brick, not two');

			bricks.releaseSends();
			await retired;
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(bricks.sent.length, 2, 'the new loop\'s frame goes once the retired one settled');
			bricks.releaseSends();
			await fresh;
		} finally {
			bricks.releaseSends();
			service.dispose();
		}
	});

	it('sends nothing for a loop that was retired, or a service disposed, while its frame waited in the chain', async () => {
		const { bricks, service } = world();
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		const errors: unknown[] = [];
		service.onError((event) => errors.push(event.error));
		try {
			bricks.connect(B);
			service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');
			bricks.holdSends();
			void service.loopFor(B)?.runTick();
			bricks.moveRoute(B, Transport.BT);
			void service.loopFor(B)?.runTick();          // waits behind the first frame
			bricks.moveRoute(B, Transport.USB);          // ...and its loop is retired meanwhile
			void service.loopFor(B)?.runTick();
			await settle();

			bricks.releaseSends();
			await settle();
			await settle();
			assert.equal(bricks.sent.length, 2, 'the first frame and the current loop\'s, not the retired one\'s');
			assert.deepEqual(errors, [], 'a retired loop\'s refused frame is nobody\'s failure');

			bricks.holdSends();
			void service.loopFor(B)?.runTick();
			await settle();
			assert.equal(bricks.sent.length, 3);
			bricks.moveRoute(B, Transport.BT);
			void service.loopFor(B)?.runTick();          // waits behind the held frame
			await settle();
			service.dispose();
			bricks.releaseSends();
			await settle();
			await settle();
			assert.equal(bricks.sent.length, 3, 'nothing goes out for a disposed service');
		} finally {
			bricks.releaseSends();
			service.dispose();
		}
	});

	it('refuses a claim that could never be read, and adds nothing', () => {
		const { bricks, service } = world();
		try {
			assert.throws(() => service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c'),
				(error) => codeOf(error) === ErrorCode.NotConnected);

			bricks.connect(B, Transport.TCP);
			assert.throws(() => service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c'),
				(error) => codeOf(error) === ErrorCode.SubscriptionFailed, 'a link without telemetry frames');
			assert.equal(service.modeOf(B), ActivityMode.Minimal);
		} finally {
			service.dispose();
		}
	});

	it('gives every claim its own handle across bricks, so releasing one touches no other', () => {
		const { bricks, service } = world();
		try {
			bricks.connect(A);
			bricks.connect(B);
			const onA = service.claim(A, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');
			const onB = service.claim(B, { rowIds: ['ports.motor.A.tacho'], intervalMs: 200 }, 'ev3-c');
			assert.notEqual(onA.handle, onB.handle);

			service.release(onA.handle);
			assert.equal(service.modeOf(A), ActivityMode.Minimal);
			assert.equal(service.modeOf(B), ActivityMode.Subscribed);
		} finally {
			service.dispose();
		}
	});

	it('does not read a static row again for a claim made after the foreground read it', async () => {
		const { bricks, service } = world();
		const read: string[] = [];
		service.onValues((event: TelemetryValuesEvent) => {
			for (const value of event.values) { read.push(value.rowId); }
		});
		try {
			bricks.connect(A);
			bricks.setActive(A);
			await service.loopFor(A)?.runTick();
			assert.ok(read.includes('system.firmwareVersion'));
			read.length = 0;

			const ticket = service.claim(A, { rowIds: ['system.firmwareVersion'], intervalMs: 1000 }, 'info');
			await service.loopFor(A)?.runTick();
			await service.loopFor(A)?.runTick();

			assert.deepEqual(ticket.grant, { 'system.firmwareVersion': 'once' });
			assert.equal(read.filter((id) => id === 'system.firmwareVersion').length, 0,
				'the value the claim needs comes from the read model (U6), not a second read');
		} finally {
			service.dispose();
		}
	});

	it('keeps a tick override for the foreground, below the floor, as probes need, also when re-planned', () => {
		const { bricks, service } = world({ tickPeriodMs: 20 });
		try {
			bricks.connect(A);
			bricks.connect(B);
			bricks.setActive(A);
			assert.equal(service.loopFor(A)?.tickPeriodMs, 20);

			service.claim(A, { rowIds: ['ports.motor.A.tacho'], intervalMs: 300 }, 'ev3-c');
			bricks.setActive(B);
			bricks.setActive(A);
			assert.equal(service.loopFor(A)?.tickPeriodMs, 20, 'the timer and the plan agree on 20 ms');
		} finally {
			service.dispose();
		}
	});
});
