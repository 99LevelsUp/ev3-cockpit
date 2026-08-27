/**
 * A telemetry row: one value the cockpit can read, with its own cadence and its own switch.
 *
 * Rows exist because cadence cuts across commands. `info` alone returns a firmware version
 * that cannot change while the session is open and a brick name that can, so neither the
 * command nor the category is a unit anyone can attach a rate to. DESIGN §9.1a has the
 * argument; this file is the type it produces.
 *
 * A row owns the bytecode that reads it and the parse of its own result, but **not** where
 * that result lands. Offsets belong to the assembler (§9.1b), because they are a property of
 * the whole frame: `opINPUT_READSI` rejects a 32-bit result on an unaligned offset, and a row
 * cannot know what came before it.
 */

/** Where a row's value goes in the reply buffer, once the assembler has decided. */
export type RowSlot = number;

/**
 * How often a row is read.
 *
 * Three lifetimes, not one interval. The static tier needs *once*, which no divider can
 * express: divider 0 means never, and every other divider means forever.
 */
export type RowLifetime =
	/** Registered but not wanted. Nothing schedules it. */
	| { readonly kind: 'off' }
	/** Included on every `divider`-th tick. Divider 1 is every tick. */
	| { readonly kind: 'repeating'; readonly divider: number }
	/** Included on the first tick after connect, then retired. */
	| { readonly kind: 'oneShot' };

/** What a row's result occupies in the global buffer. */
export interface RowResult {
	readonly bytes: number;
	/**
	 * Byte alignment the brick requires for this result.
	 *
	 * Not a constant, and not a property of the buffer — a property of the instruction.
	 * `opINPUT_READSI` (0x9d) rejects an unaligned 32-bit result and answers
	 * `DIRECT_REPLY_ERROR` carrying the previous command's payload; the `READY_SI` subcode of
	 * `opINPUT_DEVICE` accepts the same offset and returns the right value. Both measured
	 * 3 of 3 on a brick, which is why this is per row rather than a rule in the assembler.
	 */
	readonly alignment: 1 | 2 | 4;
}

/** A parsed value, with the tick it came from. */
export interface RowValue {
	readonly rowId: string;
	readonly value: number | string | boolean | undefined;
	readonly unit?: string;
	/**
	 * When the reply carrying this value arrived.
	 *
	 * Per row rather than per snapshot: rows in one snapshot come from different ticks, and
	 * without this a consumer cannot tell a fresh value from one carried over.
	 */
	readonly sampledAt: number;
}

export type TelemetryTier = 'sampled' | 'event' | 'static';

/**
 * One readable value, and everything the scheduler and assembler need to handle it.
 *
 * `id` is the contract. It is namespaced and stable across versions, because it is what a
 * third-party extension names in a subscription — an index into an array would break the
 * moment a row is inserted.
 */
export interface TelemetryRow {
	readonly id: string;
	readonly tier: TelemetryTier;
	readonly lifetime: RowLifetime;
	readonly result: RowResult;
	readonly unit?: string;

	/**
	 * The port this row reads, for rows that read one.
	 *
	 * Two things depend on it. A value row only comes up while its port is in the *known*
	 * state, and mode ownership is per port: two rows asking for two modes of one UART sensor
	 * cannot both be active, in one frame or across frames.
	 */
	readonly port?: string;

	/** The UART mode this row selects, where it selects one. */
	readonly mode?: number;

	/** Bytecode reading this value into `slot`. */
	emit(slot: RowSlot): Uint8Array;

	/** Reads this row's value out of a reply payload at the slot the assembler chose. */
	parse(payload: Uint8Array, slot: RowSlot, sampledAt: number): RowValue;
}

/** Divider for a repeating row; 0 for anything not on a repeating schedule. */
export function dividerOf(lifetime: RowLifetime): number {
	return lifetime.kind === 'repeating' ? lifetime.divider : 0;
}

/**
 * Does this row come up on the given tick?
 *
 * One-shot rows come up on tick 0 only. The scheduler retires them rather than asking twice,
 * but answering honestly here keeps the predicate total.
 */
export function comesUpOnTick(lifetime: RowLifetime, tick: number): boolean {
	switch (lifetime.kind) {
	case 'off':
		return false;
	case 'oneShot':
		return tick === 0;
	case 'repeating':
		return lifetime.divider > 0 && tick % lifetime.divider === 0;
	}
}
