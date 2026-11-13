/**
 * Telemetry on the public API (step-6 plan U8; IMPLEMENTATION_PLAN 4.5.1–4.5.5; DESIGN §9.3, §9.6;
 * KTD6; owner decisions D2, D6, D7, D10).
 *
 * A consumer subscribes to rows of a brick at an interval; it gets back what each row was granted,
 * then a snapshot, then only the rows that changed — each value with when it was sampled, the
 * interval it runs at now and whether it is stale. Disposing the handle releases exactly that claim;
 * a brick that goes ends its subscriptions and says so. Every error carries a stable code.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, Transport, brickIdOf, makeBrickKey } from '../contracts';
import { ChannelState } from '../contracts/enums';
import { CockpitApiDeps, TelemetryUpdate, createCockpitApi } from '../api/cockpitApi';
import { ErrorCode, ModeConflictError } from '../errors/CockpitError';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from '../mock';
import { createRuntime } from '../runtime/createRuntime';
import type { ReadModelChange, ReadValue } from '../telemetry/telemetryReadModel';
import { telemetrySettingsFromPackage, throttleSettingsFromPackage } from '../telemetry/telemetrySettings';
import { waitFor } from './waitFor';

const A = 'AAA' as BrickId;
const B = 'BBB' as BrickId;
const TACHO = 'ports.motor.A.tacho';
const BATTERY = 'system.battery.level';
const disposable = { dispose: () => undefined };
const turn = () => new Promise((resolve) => setImmediate(resolve));
/**
 * Lets the delivery run out. Updates go out asynchronously, one batch per turn of the event loop,
 * and what a listener causes goes out in the turn after (review 3); a few turns cover every chain
 * these tests start.
 */
const settle = async () => { for (let i = 0; i < 5; i++) { await turn(); } };
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

const entry = (brickId: BrickId): BrickEntry => ({
	brickId, name: { value: brickId, source: 'brick', confirmed: true }, paired: false,
	channels: [{ brickKey: `usb:${brickId}`, transport: Transport.USB, state: ChannelState.Connected }],
} as unknown as BrickEntry);

const value = (rowId: string, v: ReadValue['value'], extra: Partial<ReadValue> = {}): ReadValue =>
	({ rowId, value: v, sampledAt: 10, effectiveIntervalMs: 100, stale: false, ...extra });

/** The API over stand-ins: a telemetry service and read model the test drives. */
function world() {
	const claims: { brickId: BrickId; rowIds: readonly string[]; intervalMs: number; owner: string; handle: string }[] = [];
	const released: string[] = [];
	const changeListeners: ((change: ReadModelChange) => void)[] = [];
	const endedListeners: ((e: { brickKey: BrickId; handles: readonly string[] }) => void)[] = [];
	const values = new Map<BrickId, ReadValue[]>();
	let next = 1;
	let refuse: Error | undefined;
	let duringClaim: (() => void) | undefined;
	/** As the product's emitter does: listeners as they were at the fire, and a dispose that removes. */
	const listen = <T>(list: T[], listener: T) => {
		list.push(listener);
		return { dispose: () => { const at = list.indexOf(listener); if (at >= 0) { list.splice(at, 1); } } };
	};

	const deps: CockpitApiDeps = {
		bricks: {
			send: () => Promise.reject(new Error('not used')),
			getActiveBrickId: () => A,
			setActiveBrick: () => undefined,
			signOut: () => Promise.resolve(),
			isSignedIn: () => true,
			onActiveBrickChange: () => disposable,
		},
		aggregator: { getDiscoveryList: () => [entry(A), entry(B)], onListChanged: () => disposable },
		connect: () => Promise.resolve(),
		accessMode: () => 'safe',
		onAccessModeChange: () => disposable,
		telemetry: {
			rows: () => [{ id: TACHO, tier: 'sampled', unit: 'deg', port: 'A' }, { id: BATTERY, tier: 'event', unit: '%' }],
			claim: (brickKey, request, owner) => {
				if (refuse) { throw refuse; }
				const handle = `telemetry-${next++}`;
				claims.push({ brickId: brickKey as BrickId, rowIds: request.rowIds, intervalMs: request.intervalMs, owner, handle });
				duringClaim?.();
				return { handle, grant: Object.fromEntries(request.rowIds.map((id) => [id, Math.max(request.intervalMs, 50)])) };
			},
			release: (handle) => { released.push(handle); },
			onClaimsEnded: (listener) => listen(endedListeners, listener as (typeof endedListeners)[number]),
			snapshot: (brickKey, rowIds) => (values.get(brickKey as BrickId) ?? []).filter((v) => !rowIds || rowIds.includes(v.rowId)),
			onChange: (listener) => listen(changeListeners, listener),
		},
	};
	const api = createCockpitApi(deps);
	return {
		api, claims, released, values,
		refuseWith(error: Error) { refuse = error; },
		/** Runs inside the next claims, as a read model that announces on a claim would. */
		onClaim(work: () => void) { duringClaim = work; },
		/** How many listeners the API keeps on the telemetry source. */
		listening: () => changeListeners.length + endedListeners.length,
		/** As the read model does: the values move, then the listeners hear it. */
		change(change: ReadModelChange) {
			const brick = change.brickKey as BrickId;
			const kept = (values.get(brick) ?? []).filter((v) => !change.removed.includes(v.rowId)
				&& !change.rows.some((r) => r.rowId === v.rowId));
			values.set(brick, [...kept, ...change.rows]);
			for (const l of [...changeListeners]) { l(change); }
		},
		end(brickKey: BrickId, handles: string[]) { for (const l of [...endedListeners]) { l({ brickKey, handles }); } },
	};
}

