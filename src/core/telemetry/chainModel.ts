/**
 * The daisy chain below a brick, from what the telemetry read of it.
 *
 * Derived, never stored: the chain is whatever the brick's depth row last said, so it cannot
 * outlive the wiring it describes. Unknown (undefined) until the depth has been read, which is
 * not the same as a brick with nothing below it.
 */

import type { BrickChain } from '../contracts/models';
import { chainCapabilitiesOf } from './chainCapabilities';
import { CHAIN_DEPTH_ROW } from './ev3Rows';
import type { ReadValue } from './telemetryReadModel';

export function chainOf(values: readonly ReadValue[]): BrickChain | undefined {
	const depth = values.find((value) => value.rowId === CHAIN_DEPTH_ROW);
	if (typeof depth?.value !== 'number') { return undefined; }
	const members = [];
	for (let layer = 1; layer <= depth.value; layer += 1) {
		members.push({ layer, capabilities: chainCapabilitiesOf(layer) });
	}
	return { members, stale: depth.stale };
}
