import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { evaluateDynamic } from '../mock/dynamics';
import type { ValueDynamic } from '../mock/mockConfig';

describe('evaluateDynamic', () => {
	it('returns static value', () => {
		const d: ValueDynamic = { kind: 'static', value: 42 };
		assert.equal(evaluateDynamic(d, 0), 42);
		assert.equal(evaluateDynamic(d, 99999), 42);
	});

	it('returns static string value', () => {
		const d: ValueDynamic = { kind: 'static', value: 'red' };
		assert.equal(evaluateDynamic(d, 0), 'red');
	});

	it('sine oscillates between min and max', () => {
		const d: ValueDynamic = { kind: 'sine', min: 0, max: 100, periodMs: 4000 };

		// At t=0, sin(0) = 0 → normalized = 0.5 → value = 50
		const v0 = evaluateDynamic(d, 0) as number;
		assert.ok(Math.abs(v0 - 50) < 0.01, `Expected ~50, got ${v0}`);

		// At t=1000 (quarter period), sin(π/2) = 1 → normalized = 1 → value = 100
		const v1 = evaluateDynamic(d, 1000) as number;
		assert.ok(Math.abs(v1 - 100) < 0.01, `Expected ~100, got ${v1}`);

		// At t=3000 (3/4 period), sin(3π/2) = -1 → normalized = 0 → value = 0
		const v3 = evaluateDynamic(d, 3000) as number;
		assert.ok(Math.abs(v3 - 0) < 0.01, `Expected ~0, got ${v3}`);
	});

	it('triangle ramps linearly', () => {
		const d: ValueDynamic = { kind: 'triangle', min: 0, max: 100, periodMs: 4000 };

		// At t=0 → 0
		assert.equal(evaluateDynamic(d, 0), 0);

		// At t=1000 (quarter) → 50
		const v1 = evaluateDynamic(d, 1000) as number;
		assert.ok(Math.abs(v1 - 50) < 0.01);

		// At t=2000 (half) → 100
		const v2 = evaluateDynamic(d, 2000) as number;
		assert.ok(Math.abs(v2 - 100) < 0.01);

		// At t=3000 (3/4) → 50
		const v3 = evaluateDynamic(d, 3000) as number;
		assert.ok(Math.abs(v3 - 50) < 0.01);
	});

	it('square switches between low and high', () => {
		const d: ValueDynamic = { kind: 'square', low: 0, high: 100, periodMs: 2000 };

		assert.equal(evaluateDynamic(d, 0), 0);
		assert.equal(evaluateDynamic(d, 500), 0);
		assert.equal(evaluateDynamic(d, 1000), 100);
		assert.equal(evaluateDynamic(d, 1500), 100);
	});
});
