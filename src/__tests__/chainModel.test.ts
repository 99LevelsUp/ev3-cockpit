/**
 * The daisy chain below a brick, from what the telemetry read of it (step-8 plan, U4).
 *
 * The chain is derived from the read values, never stored: the depth row says how many bricks
 * hang below, and each member carries what it can do. Today the brick answers only which members
 * exist and what is on their ports; every other ability is fixed from what was measured.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chainOf } from '../core/telemetry/chainModel';
import type { ReadValue } from '../core/telemetry/telemetryReadModel';

const depth = (value: number, stale = false): ReadValue => ({ rowId: 'chain.depth', value, sampledAt: 1, stale });

describe('Daisy chain model (step-8 U4)', () => {
	it('knows nothing of a chain whose depth has not been read: unknown, not empty', () => {
		assert.equal(chainOf([{ rowId: 'ports.sensor.1.value', value: 3, sampledAt: 1, stale: false }]), undefined);
	});

	it('knows a brick with nothing below it', () => {
		assert.deepEqual(chainOf([depth(0)]), { members: [], stale: false });
	});

	it('lists one member per layer down to the depth, each with what it can do', () => {
		const chain = chainOf([depth(2)]);

		assert.deepEqual(chain?.members.map((member) => member.layer), [1, 2]);
		for (const member of chain?.members ?? []) {
			assert.equal(member.capabilities.sensors, true, 'sensor types and values cross the chain');
			assert.equal(member.capabilities.motorReadout, false, 'a motor position never crosses the chain');
			assert.equal(member.capabilities.files, false);
			assert.equal(member.capabilities.programs, false);
			assert.equal(member.capabilities.name, false);
		}
	});

	it('vouches for motor types only on the layers measured, not on layer 3', () => {
		const chain = chainOf([depth(3)]);

		assert.deepEqual(chain?.members.map((member) => member.capabilities.motorTypes), [true, true, false]);
	});

	it('says when the depth it was built from is stale', () => {
		assert.equal(chainOf([depth(1, true)])?.stale, true);
	});
});
