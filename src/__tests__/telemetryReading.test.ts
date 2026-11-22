/**
 * Telemetry on demand for the `ev3` command and the MCP server: one reading ends as soon as every
 * row has a value, or at its deadline with the rest named missing; a watch hears changes until it
 * is stopped; both end their subscription, and with no rows named they ask for every row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ON_DEMAND_INTERVAL_MS, TelemetryClient, readTelemetryOnce, valueLine, watchTelemetry } from '../client/telemetryReading';
import type { TelemetryRequest, TelemetryUpdate, TelemetryValue } from '../contract/generated';

const value = (rowId: string, v: number | null, unit?: string): TelemetryValue => ({ rowId, value: v, sampledAt: 0, stale: false, ...(unit ? { unit } : {}) });

/** A client whose daemon answers a subscription with `snapshot`, then pushes what `push` sends. */
class FakeClient {
	readonly subscribed: TelemetryRequest[] = [];
	disposed = 0;
	private listener: ((u: TelemetryUpdate) => void) | undefined;
	constructor(private readonly snapshot: TelemetryValue[] = [], private readonly rows = ['system.battery.voltage', 'program.user.running']) {}
	request(method: string): Promise<unknown> {
		assert.equal(method, 'telemetry/rows');
		return Promise.resolve({ rows: this.rows.map((id) => ({ id, tier: 'live' })) });
	}
	subscribeTelemetry(_brick: string, request: TelemetryRequest, listener: (u: TelemetryUpdate) => void): Promise<{ grant: Record<string, number>; dispose(): void }> {
		this.subscribed.push(request);
		this.listener = listener;
		listener({ subscriptionId: 's1', brickId: 'b-ccc', kind: 'snapshot', values: this.snapshot, removed: [] });
		return Promise.resolve({ grant: {}, dispose: () => { this.disposed++; } });
	}
	push(kind: TelemetryUpdate['kind'], values: TelemetryValue[]): void {
		this.listener?.({ subscriptionId: 's1', brickId: 'b-ccc', kind, values, removed: [] });
	}
	get asClient(): TelemetryClient { return this as unknown as TelemetryClient; }
}

/** Waits until the code under test has subscribed. */
async function subscribed(fake: FakeClient): Promise<void> {
	while (fake.subscribed.length === 0) { await new Promise((resolve) => setImmediate(resolve)); }
}

describe('telemetry on demand', () => {
	it('ends a reading as soon as every row has a value, and ends its subscription', async () => {
		const fake = new FakeClient([value('system.battery.voltage', 7.9, 'V')]);
		const reading = readTelemetryOnce(fake.asClient, 'CCC', [], 60_000);
		await subscribed(fake);
		fake.push('change', [value('program.user.running', 0)]);
		const result = await reading;
		assert.deepEqual(fake.subscribed, [{ rows: ['system.battery.voltage', 'program.user.running'], intervalMs: ON_DEMAND_INTERVAL_MS }]);
		assert.deepEqual(result.values.map((v) => v.rowId), ['system.battery.voltage', 'program.user.running']);
		assert.deepEqual(result.missing, []);
		assert.equal(result.brickId, 'b-ccc');
		assert.equal(fake.disposed, 1);
	});

	it('names the rows that had no value by the deadline', async () => {
		const fake = new FakeClient();
		const result = await readTelemetryOnce(fake.asClient, 'CCC', ['system.battery.voltage'], 20);
		assert.deepEqual(result.values, []);
		assert.deepEqual(result.missing, ['system.battery.voltage']);
		assert.equal(fake.disposed, 1);
	});

	it('does not count a null as a value', async () => {
		const fake = new FakeClient([value('system.battery.voltage', null)]);
		const result = await readTelemetryOnce(fake.asClient, 'CCC', ['system.battery.voltage'], 20);
		assert.deepEqual(result.missing, ['system.battery.voltage']);
	});

	it('hears changes until stopped, then ends its subscription', async () => {
		const fake = new FakeClient();
		const stop = new AbortController();
		const seen: string[] = [];
		const watching = watchTelemetry(fake.asClient, 'CCC', ['system.battery.voltage'], stop.signal, (values) => { seen.push(...values.map(valueLine)); });
		await subscribed(fake);
		fake.push('change', [value('system.battery.voltage', 7.91234, 'V')]);
		fake.push('change', [value('system.battery.voltage', null)]);
		stop.abort();
		assert.equal(await watching, 1);
		assert.deepEqual(seen, ['system.battery.voltage = 7.912 V']);
		assert.equal(fake.disposed, 1);
	});

	it('ends a watch when the daemon ends the subscription', async () => {
		const fake = new FakeClient();
		const watching = watchTelemetry(fake.asClient, 'CCC', ['system.battery.voltage'], new AbortController().signal, () => undefined);
		await subscribed(fake);
		fake.push('ended', []);
		assert.equal(await watching, 0);
		assert.equal(fake.disposed, 1);
	});
});
