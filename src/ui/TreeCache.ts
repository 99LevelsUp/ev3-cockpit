export interface TreeCacheEntry<T> {
	data: T;
	timestamp: number;
	ttlMs: number;
}

export interface TreeCacheOptions {
	maxEntries: number;
	ttlMs: number;
}

/**
 * Generická LRU cache s TTL – extrahováno z BrickTreeProvider.
 */
export class TreeCache<K, V> {
	private readonly entries = new Map<K, TreeCacheEntry<V>>();
	private readonly maxEntries: number;
	private readonly defaultTtlMs: number;

	public constructor(options: TreeCacheOptions) {
		this.maxEntries = options.maxEntries;
		this.defaultTtlMs = options.ttlMs;
	}

	public get(key: K): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.timestamp + entry.ttlMs <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// LRU touch – přesun na konec mapy.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.data;
	}

	/** Uloží hodnotu s volitelným per-entry TTL (jinak se použije výchozí). */
	public set(key: K, value: V, ttlMs?: number): void {
		this.entries.delete(key);
		this.entries.set(key, {
			data: value,
			timestamp: Date.now(),
			ttlMs: ttlMs ?? this.defaultTtlMs
		});
		this.evict();
	}

	public delete(key: K): boolean {
		return this.entries.delete(key);
	}

	public clear(): void {
		this.entries.clear();
	}

	public has(key: K): boolean {
		const entry = this.entries.get(key);
		if (!entry) {
			return false;
		}
		if (entry.timestamp + entry.ttlMs <= Date.now()) {
			this.entries.delete(key);
			return false;
		}
		return true;
	}

	public get size(): number {
		return this.entries.size;
	}

	public keys(): IterableIterator<K> {
		return this.entries.keys();
	}

	private evict(): void {
		while (this.entries.size > this.maxEntries) {
			const oldestKey = this.entries.keys().next().value as K | undefined;
			if (!oldestKey) {
				break;
			}
			this.entries.delete(oldestKey);
		}
	}
}
