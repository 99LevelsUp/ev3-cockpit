const MAX_UINT16 = 0xffff;
const COUNTER_SPACE = MAX_UINT16 + 1;

export class MessageCounter {
	private next = 0;
	private readonly pending = new Set<number>();

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

	public release(counter: number): void {
		this.pending.delete(counter & MAX_UINT16);
	}

	public isPending(counter: number): boolean {
		return this.pending.has(counter & MAX_UINT16);
	}

	public pendingCount(): number {
		return this.pending.size;
	}
}

