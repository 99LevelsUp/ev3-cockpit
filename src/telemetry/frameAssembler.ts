/**
 * Builds one direct command from the rows that come up on a tick, and says where each
 * result landed.
 *
 * Two jobs that have to be done together. Offsets are assigned here because they are a
 * property of the whole frame, not of any row (§9.1b), and the layout is returned rather
 * than recomputed by the parser, because a parser inferring offsets is the bug class that
 * plan 3.1.4a already caught once: it read four bytes from a slot the firmware had filled
 * one byte of.
 *
 * Three limits, and the reply is the one that gets forgotten:
 *
 *  - bytecode ≤ packet − 7, the direct-command header;
 *  - declared globals ≤ packet − 5, because the reply on the wire is always *declared*
 *    globals plus five bytes however few the program wrote, and `c_com.c` never checks it
 *    against `MAX_MSG_SIZE`;
 *  - declared globals ≤ 1019 regardless, for the same reason — `MAX_COMMAND_GLOBALS` is
 *    1021, but 1021 + 5 overruns the 1024-byte message.
 *
 * Alignment padding inflates the declaration faster than the bytecode, so the second limit
 * can bind before the first.
 */

import { gv0, gv1, concatBytes, uint16le } from '../protocol/ev3Bytecode';
import { RowSlot, TelemetryRow } from './telemetryRow';

/** Bytes the direct-command header costs on the request: length, counter, type, globals. */
export const DIRECT_COMMAND_HEADER_BYTES = 7;

/** Bytes the reply header costs: length, counter, type. */
export const DIRECT_REPLY_HEADER_BYTES = 5;

/**
 * Largest global allocation that can come back inside `MAX_MSG_SIZE`.
 *
 * `MAX_COMMAND_GLOBALS` is 1021 and the firmware validates against it on the way in, but
 * the reply is globals + 5 and nothing re-checks that. So the usable ceiling is lower than
 * the constant the firmware advertises.
 */
export const MAX_USABLE_GLOBAL_BYTES = 1019;

export interface FrameLimits {
	/** Largest packet this link carries. 64 on the HID fallback, 1024 over libusb. */
	readonly maxPacketBytes: number;
}

/** One row and the offset its result was given. */
export interface PlacedRow {
	readonly row: TelemetryRow;
	readonly slot: RowSlot;
}

export interface AssembledFrame {
	/** Bytecode body, without the globals word — `buildTelemetryFrame` prepends that. */
	readonly bytecode: Uint8Array;
	/** Global bytes to declare, which is also what the reply will carry. */
	readonly globalBytes: number;
	/** Where each included row's result landed. The parser reads this, never infers it. */
	readonly placed: readonly PlacedRow[];
	/**
	 * Rows that did not fit this tick, in the order they should be tried next.
	 *
	 * Never dropped silently: the scheduler puts these at the front of the next tick, which
	 * is what makes truncation rotating rather than a permanent loss (§9.1b).
	 */
	readonly deferred: readonly TelemetryRow[];
}

export class FrameAssemblyError extends Error {}

/**
 * Rounds `offset` up to the next multiple of `alignment`.
 *
 * A guard rather than the mechanism. For well-formed rows — and `validateRow` enforces that
 * a row's byte count tiles its own alignment — laying wide results out first means the cursor
 * is always already aligned for whatever comes next, so this never actually pads. It stays
 * because the two protections are independent: remove the ordering and this keeps the frame
 * correct at the cost of padding, and the tests pin both separately.
 */
function alignUp(offset: number, alignment: number): number {
	const remainder = offset % alignment;
	return remainder === 0 ? offset : offset + (alignment - remainder);
}

/**
 * Bytes a global reference costs at this offset.
 *
 * GV0 encodes offsets 0-31 in one byte; past that it takes GV1's two. Worth knowing here
 * because it means a row's bytecode is not a fixed size — the same row costs more when it
 * lands late in a wide frame.
 */
export function globalRefBytes(slot: number): number {
	return slot <= 31 ? 1 : 2;
}

/** Encodes a global reference, picking the shortest form that reaches `slot`. */
export function globalRef(slot: number): Uint8Array {
	return slot <= 31 ? gv0(slot) : gv1(slot);
}

/**
 * Rejects a row whose result can never be placed.
 *
 * Called at registration time (3.1.6) as well as here, so a third party adding a row learns
 * about it from the registration call rather than from a corrupt frame at runtime.
 */
export function validateRow(row: TelemetryRow, limits: FrameLimits): void {
	const { bytes, alignment } = row.result;
	if (!Number.isInteger(bytes) || bytes <= 0) {
		throw new FrameAssemblyError(`Row '${row.id}' declares ${bytes} result bytes.`);
	}
	// The type says 1 | 2 | 4, but a row can arrive from a third-party extension across an
	// API boundary the compiler does not police, so this is a runtime check on purpose.
	if (alignment !== 1 && alignment !== 2 && alignment !== 4) {
		throw new FrameAssemblyError(
			`Row '${row.id}' declares alignment ${String(alignment)}; 1, 2 or 4 are the options.`
		);
	}
	if (bytes % alignment !== 0) {
		throw new FrameAssemblyError(
			`Row '${row.id}' declares ${bytes} bytes at alignment ${alignment}, which cannot tile.`
		);
	}
	const globalBudget = globalBudgetFor(limits);
	if (bytes > globalBudget) {
		throw new FrameAssemblyError(
			`Row '${row.id}' needs ${bytes} result bytes but only ${globalBudget} can come back `
			+ `on a ${limits.maxPacketBytes}-byte packet.`
		);
	}
}

