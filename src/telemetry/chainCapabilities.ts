/**
 * What a brick below another in a USB daisy chain can do: the one place that decides it.
 *
 * Today nothing here is asked of the brick, because the stock firmware offers nothing to ask: no
 * host operation that reads a name, files or programs takes a layer (`bytecodes.c`; `opCOM_GET`
 * and the system commands have none), and a member's motor position does not cross the chain
 * (IMPLEMENTATION_PLAN 3.1.4f). So each answer is fixed from what was measured. A firmware that
 * answers one of these for a member gets its probe added here, and the answer is then read from
 * the brick; the shape consumers see stays (`ChainMemberCapabilities`).
 */

import type { ChainMemberCapabilities } from '../contracts/models';

/**
 * Layers on which a motor's type read right in every one of three rewirings, with motors of
 * different types (17.11.2026, firmware 1.10E). Layer 3 was out of reach of three bricks, and
 * an August reading once got a layer-2 motor wrong, so no other layer is vouched for.
 */
const MOTOR_TYPES_MEASURED: ReadonlySet<number> = new Set([1, 2]);

export function chainCapabilitiesOf(layer: number): ChainMemberCapabilities {
	return {
		sensors: true,
		motorTypes: MOTOR_TYPES_MEASURED.has(layer),
		motorReadout: false,
		files: false,
		programs: false,
		name: false,
	};
}
