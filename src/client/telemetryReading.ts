/**
 * Telemetry on demand, for clients without a panel (the `ev3` command, the MCP server): one
 * reading, or changes until the caller stops. Each runs on a subscription of its own that ends with
 * it, so a brick is read only while someone asks; connecting a brick never starts telemetry.
 */

import type { TelemetryValue } from '../contract/generated';
import type { CockpitClient } from './nativeClient';

/** What a reading needs of the client library. */
export type TelemetryClient = Pick<CockpitClient, 'request' | 'subscribeTelemetry'>;

/** How often rows are read while a reading or a watch runs. */
export const ON_DEMAND_INTERVAL_MS = 1000;

/** One reading: the latest value of every row asked for, and the rows that had none in time. */
export interface TelemetryReading {
	readonly brickId: string;
	readonly values: readonly TelemetryValue[];
	readonly missing: readonly string[];
}

/** The rows asked for, or every row the daemon offers when none are named. */
async function rowsOf(client: TelemetryClient, rows: readonly string[]): Promise<string[]> {
	if (rows.length > 0) { return [...rows]; }
	const { rows: all } = await client.request('telemetry/rows', {});
	return all.map((row) => row.id);
}

/**
 * Reads `rows` (every row when empty) of a connected brick once: subscribes, keeps the latest value
 * of each row, and ends as soon as every row has one, after `waitMs`, or when `signal` aborts,
 * whichever comes first. The subscription ends with it.
 */
export async function readTelemetryOnce(client: TelemetryClient, brick: string, rows: readonly string[], waitMs: number, signal?: AbortSignal): Promise<TelemetryReading> {
	const wanted = await rowsOf(client, rows);
	const latest = new Map<string, TelemetryValue>();
	let brickId = brick;
	let finish: () => void = () => undefined;
	const done = new Promise<void>((resolve) => { finish = resolve; });
	const subscription = await client.subscribeTelemetry(brick, { rows: wanted, intervalMs: ON_DEMAND_INTERVAL_MS }, (update) => {
		brickId = update.brickId;
		for (const value of update.values) { if (value.value !== null) { latest.set(value.rowId, value); } }
		if (update.kind === 'ended' || wanted.every((row) => latest.has(row))) { finish(); }
	});
	const timer = setTimeout(finish, waitMs);
	const onAbort = (): void => finish();
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		if (!signal?.aborted && !wanted.every((row) => latest.has(row))) { await done; }
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
		subscription.dispose();
	}
	return {
		brickId,
		values: wanted.flatMap((row) => latest.get(row) ?? []),
		missing: wanted.filter((row) => !latest.has(row)),
	};
}

/**
 * Hears `rows` (every row when empty) of a connected brick until `signal` aborts or the daemon ends
 * the subscription (the brick was signed out), handing each change to `onValues`. Resolves with how
 * many updates came.
 */
export async function watchTelemetry(client: TelemetryClient, brick: string, rows: readonly string[], signal: AbortSignal, onValues: (values: readonly TelemetryValue[]) => void): Promise<number> {
	const wanted = await rowsOf(client, rows);
	let updates = 0;
	let finish: () => void = () => undefined;
	const done = new Promise<void>((resolve) => { finish = resolve; });
	const subscription = await client.subscribeTelemetry(brick, { rows: wanted, intervalMs: ON_DEMAND_INTERVAL_MS }, (update) => {
		if (update.kind === 'ended') { finish(); return; }
		const values = update.values.filter((value) => value.value !== null);
		if (values.length === 0) { return; }
		updates++;
		onValues(values);
	});
	const onAbort = (): void => finish();
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		if (!signal.aborted) { await done; }
	} finally {
		signal.removeEventListener('abort', onAbort);
		subscription.dispose();
	}
	return updates;
}

/** A value as a person reads it: `system.battery.voltage = 7.9 V`. */
export function valueLine(value: TelemetryValue): string {
	const shown = typeof value.value === 'number' ? String(Math.round(value.value * 1000) / 1000) : String(value.value);
	return `${value.rowId} = ${shown}${value.unit ? ` ${value.unit}` : ''}${value.stale ? ' (stale)' : ''}`;
}
