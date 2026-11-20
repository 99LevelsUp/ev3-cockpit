/**
 * Who holds each brick. A brick stays connected while it has at least one holder — a client that
 * connected it, the hold `ev3 connect` leaves, or the long-lived clients together for a remembered
 * brick — and is signed out when its last holder goes. Each VS Code window is a holder of its own.
 *
 * A disconnect drops only the caller's hold; "for everyone" clears them all.
 */

import type { BrickHolder } from '../contract/models';

/** One holder of one brick. */
export type Holder =
	| { readonly kind: 'client'; readonly clientId: string; readonly name: string }
	| { readonly kind: 'hold' }
	| { readonly kind: 'remembered' };

/** Holders as plain data, for a handover. */
export type HolderSnapshot = Readonly<Record<string, readonly Holder[]>>;

export interface HolderSetsOptions {
	/** Signs a brick out once nobody holds it. */
	readonly signOut: (brickId: string) => Promise<void> | void;
	/** Told whenever the holders change, so clients can hear it and a handover can save it. */
	readonly onChange?: () => void;
}

function same(a: Holder, b: Holder): boolean {
	if (a.kind !== b.kind) { return false; }
	return a.kind !== 'client' || a.clientId === (b as { clientId: string }).clientId;
}

export class HolderSets {
	private readonly sets = new Map<string, Holder[]>();

	constructor(private readonly options: HolderSetsOptions) {}

	add(brickId: string, holder: Holder): void {
		const set = this.sets.get(brickId) ?? [];
		if (!set.some((h) => same(h, holder))) { set.push(holder); }
		this.sets.set(brickId, set);
		this.options.onChange?.();
	}

	/**
	 * Drops one holder from a brick; signs the brick out when it was the last. Returns who still
	 * holds it.
	 */
	async drop(brickId: string, holder: Holder): Promise<readonly BrickHolder[]> {
		const set = this.sets.get(brickId);
		if (!set) { return []; }
		const remaining = set.filter((h) => !same(h, holder));
		await this.settle(brickId, remaining);
		return this.holdersOf(brickId);
	}

	/** Signs a brick out whoever holds it. */
	async dropAll(brickId: string): Promise<void> {
		await this.settle(brickId, []);
	}

	/** A client left: every brick it held loses that hold, and those it held alone are signed out. */
	async clientLeft(clientId: string): Promise<string[]> {
		const released: string[] = [];
		for (const [brickId, set] of [...this.sets]) {
			if (!set.some((h) => h.kind === 'client' && h.clientId === clientId)) { continue; }
			const remaining = set.filter((h) => !(h.kind === 'client' && h.clientId === clientId));
			await this.settle(brickId, remaining);
			if (remaining.length === 0) { released.push(brickId); }
		}
		return released;
	}

	/** The long-lived clients are all gone: remembered bricks lose that hold. */
	async rememberedReleased(): Promise<void> {
		for (const [brickId, set] of [...this.sets]) {
			if (!set.some((h) => h.kind === 'remembered')) { continue; }
			await this.settle(brickId, set.filter((h) => h.kind !== 'remembered'));
		}
	}

	/** A brick went away by itself (forgotten, lent): forget its holders without signing it out. */
	forget(brickId: string): void {
		if (this.sets.delete(brickId)) { this.options.onChange?.(); }
	}

	holdersOf(brickId: string): BrickHolder[] {
		return (this.sets.get(brickId) ?? []).map((h) => (h.kind === 'client' ? { kind: 'client', client: h.name } : { kind: h.kind }));
	}

	isHeld(brickId: string): boolean {
		return (this.sets.get(brickId)?.length ?? 0) > 0;
	}

	/** How many bricks `ev3 connect` holds: they keep the daemon alive with no client. */
	holdCount(): number {
		return [...this.sets.values()].filter((set) => set.some((h) => h.kind === 'hold')).length;
	}

	heldBricks(): string[] {
		return [...this.sets.keys()];
	}

	snapshot(): HolderSnapshot {
		return Object.fromEntries([...this.sets].map(([brickId, set]) => [brickId, [...set]]));
	}

	/** Takes over a predecessor's holders. Clients get new connections, so their holds are kept by name until they reconnect. */
	restore(snapshot: HolderSnapshot): void {
		for (const [brickId, set] of Object.entries(snapshot)) {
			this.sets.set(brickId, [...set]);
		}
		this.options.onChange?.();
	}

	/**
	 * A reconnected client takes back the holds it had under its old connection, matched by name;
	 * with `among`, only holds of those old connections.
	 */
	reclaim(oldName: string, clientId: string, among?: ReadonlySet<string>): void {
		let changed = false;
		for (const set of this.sets.values()) {
			for (let i = 0; i < set.length; i++) {
				const h = set[i];
				if (h.kind === 'client' && h.name === oldName && h.clientId !== clientId && (!among || among.has(h.clientId))) {
					set[i] = { kind: 'client', clientId, name: h.name };
					changed = true;
				}
			}
		}
		if (changed) { this.options.onChange?.(); }
	}

	/** Holds kept from a predecessor for clients that never came back are dropped. */
	async dropClientsExcept(clientIds: ReadonlySet<string>): Promise<void> {
		const gone = new Set<string>();
		for (const set of this.sets.values()) {
			for (const h of set) { if (h.kind === 'client' && !clientIds.has(h.clientId)) { gone.add(h.clientId); } }
		}
		for (const clientId of gone) { await this.clientLeft(clientId); }
	}

	private async settle(brickId: string, remaining: Holder[]): Promise<void> {
		if (remaining.length > 0) {
			this.sets.set(brickId, remaining);
			this.options.onChange?.();
			return;
		}
		this.sets.delete(brickId);
		this.options.onChange?.();
		await this.options.signOut(brickId);
	}
}