describe('Telemetry on the API (step-6 U8)', () => {
	it('lists the rows a consumer can subscribe to, as plain data (4.5.1)', () => {
		const w = world();
		const rows = w.api.registerConsumer('ev3-c').listTelemetryRows();
		assert.deepEqual(rows, [{ id: TACHO, tier: 'sampled', unit: 'deg', port: 'A' }, { id: BATTERY, tier: 'event', unit: '%' }]);
	});

	it('claims for the consumer, names the brick, and hands back what each row was granted (4.5.1)', () => {
		const w = world();
		const sub = w.api.registerConsumer('ev3-c').subscribeTelemetry('active', { rows: [TACHO], intervalMs: 20 }, () => undefined);

		assert.equal(sub.brickId, A, "'active' resolved at the call");
		assert.deepEqual(sub.grant, { [TACHO]: 50 });
		assert.deepEqual(w.claims.map((c) => [c.brickId, c.rowIds, c.intervalMs, c.owner]), [[A, [TACHO], 20, 'ev3-c']]);
	});

	it('sends a snapshot first, then only the rows of this subscription that changed, losing none in between (4.5.2, D10)', async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90), value(BATTERY, 80)]);
		const updates: TelemetryUpdate[] = [];
		w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));
		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });   // after the claim, before the snapshot went out

		await settle();
		w.change({ brickKey: A, rows: [value(TACHO, 92, { stale: true, effectiveIntervalMs: 150 })], removed: [] });
		w.change({ brickKey: A, rows: [value(BATTERY, 79)], removed: [] });  // not claimed here
		w.change({ brickKey: B, rows: [value(TACHO, 1)], removed: [] });      // another brick
		w.change({ brickKey: A, rows: [], removed: [BATTERY] });             // a row not subscribed here, dropped
		w.change({ brickKey: A, rows: [], removed: [TACHO] });
		await settle();

		assert.deepEqual(updates.map((u) => [u.kind, u.values.map((v) => v.value), u.removed]), [
			['snapshot', [90], []],
			['change', [91], []],
			['change', [92], []],
			['change', [], [TACHO]],
		]);
		assert.equal(updates[2].brickId, A);
		assert.deepEqual([updates[2].values[0].stale, updates[2].values[0].effectiveIntervalMs], [true, 150],
			'the effective interval travels in the data (D2)');
	});

	it('answers a snapshot on demand, as plain data', () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90), value(BATTERY, 80)]);
		const sub = w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		assert.deepEqual(sub.snapshot(), [value(TACHO, 90)]);
	});

	it('releases exactly its own claim when disposed, and hears nothing more (4.5.3)', async () => {
		const w = world();
		const updates: TelemetryUpdate[] = [];
		const consumer = w.api.registerConsumer('ev3-c');
		const first = consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 200 }, () => undefined);
		await settle();
		updates.length = 0;

		first.dispose();
		first.dispose();
		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });

		assert.deepEqual(w.released, [w.claims[0].handle]);
		assert.deepEqual(updates, []);
	});

	it('ends with the brick: says so once, and releases nothing that already ended (4.5.4)', async () => {
		const w = world();
		const updates: TelemetryUpdate[] = [];
		const sub = w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));
		await settle();

		w.end(A, [w.claims[0].handle]);
		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });
		await settle();
		sub.dispose();

		assert.deepEqual(updates.slice(1).map((u) => u.kind), ['ended']);
		assert.deepEqual(w.released, []);
	});

	it('says snapshot before ended even when the brick goes at once (review 1)', async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90)]);
		const updates: TelemetryUpdate[] = [];
		w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));
		w.change({ brickKey: A, rows: [value(TACHO, 91, { stale: true })], removed: [] });
		w.end(A, [w.claims[0].handle]);
		w.change({ brickKey: A, rows: [value(TACHO, 92)], removed: [] });   // after the end: not this subscription's

		await settle();

		assert.deepEqual(updates.map((u) => u.kind), ['snapshot', 'change', 'ended']);
		assert.deepEqual(w.released, []);
	});

	it('loses no queued change when the snapshot listener itself ends the brick (review 2)', async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90)]);
		const updates: TelemetryUpdate[] = [];
		w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => {
			updates.push(u);
			if (u.kind === 'snapshot') { w.end(A, [w.claims[0].handle]); }   // e.g. it signs the brick out
		});
		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });   // queued behind the snapshot

		await settle();

		assert.deepEqual(updates.map((u) => [u.kind, u.values.map((v) => v.value)]),
			[['snapshot', [90]], ['change', [91]], ['ended', []]]);
	});

	it("does not let one consumer's listener cut another consumer's change short by ending the brick (review 3)", async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90)]);
		const heard: TelemetryUpdate[] = [];
		w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => {
			if (u.kind === 'change') { w.end(A, w.claims.map((c) => c.handle)); }   // e.g. it signs the brick out
		});
		w.api.registerConsumer('ev3-explorer').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => heard.push(u));
		await settle();

		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });
		await settle();

		assert.deepEqual(heard.map((u) => [u.kind, u.values.map((v) => v.value)]),
			[['snapshot', [90]], ['change', [91]], ['ended', []]]);
	});

	it("tells every subscription the older change first when a listener causes a newer one (review 3)", async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90)]);
		const heard: TelemetryUpdate[] = [];
		const consumer = w.api.registerConsumer('ev3-c');
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => {
			if (u.kind === 'change' && u.values[0].value === 91) { w.change({ brickKey: A, rows: [value(TACHO, 92)], removed: [] }); }
		});
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => heard.push(u));
		await settle();

		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });
		await settle();

		assert.deepEqual(heard.map((u) => [u.kind, u.values.map((v) => v.value)]),
			[['snapshot', [90]], ['change', [91]], ['change', [92]]]);
	});

	it('gives a subscription made inside a listener the change in its snapshot, and not again (review 3)', async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90)]);
		const late: TelemetryUpdate[] = [];
		const consumer = w.api.registerConsumer('ev3-c');
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => {
			if (u.kind === 'change' && late.length === 0) {
				consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (v) => late.push(v));
			}
		});
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		await settle();

		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });
		await settle();

		assert.deepEqual(late.map((u) => [u.kind, u.values.map((v) => v.value)]), [['snapshot', [91]]]);
	});

	it("does not tell a subscription the change its own claim caused twice (review 3)", async () => {
		const w = world();
		w.values.set(A, [value(TACHO, 90)]);
		const updates: TelemetryUpdate[] = [];
		w.onClaim(() => w.change({ brickKey: A, rows: [value(TACHO, 95)], removed: [] }));
		w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));

		await settle();

		assert.deepEqual(updates.map((u) => [u.kind, u.values.map((v) => v.value)]), [['snapshot', [95]]]);
	});

	it('tells a disposed subscription nothing that was already on its way (review 3)', async () => {
		const w = world();
		const updates: TelemetryUpdate[] = [];
		const sub = w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));
		await settle();
		updates.length = 0;

		w.change({ brickKey: A, rows: [value(TACHO, 91)], removed: [] });
		sub.dispose();
		await settle();

		assert.deepEqual(updates, []);
	});

	it('keeps the extension host responsive when every change a listener hears makes another (review 3)', async () => {
		const w = world();
		let heard = 0;
		w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => {
			if (u.kind !== 'change' || ++heard >= 10_000) { return; }   // a ceiling, so a regression cannot hang the run
			w.change({ brickKey: A, rows: [value(TACHO, heard)], removed: [] });
		});
		await settle();

		w.change({ brickKey: A, rows: [value(TACHO, 0)], removed: [] });
		await turn();

		assert.ok(heard > 0 && heard < 100, `one turn of the event loop delivered ${heard} changes`);
		w.api.dispose();   // ends the loop
	});

	it('listens to the telemetry source once for all subscriptions, and stops with the API (review 3)', () => {
		const w = world();
		const consumer = w.api.registerConsumer('ev3-c');
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		consumer.subscribeTelemetry(B, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		w.api.registerConsumer('ev3-explorer').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		assert.equal(w.listening(), 2);

		w.api.dispose();
		assert.equal(w.listening(), 0);
	});

	it('releases nothing for a subscription disposed after its brick went, before its snapshot (review 1)', async () => {
		const w = world();
		const sub = w.api.registerConsumer('ev3-c').subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		w.end(A, [w.claims[0].handle]);

		sub.dispose();
		await settle();

		assert.deepEqual(w.released, []);
	});

	it('releases nothing twice when a listener disposes on hearing ended (review 1)', async () => {
		const w = world();
		const consumer = w.api.registerConsumer('ev3-c');
		const sub = consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, (u) => {
			if (u.kind === 'ended') { sub.dispose(); consumer.dispose(); }
		});
		await settle();

		w.end(A, [w.claims[0].handle]);
		await settle();

		assert.deepEqual(w.released, [], 'the claim ended with the brick: there is nothing to release');
	});

	it('ends every subscription of a consumer that unregisters', () => {
		const w = world();
		const consumer = w.api.registerConsumer('ev3-c');
		consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined);
		consumer.subscribeTelemetry(B, { rows: [BATTERY], intervalMs: 1000 }, () => undefined);

		consumer.dispose();

		assert.deepEqual(w.released.sort(), w.claims.map((c) => c.handle).sort());
		assert.throws(() => consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100 }, () => undefined),
			(e) => codeOf(e) === ErrorCode.ConsumerFailed);
	});

	it('gives every refusal a stable code (KTD6)', () => {
		const w = world();
		const consumer = w.api.registerConsumer('ev3-c');

		w.refuseWith(new ModeConflictError('Port 1 is read in mode 2 for ev3-explorer; release that claim first.'));
		assert.throws(() => consumer.subscribeTelemetry(A, { rows: [TACHO], intervalMs: 100, modes: { 1: 0 } }, () => undefined),
			(e) => codeOf(e) === ErrorCode.ModeConflict);
		w.refuseWith(new Error("There is no telemetry row 'x.y'; list the rows for their ids."));
		assert.throws(() => consumer.subscribeTelemetry(A, { rows: ['x.y'], intervalMs: 100 }, () => undefined),
			(e) => codeOf(e) === ErrorCode.SubscriptionFailed && /x\.y/.test((e as Error).message));
		assert.throws(() => consumer.subscribeTelemetry('CCC', { rows: [TACHO], intervalMs: 100 }, () => undefined),
			(e) => codeOf(e) === ErrorCode.NotConnected);
	});

	it('works end to end over the shipped runtime and a mock brick (4.5.5)', async () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown;
		const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
		const runtime = createRuntime({
			extensionPath: '.', log: quiet, startPresence: false,
			telemetrySettings: telemetrySettingsFromPackage(manifest), throttleSettings: throttleSettingsFromPackage(manifest),
			providers: [new MockTransportProvider(DEFAULT_MOCK_CONFIG)],
		});
		const api = createCockpitApi({
			bricks: runtime.bricks, aggregator: runtime.aggregator, connect: (id) => runtime.bricks.signIn(id),
			accessMode: () => 'safe', onAccessModeChange: () => disposable,
			telemetry: {
				rows: () => runtime.telemetry.rows(),
				claim: (brickKey, request, owner) => runtime.telemetry.claim(brickKey, request, owner),
				release: (handle) => runtime.telemetry.release(handle),
				onClaimsEnded: (listener) => runtime.telemetry.onClaimsEnded(listener),
				snapshot: (brickKey, rowIds) => runtime.telemetryView.snapshot(brickKey, rowIds),
				onChange: (listener) => runtime.telemetryView.onChange(listener),
			},
		});
		try {
			const marvin = brickIdOf(makeBrickKey(Transport.Mock, 'marvin'));
			await waitFor(() => runtime.aggregator.getBrick(marvin) !== undefined, 2000);
			await runtime.bricks.signIn(marvin);
			runtime.bricks.clearActiveBrick();   // a consumer's own loop, not the panel's

			const updates: TelemetryUpdate[] = [];
			const sub = api.registerConsumer('ev3-c').subscribeTelemetry(marvin, { rows: [TACHO], intervalMs: 100 }, (u) => updates.push(u));
			await waitFor(() => updates.some((u) => u.values.some((v) => v.rowId === TACHO)), 3000);

			assert.equal(updates[0].kind, 'snapshot');
			assert.equal(typeof updates.find((u) => u.values.length > 0)?.values[0].value, 'number');
			await runtime.bricks.signOut(marvin);
			await waitFor(() => updates.some((u) => u.kind === 'ended'), 2000);
			sub.dispose();
		} finally {
			api.dispose();
			runtime.dispose();
		}
	});
});
