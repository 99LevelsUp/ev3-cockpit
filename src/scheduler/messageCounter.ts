/**
 * Monotonically increasing 16-bit message counter with pending-set tracking.
 *
 * @remarks
 * Each EV3 command packet carries a unique message counter so that replies
 * can be matched to their requests. This class allocates counter values
 * from the uint16 space (0–65535), tracks which values are currently
 * in-flight, and recycles them when released.
 */

/** Maximum value of a uint16 message counter. */
const MAX_UINT16 = 0xffff;
/** Total number of available counter slots (0 through 65535). */
const COUNTER_SPACE = MAX_UINT16 + 1;

export class MessageCounter {
	/** Next candidate value to try allocating. */
	private next = 0;
	/** Set of currently in-flight (allocated but not yet released) counter values. */
	private readonly pending = new Set<number>();

	/**
	 * Allocates the next available message counter value.
	 *
	 * @returns A unique uint16 counter not currently in use
	 * @throws Error if all 65536 counter values are currently pending
	 */
	public allocate(): number {
		for (let i = 0; i < COUNTER_SPACE; i++) {
			const candidate = this.next;
			this.next = (this.next + 1) & MAX_UINT16;
			if (!this.pending.has(candidate)) {
				this.pending.add(candidate);
				return candidate;
			}
		}

		throw new Error('MessageCounter exhausted: all uint16 values are currently pending.');
	}

	/**
	 * Releases a previously allocated counter value back to the pool.
	 *
	 * @param counter - The counter value to release (masked to uint16)
	 */
	public release(counter: number): void {
		this.pending.delete(counter & MAX_UINT16);
	}

	/**
	 * Checks whether a counter value is currently allocated.
	 *
	 * @param counter - The counter value to check (masked to uint16)
	 * @returns `true` if the counter is in the pending set
	 */
	public isPending(counter: number): boolean {
		return this.pending.has(counter & MAX_UINT16);
	}

	/** Returns the number of currently allocated (in-flight) counter values. */
	public pendingCount(): number {
		return this.pending.size;
	}
}

