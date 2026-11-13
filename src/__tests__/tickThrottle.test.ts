/**
 * The per-brick tick throttle (step-6 plan U7; IMPLEMENTATION_PLAN 3.4.1, 3.4.3, 3.4.5, 3.7.2;
 * DESIGN §4.5, §9.5).
 *
 * It watches each telemetry frame's round trip and, at the end of each window, sets the window's
 * p95 against `tailFactor` × the link's measured round trip: over it, the tick slows a step; within
 * it for `calmWindows` windows in a row, a step back. The median does not decide — a brick with its
 * port screen open keeps a 6 ms median and a 37 ms p95 (DESIGN §4.5).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Transport } from '../contracts/enums';
import { TickThrottle, typicalRoundTripMs } from '../telemetry/tickThrottle';
import type { ThrottleSettings } from '../telemetry/telemetrySettings';

const SETTINGS: ThrottleSettings = { enabled: true, windowSize: 5, tailFactor: 3, step: 1.5, maxSlowdown: 4, calmWindows: 2 };
/** A link whose usual round trip is 10 ms: the limit is 30 ms. */
const throttle = (settings: Partial<ThrottleSettings> = {}) => new TickThrottle({ ...SETTINGS, ...settings }, 10);
/** Feeds round trips; returns the factor after each one that changed it. */
const feed = (t: TickThrottle, ...trips: number[]) => trips.flatMap((ms) => (t.observe(ms) ? [t.factor] : []));
const window = (ms: number, n = SETTINGS.windowSize) => Array.from({ length: n }, () => ms);

describe('Tick throttle (step-6 U7)', () => {
	it('leaves a quiet brick alone', () => {
		const t = throttle();
		assert.deepEqual(feed(t, ...window(8), ...window(12), ...window(29)), []);
		assert.equal(t.factor, 1);
	});

	it('slows a step at the end of a window whose p95 is over the limit, not before', () => {
		const t = throttle();
		assert.deepEqual(feed(t, 8, 8, 8, 40), [], 'mid-window: nothing decided');
		assert.deepEqual(feed(t, 40), [1.5]);
	});

	it('does not slow for one spike in a window, only for a tail', () => {
		const t = throttle({ windowSize: 20 });
		assert.deepEqual(feed(t, ...window(6, 19), 200), [], 'one stall in twenty is not the p95');
		assert.deepEqual(feed(t, ...window(6, 18), 37, 37), [1.5], 'two are: Port View');
	});

	it('keeps slowing a step a window up to maxSlowdown, and no further', () => {
		const t = throttle();
		assert.deepEqual(feed(t, ...window(50), ...window(50), ...window(50), ...window(50), ...window(50)),
			[1.5, 2.25, 3.375, 4]);
		assert.equal(t.factor, 4);
	});

	it('speeds back a step after calmWindows calm windows in a row, never past the plan', () => {
		const t = throttle();
		feed(t, ...window(50), ...window(50));
		assert.equal(t.factor, 2.25);

		assert.deepEqual(feed(t, ...window(8)), [], 'one calm window is not enough');
		assert.deepEqual(feed(t, ...window(8)), [1.5]);
		assert.deepEqual(feed(t, ...window(8), ...window(8)), [1]);
		assert.deepEqual(feed(t, ...window(8), ...window(8)), [], 'not faster than the plan');
	});

	it('comes back down from the ceiling to exactly the plan, even when the steps do not divide it', () => {
		const t = throttle();
		feed(t, ...Array.from({ length: 5 }, () => window(50)).flat());
		assert.equal(t.factor, 4);

		const steps = feed(t, ...Array.from({ length: 8 }, () => window(8)).flat());
		assert.equal(steps[steps.length - 1], 1, `came down as ${JSON.stringify(steps)}`);
	});

	it('starts counting calm windows afresh after a slow one', () => {
		const t = throttle();
		feed(t, ...window(50));
		assert.deepEqual(feed(t, ...window(8), ...window(50), ...window(8)), [2.25]);
		assert.equal(t.factor, 2.25, 'the calm window before the slow one does not count');
	});

	it('when disabled, never moves the tick but still reports the numbers', () => {
		const t = throttle({ enabled: false });
		assert.deepEqual(feed(t, ...window(50), ...window(50)), []);
		assert.deepEqual(t.state(), { factor: 1, limitMs: 30, p95Ms: 50, stalls: 5, windowSamples: 0 });
	});

	it('reports the last window\'s p95, its stalls over the limit, and how full the next is', () => {
		const t = throttle();
		feed(t, 8, 30, 31, 40, 10, 12, 13);   // 30 is at the limit, not over it

		assert.deepEqual(t.state(), { factor: 1.5, limitMs: 30, p95Ms: 40, stalls: 2, windowSamples: 2 });
	});

	it('takes new settings at once: a lower ceiling pulls the tick down to it', () => {
		const t = throttle();
		feed(t, ...window(50), ...window(50), ...window(50));
		assert.equal(t.factor, 3.375);

		assert.equal(t.configure({ ...SETTINGS, maxSlowdown: 2 }), true);
		assert.equal(t.factor, 2);
		assert.equal(t.configure({ ...SETTINGS, enabled: false }), true);
		assert.equal(t.factor, 1, 'switched off: the plan\'s tick');
		assert.throws(() => t.configure({ ...SETTINGS, step: 1 }), /step/);
	});

	it('starts afresh under new settings: no window, calm count or numbers gathered under the old ones (review 1)', () => {
		const t = throttle({ windowSize: 20 });
		feed(t, ...window(8, 20));                              // a calm window: p95 8 against 30
		feed(t, ...window(8, 18), 40);                          // part of the next, a stall in it

		t.configure({ ...SETTINGS, windowSize: 5, tailFactor: 6 });

		assert.deepEqual(t.state(), { factor: 1, limitMs: 60, stalls: 0, windowSamples: 0 },
			'no p95 or stalls measured against the old limit');
		assert.deepEqual(feed(t, 40, 40, 40, 40, 40), [], 'five frames under the new rules decide, within 60 ms');
	});

	it('knows each link\'s usual round trip, and assumes the slowest for one it does not know', () => {
		assert.equal(typicalRoundTripMs(Transport.USB), 10);
		assert.equal(typicalRoundTripMs(Transport.TCP), 60);
		assert.equal(typicalRoundTripMs(Transport.BT), 130);
		assert.equal(typicalRoundTripMs(Transport.Mock), 10);
		assert.equal(typicalRoundTripMs(undefined), 130);
	});
});
