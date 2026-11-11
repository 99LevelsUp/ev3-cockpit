/**
 * Claims on a brick's telemetry rows (step-6 plan U5; IMPLEMENTATION_PLAN 3.3.5, 3.1.10;
 * DESIGN §9.3; owner decisions D2, D6, D7).
 *
 * A claim names rows and the interval it wants them at. The fastest claim on a row wins, clamped
 * to the transport's floor; a request is not a guarantee, so the claim gets back the interval
 * each row was granted. The cockpit's own foreground is a claim too, and holds no sensor mode. A
 * mode is a parameter of the claim, and the first claim on a port holds it.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { createEv3RowRegistry } from '../telemetry/rowRegistry';
import { TelemetryClaims } from '../telemetry/telemetryClaims';
import { ErrorCode } from '../errors/CockpitError';
import type { TelemetryRow } from '../telemetry/telemetryRow';

const USB = { floorMs: 50, foregroundMs: 100 };

const claims = (active = false) => {
	const c = new TelemetryClaims(createEv3RowRegistry(), USB);
	c.setForeground(active);
	return c;
};
const rowOf = (rows: readonly TelemetryRow[], id: string) => rows.find((r) => r.id === id);
const dividerOf = (rows: readonly TelemetryRow[], id: string) => {
	const lifetime = rowOf(rows, id)?.lifetime;
	return lifetime?.kind === 'repeating' ? lifetime.divider : lifetime?.kind;
};
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('Telemetry claims (step-6 U5)', () => {
	it('reads every row for the foreground: sampled at its cadence, event rows every fifth tick, static once', () => {
		const plan = claims(true).plan();

		assert.equal(plan.periodMs, 100);
		assert.equal(plan.rows.length, createEv3RowRegistry().all().length);
		assert.equal(dividerOf(plan.rows, 'ports.sensor.1.value'), 1);
		assert.equal(dividerOf(plan.rows, 'system.battery.level'), 5);
		assert.equal(dividerOf(plan.rows, 'system.firmwareVersion'), 'oneShot');
	});

	it('reads nothing for a brick nobody claims and that is not in the foreground', () => {
		const plan = claims(false).plan();

		assert.deepEqual(plan.rows, []);
	});

	it('reads only the claimed rows of a brick in the background, at the interval asked', () => {
		const c = claims(false);

		const grant = c.claim({ rowIds: ['ports.sensor.1.value', 'system.battery.level'], intervalMs: 400 }, 'ev3-explorer');
		const plan = c.plan();

		assert.equal(plan.periodMs, 400);
		assert.deepEqual(plan.rows.map((r) => r.id).sort(), ['ports.sensor.1.value', 'system.battery.level']);
		assert.deepEqual(c.grantOf(grant.handle), { 'ports.sensor.1.value': 400, 'system.battery.level': 400 });
	});

	it('speeds the tick for a claim faster than the foreground, and never reads a row slower than asked', () => {
		const c = claims(true);

		const grant = c.claim({ rowIds: ['ports.sensor.2.value'], intervalMs: 60 }, 'fast');
		const plan = c.plan();

		assert.equal(plan.periodMs, 60);
		assert.equal(c.grantOf(grant.handle)?.['ports.sensor.2.value'], 60);
		assert.equal(dividerOf(plan.rows, 'ports.sensor.1.value'), 1, 'the foreground asked 100 ms: 60 is not slower');
		assert.equal(dividerOf(plan.rows, 'system.battery.level'), 8, 'event rows at 500 ms: 8 ticks of 60 ms');
	});

	it('clamps a claim faster than the transport allows to its floor, and says so in the grant', () => {
		const c = claims(false);

		const grant = c.claim({ rowIds: ['ports.motor.A.tacho'], intervalMs: 10 }, 'greedy');

		assert.equal(c.plan().periodMs, 50);
		assert.equal(c.grantOf(grant.handle)?.['ports.motor.A.tacho'], 50);
	});

	it('reads an interval between ticks on the faster one, and grants what was asked: 150 ms on a 100 ms tick', () => {
		const c = claims(true);

		const grant = c.claim({ rowIds: ['system.battery.level'], intervalMs: 150 }, 'battery-watch');

		assert.equal(dividerOf(c.plan().rows, 'system.battery.level'), 1, 'read every 100 ms tick');
		assert.equal(c.grantOf(grant.handle)?.['system.battery.level'], 150,
			'the grant is a promise of at least this often; what the row runs at travels in the data (D2)');
	});

	it('keeps a grant as negotiated when the foreground leaves or the transport changes (D2)', () => {
		const c = claims(true);
		const grant = c.claim({ rowIds: ['ports.motor.A.tacho'], intervalMs: 100 }, 'tacho-watch');

		c.setForeground(false);
		assert.deepEqual(c.grantOf(grant.handle), { 'ports.motor.A.tacho': 100 });

		c.setCadence({ floorMs: 250, foregroundMs: 500 });
		assert.equal(c.plan().periodMs, 250, 'the tick follows the new floor');
		assert.deepEqual(c.grantOf(grant.handle), { 'ports.motor.A.tacho': 100 },
			'the grant does not move; effectiveIntervalMs says the row now runs at 250 ms');
	});

	it('says a static row is read once', () => {
		const c = claims(false);

		const grant = c.claim({ rowIds: ['system.firmwareVersion'], intervalMs: 1000 }, 'info');

		assert.equal(c.grantOf(grant.handle)?.['system.firmwareVersion'], 'once');
	});

	it('recomputes from the claims that remain when one is released, and a second release does nothing', () => {
		const c = claims(true);
		const grant = c.claim({ rowIds: ['ports.sensor.2.value'], intervalMs: 60 }, 'fast');

		c.release(grant.handle);
		c.release(grant.handle);

		assert.equal(c.plan().periodMs, 100);
	});

	it('refuses an unknown row and a nonsense interval, and adds nothing', () => {
		const c = claims(false);

		assert.throws(() => c.claim({ rowIds: ['ports.sensor.9.value'], intervalMs: 100 }, 'x'), /ports\.sensor\.9\.value/);
		for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs }, 'x'), /interval/, `accepted ${intervalMs}`);
		}
		assert.deepEqual(c.plan().rows, []);
	});

	it('reads a port in the mode its claim asks for (D6)', () => {
		const c = claims(false);

		c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 2 } }, 'ev3-c');

		assert.equal(rowOf(c.plan().rows, 'ports.sensor.1.value')?.mode, 2);
	});

	it('lets the first claim hold a port\'s mode and refuses another mode, naming the holder (D7)', () => {
		const c = claims(false);
		const first = c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 2 } }, 'ev3-c');

		assert.doesNotThrow(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 2 } }, 'ev3-explorer'), 'the same mode is shared');
		assert.throws(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 0 } }, 'blockly'),
			(e) => codeOf(e) === ErrorCode.ModeConflict && /ev3-c/.test((e as Error).message));

		c.release(first.handle);
		assert.throws(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 0 } }, 'blockly'),
			(e) => codeOf(e) === ErrorCode.ModeConflict, 'released while another claim still holds the mode');
	});

	it('frees a port\'s mode when the last claim holding it is released', () => {
		const c = claims(false);
		const a = c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 2 } }, 'a');
		const b = c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 2 } }, 'b');

		c.release(a.handle);
		c.release(b.handle);

		assert.doesNotThrow(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 0 } }, 'c'));
	});

	it('does not let the foreground hold a mode: a consumer can ask another mode of the active brick', () => {
		const c = claims(true);

		c.claim({ rowIds: ['ports.sensor.3.value'], intervalMs: 100, modes: { '3': 1 } }, 'ev3-c');

		assert.equal(rowOf(c.plan().rows, 'ports.sensor.3.value')?.mode, 1);
	});

	it('refuses a mode for a port without one, or outside the firmware\'s 0-7', () => {
		const c = claims(false);

		assert.throws(() => c.claim({ rowIds: ['ports.motor.A.tacho'], intervalMs: 100, modes: { A: 1 } }, 'x'), /mode/);
		for (const mode of [-1, 8, 1.5]) {
			assert.throws(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 100, modes: { '1': mode } }, 'x'), /mode/, `accepted ${mode}`);
		}
	});

	it('ends every claim at once when the brick goes, and says which', () => {
		const c = claims(false);
		const a = c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 2 } }, 'a');
		const b = c.claim({ rowIds: ['system.battery.level'], intervalMs: 1000 }, 'b');

		const ended = c.endAll();

		assert.deepEqual([...ended].sort(), [a.handle, b.handle].sort());
		assert.deepEqual(c.plan().rows, []);
		assert.doesNotThrow(() => c.claim({ rowIds: ['ports.sensor.1.value'], intervalMs: 200, modes: { '1': 0 } }, 'c'), 'the mode outlived its claims');
	});
});
