/**
 * What a port is doing, from the type code its occupancy row reports (step-6 plan U4, KTD7;
 * IMPLEMENTATION_PLAN 3.1.11; DESIGN §9.1c). Codes from `bytecodes.h` of firmware 1.09d.
 *
 * The value of a port is read only when it is `known`. Not because reading otherwise blocks —
 * `opINPUT_READSI`, which the value rows use, never changes the dispatch status (`c_input.c`
 * `cInputReadSi`) and answers NaN for a port that is empty, faulty or still busy — but because
 * there is nothing to learn from the read, and the bytes it takes are scarce on the HID fallback.
 * The 1.2-second re-execution DESIGN §9.1c once ascribed to it belongs to `opINPUT_DEVICE`'s
 * `READY_*` subcodes and `opINPUT_READY`; U10 measures it on a brick.
 */

export type PortState =
	/** No occupancy row has reported on the port yet. Read as if known: a cold start does not wait. */
	| 'unreported'
	/** `TYPE_NONE` 126: nothing attached. */
	| 'empty'
	/** `TYPE_UNKNOWN` 125: attached, being identified — a second or two after every plug-in. */
	| 'identifying'
	/** A device type: the value is read. */
	| 'known'
	/** `TYPE_ERROR` 127: attached, type invalid. */
	| 'error'
	/** `TYPE_TERMINAL` 124: a console, not a peripheral. */
	| 'terminal'
	/** Any other code at or above 124: shown as such, never guessed at. */
	| 'not-readable';

const TYPE_TERMINAL = 124;
const TYPE_UNKNOWN = 125;
const TYPE_NONE = 126;
const TYPE_ERROR = 127;

export function portStateOf(code: number | undefined): PortState {
	if (code === undefined) { return 'unreported'; }
	if (code < TYPE_TERMINAL) { return 'known'; }
	switch (code) {
	case TYPE_TERMINAL: return 'terminal';
	case TYPE_UNKNOWN: return 'identifying';
	case TYPE_NONE: return 'empty';
	case TYPE_ERROR: return 'error';
	default: return 'not-readable';
	}
}
