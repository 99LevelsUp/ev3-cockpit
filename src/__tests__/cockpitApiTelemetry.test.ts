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
const settle = () => new Promise((resolve) => setImmediate(resolve));
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
				return { handle, grant: Object.fromEntries(request.rowIds.map((id) => [id, Math.max(request.intervalMs, 50)])) };
			},
			release: (handle) => { released.push(handle); },
			onClaimsEnded: (listener) => { endedListeners.push(listener as (typeof endedListeners)[number]); return disposable; },
			snapshot: (brickKey, rowIds) => (values.get(brickKey as BrickId) ?? []).filter((v) => !rowIds || rowIds.includes(v.rowId)),
			onChange: (listener) => { changeListeners.push(listener); return disposable; },
		},
	};
	const api = createCockpitApi(deps);
	return {
		api, claims, released, values,
		refuseWith(error: Error) { refuse = error; },
		/** As the read model does: the values move, then the listeners hear it. */
		change(change: ReadModelChange) {
			const brick = change.brickKey as BrickId;
			const kept = (values.get(brick) ?? []).filter((v) => !change.removed.includes(v.rowId)
				&& !change.rows.some((r) => r.rowId === v.rowId));
			values.set(brick, [...kept, ...change.rows]);
			for (const l of changeListeners) { l(change); }
		},
		end(brickKey: BrickId, handles: string[]) { for (const l of endedListeners) { l({ brickKey, handles }); } },
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