/** Global bytes that fit in a reply on this link, and inside `MAX_MSG_SIZE`. */
export function globalBudgetFor(limits: FrameLimits): number {
	return Math.min(
		limits.maxPacketBytes - DIRECT_REPLY_HEADER_BYTES,
		MAX_USABLE_GLOBAL_BYTES,
	);
}

/** Bytecode bytes that fit in a request on this link. */
export function bytecodeBudgetFor(limits: FrameLimits): number {
	return limits.maxPacketBytes - DIRECT_COMMAND_HEADER_BYTES;
}

/**
 * Lays out a candidate set and reports what it costs, or `undefined` if it does not fit.
 *
 * 32-bit results go first, which is the Communication Developer Kit's "float/32bits first
 * and 8 bits last" — it makes the alignment requirement free instead of paid for in padding.
 * The caller's order is preserved *within* an alignment class, so truncation priority
 * survives the reordering.
 */
function layOut(
	candidates: readonly TelemetryRow[],
	limits: FrameLimits,
): { placed: PlacedRow[]; bytecode: Uint8Array; globalBytes: number } | undefined {
	const byAlignmentDescending = [...candidates]
		.map((row, index) => ({ row, index }))
		.sort((a, b) =>
			b.row.result.alignment - a.row.result.alignment || a.index - b.index)
		.map((entry) => entry.row);

	const placed: PlacedRow[] = [];
	const fragments: Uint8Array[] = [];
	let cursor = 0;

	for (const row of byAlignmentDescending) {
		const slot = alignUp(cursor, row.result.alignment);
		placed.push({ row, slot });
		fragments.push(row.emit(slot));
		cursor = slot + row.result.bytes;
	}

	const bytecode = concatBytes(...fragments);
	if (cursor > globalBudgetFor(limits)) { return undefined; }
	if (bytecode.length > bytecodeBudgetFor(limits)) { return undefined; }
	return { placed, bytecode, globalBytes: cursor };
}

/**
 * Composes as many of `rows` as fit, in the order given, and defers the rest.
 *
 * The order is the truncation priority: earlier rows win a tight tick. Growing a prefix and
 * re-laying it out each time is O(n²) in the number of rows, which is nothing at the couple
 * of dozen a brick has — and it is the only way to be exact, since padding means a row's
 * cost depends on what precedes it.
 */
export function assembleFrame(
	rows: readonly TelemetryRow[],
	limits: FrameLimits,
): AssembledFrame {
	assertNoModeConflict(rows);

	let best: { placed: PlacedRow[]; bytecode: Uint8Array; globalBytes: number } | undefined;
	let taken = 0;

	for (let count = 1; count <= rows.length; count += 1) {
		const attempt = layOut(rows.slice(0, count), limits);
		if (!attempt) { break; }
		best = attempt;
		taken = count;
	}

	if (!best) {
		// Not even the first row fits. Refusing beats emitting a frame that cannot carry
		// anything, and validateRow should have caught it at registration.
		throw new FrameAssemblyError(
			`No row fits a ${limits.maxPacketBytes}-byte packet`
			+ (rows.length ? `; '${rows[0].id}' was first.` : ' (no rows given).')
		);
	}

	return {
		bytecode: best.bytecode,
		globalBytes: best.globalBytes,
		placed: best.placed,
		deferred: rows.slice(taken),
	};
}

/**
 * Refuses two modes of one port in one frame.
 *
 * A safety net rather than the mechanism: mode ownership is per device *across* ticks
 * (§9.1c), because refusing only within a frame relocates the conflict into alternating
 * frames, where every frame forces a mode change, `cInputSetDeviceType` sets Busy, and both
 * rows read NAN indefinitely. Two reads of the *same* mode are fine — LEGOev3 takes SI, RAW
 * and PCT off one port in one frame, and we reproduced it.
 */
export function assertNoModeConflict(rows: readonly TelemetryRow[]): void {
	const modeByPort = new Map<string, { mode: number; rowId: string }>();
	for (const row of rows) {
		if (row.port === undefined || row.mode === undefined) { continue; }
		const seen = modeByPort.get(row.port);
		if (seen && seen.mode !== row.mode) {
			throw new FrameAssemblyError(
				`Rows '${seen.rowId}' (mode ${seen.mode}) and '${row.id}' (mode ${row.mode}) both `
				+ `claim port ${row.port}. One active mode row per port.`
			);
		}
		if (!seen) { modeByPort.set(row.port, { mode: row.mode, rowId: row.id }); }
	}
}

/** Prepends the declared-globals word, producing a direct-command payload. */
export function buildTelemetryFrame(frame: AssembledFrame): Uint8Array {
	if (frame.globalBytes > MAX_USABLE_GLOBAL_BYTES) {
		throw new FrameAssemblyError(
			`Frame declares ${frame.globalBytes} global bytes; ${MAX_USABLE_GLOBAL_BYTES} is the `
			+ 'most that can come back inside MAX_MSG_SIZE.'
		);
	}
	// Locals are zero: a telemetry frame reads into globals and computes nothing.
	return concatBytes(uint16le(frame.globalBytes), frame.bytecode);
}

/** Reads every placed row out of a reply payload. */
export function parseFrame(
	frame: AssembledFrame,
	payload: Uint8Array,
	sampledAt: number,
): RowValueList {
	return frame.placed.map(({ row, slot }) => row.parse(payload, slot, sampledAt));
}

type RowValueList = ReturnType<TelemetryRow['parse']>[];
