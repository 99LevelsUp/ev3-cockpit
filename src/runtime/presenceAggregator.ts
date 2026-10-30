import * as vscode from 'vscode';
import {
	BrickEntry, BrickId, BrickKey, BrickName, ChannelState, ConnectionState, DiscoveryItem,
	NameSource, PresenceState, Transport, brickIdOf, brickKeyTransport,
} from '../contracts';
import { createTypedEvent, TypedEvent } from '../events';
import { ProviderRegistry } from '../transports/providerRegistry';
import { BrickChannel } from './brickChannel';
import { ChannelEvent } from './channelStateMachine';
import { DiscoveryScheduler, PresenceChangeEvent } from './discoveryScheduler';

// ── Events ──────────────────────────────────────────────────────────

export interface DiscoveryListChangeEvent {
	readonly items: ReadonlyArray<BrickEntry>;
}

// ── Name trust ──────────────────────────────────────────────────────

/** Sources that follow a rename. Between these the newest wins. */
const CONFIRMED_SOURCES: ReadonlySet<NameSource> = new Set<NameSource>(['brick', 'beacon']);

/** Stale-capable sources, most trustworthy first; used only while no confirmed name exists. */
const UNCONFIRMED_ORDER: readonly NameSource[] = ['usb-descriptor', 'bt-cache', 'fallback'];

interface NameRecord { readonly value: string; readonly at: number }

// ── Brick record ────────────────────────────────────────────────────

interface BrickRecord {
	readonly brickId: BrickId;
	readonly channels: Map<Transport, BrickChannel>;
	readonly names: Map<NameSource, NameRecord>;
	paired: boolean;
	remembered: boolean;
	favorite: boolean;
}

// ── Aggregator ──────────────────────────────────────────────────────

/**
 * Turns per-channel discovery into the discovery list: one entry per brick, however many
 * channels reach it.
 *
 * Discovery reports channels — `usb:00165342D9F2` and `bt:00:16:53:42:D9:F2` are two
 * sightings — and this layer groups them by {@link BrickId}, drives each channel's state
 * machine from presence and session events, and picks the most trustworthy name. It is the
 * single read model for the discovery list; the Cockpit UI and the public API both consume it.
 *
 * It does not order the list, and deliberately so: what belongs at the top is a question about
 * the person reading it, not about discovery. Ordering lives with the views (`ui/brickOrder`).
 *
 * A channel discovery has given up on stays in its brick as `lost`, so a brick whose cable was
 * pulled shows a grey USB channel rather than none. A brick whose every channel has expired is
 * dropped only if nothing ties it to this user — never connected this session and not
 * remembered — so the strangers' bricks a competition room is full of do not pile up.
 */
export class PresenceAggregator implements vscode.Disposable {
	private readonly bricks = new Map<BrickId, BrickRecord>();

	private readonly listChanged: TypedEvent<DiscoveryListChangeEvent>;
	private readonly presenceChanged: TypedEvent<PresenceChangeEvent>;

	/** Fired whenever the discovery list changes. */
	readonly onListChanged: vscode.Event<DiscoveryListChangeEvent>;
	/** Fired on individual channel presence transitions (forwarded from the scheduler). */
	readonly onPresenceChanged: vscode.Event<PresenceChangeEvent>;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly scheduler: DiscoveryScheduler,
		private readonly registry: ProviderRegistry,
	) {
		this.listChanged = createTypedEvent<DiscoveryListChangeEvent>();
		this.presenceChanged = createTypedEvent<PresenceChangeEvent>();
		this.onListChanged = this.listChanged.event;
		this.onPresenceChanged = this.presenceChanged.event;

		this.disposables.push(
			scheduler.onPresenceChanged(e => this.handlePresenceChange(e)),
			scheduler.onScanCompleted(() => this.rebuildFromScheduler()),
		);
	}

	// ── Read model ──────────────────────────────────────────────────

	/** The bricks currently known, in no particular order — sorting belongs to the view. */
	getDiscoveryList(): ReadonlyArray<BrickEntry> {
		return [...this.bricks.values()].map((record) => this.toEntry(record));
	}

	/** One brick's current entry. */
	getBrick(brickId: BrickId): BrickEntry | undefined {
		const record = this.bricks.get(brickId);
		return record ? this.toEntry(record) : undefined;
	}

	// ── Remembered bricks (from persistence) ────────────────────────

	/** Merge remembered bricks from persistence into the list. Their channels start absent. */
	mergeRemembered(remembered: ReadonlyArray<DiscoveryItem>): void {
		for (const item of remembered) {
			const record = this.recordFor(brickIdOf(item.brickKey));
			record.remembered = true;
			record.paired ||= item.paired ?? false;
			this.noteName(record, item, 0);
		}
		this.emitListChanged();
	}

	// ── Mutations owned by the cockpit ──────────────────────────────

	/**
	 * Record the name the brick itself just gave, from an `info` reply.
	 *
	 * The most trustworthy source there is, alongside the TCP beacon: between the two, the
	 * newer name wins.
	 */
	confirmName(brickId: BrickId, name: string): void {
		const record = this.bricks.get(brickId);
		if (!record) { return; }
		if (this.setName(record, 'brick', name, Date.now())) { this.emitListChanged(); }
	}

	/** Update fields this list owns locally on a brick. */
	updateBrick(brickId: BrickId, patch: Partial<Pick<BrickEntry, 'favorite' | 'remembered'>>): void {
		const record = this.bricks.get(brickId);
		if (!record) { return; }
		if (patch.favorite !== undefined) { record.favorite = patch.favorite; }
		if (patch.remembered !== undefined) { record.remembered = patch.remembered; }
		this.emitListChanged();
	}

	/**
	 * Feed a channel's session state into its machine.
	 *
	 * A connected session is proof the brick is there, so a channel discovery has not seen yet
	 * is marked seen first: a brick picked from a live Bluetooth scan can connect before the
	 * device cache lists it.
	 */
	updateChannelSession(brickKey: BrickKey, state: ConnectionState): void {
		const event = SESSION_EVENTS[state];
		if (!event) { return; }
		const transport = brickKeyTransport(brickKey);
		if (!transport) { return; }

		const record = this.bricks.get(brickIdOf(brickKey));
		let channel = record?.channels.get(transport);
		if (event === 'linkUp') {
			channel ??= this.channelFor(this.recordFor(brickIdOf(brickKey)), brickKey, transport);
			if (channel.state === ChannelState.Absent) { channel.apply('seen'); }
		}
		if (!channel || !channel.accepts(event)) { return; }
		if (channel.apply(event)) { this.emitListChanged(); }
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		for (const d of this.disposables) { d.dispose(); }
		this.disposables.length = 0;
		this.listChanged.dispose();
		this.presenceChanged.dispose();
		this.bricks.clear();
	}

	// ── Internals ───────────────────────────────────────────────────

	private handlePresenceChange(e: PresenceChangeEvent): void {
		const brickId = brickIdOf(e.brickKey);
		const record = this.recordFor(brickId);
		const channel = this.channelFor(record, e.brickKey, e.item.transport);
		this.observe(record, channel, e.item);

		const event: ChannelEvent = e.currentState === PresenceState.Available ? 'seen' : 'gone';
		if (channel.accepts(event)) { channel.apply(event); }
		if (e.currentState === PresenceState.Removed) {
			channel.markExpired();
			this.dropIfStranger(record);
		}

		this.presenceChanged.fire(e);
		this.emitListChanged();
	}

	private rebuildFromScheduler(): void {
		for (const [key, tracked] of this.scheduler.getTrackedBricks()) {
			const record = this.recordFor(brickIdOf(key));
			const channel = this.channelFor(record, key, tracked.transport);
			if (tracked.presenceState === PresenceState.Available && channel.state === ChannelState.Absent) {
				channel.apply('seen');
			}
			this.observe(record, channel, tracked);
		}
		this.emitListChanged();
	}

	private observe(record: BrickRecord, channel: BrickChannel, item: DiscoveryItem): void {
		channel.observe(item.lastSeenAt, item.signalInfo);
		record.paired ||= item.paired ?? false;
		this.noteName(record, item, item.lastSeenAt);
	}

	private noteName(record: BrickRecord, item: DiscoveryItem, at: number): void {
		this.setName(record, item.nameSource ?? 'fallback', item.displayName, at);
	}

	/**
	 * Store a name from one source. Returns true when it changed.
	 *
	 * An unchanged name keeps the time it was first given. Otherwise a beacon repeating a name
	 * every scan would always be the newest, and would overrule a rename the cockpit just read
	 * back from the brick for the seconds until the beacon catches up.
	 */
	private setName(record: BrickRecord, source: NameSource, name: string, at: number): boolean {
		const value = name.trim();
		if (!value || record.names.get(source)?.value === value) { return false; }
		record.names.set(source, { value, at });
		return true;
	}

	private recordFor(brickId: BrickId): BrickRecord {
		let record = this.bricks.get(brickId);
		if (!record) {
			record = {
				brickId, channels: new Map(), names: new Map(),
				paired: false, remembered: false, favorite: false,
			};
			this.bricks.set(brickId, record);
		}
		return record;
	}

	private channelFor(record: BrickRecord, brickKey: BrickKey, transport: Transport): BrickChannel {
		let channel = record.channels.get(transport);
		if (!channel) {
			channel = new BrickChannel(brickKey, transport, this.registry.get(transport)?.priority ?? 0);
			record.channels.set(transport, channel);
		}
		return channel;
	}

	private dropIfStranger(record: BrickRecord): void {
		const channels = [...record.channels.values()];
		if (record.remembered || channels.some((c) => c.everConnected || !c.expired)) { return; }
		this.bricks.delete(record.brickId);
	}

	private toEntry(record: BrickRecord): BrickEntry {
		const channels = [...record.channels.values()]
			.filter((c) => c.state !== ChannelState.Absent)
			.map((c) => c.snapshot())
			.sort((a, b) => b.priority - a.priority);
		return {
			brickId: record.brickId,
			name: resolveName(record),
			channels,
			paired: record.paired,
			remembered: record.remembered,
			favorite: record.favorite,
			lastSeenAt: Math.max(0, ...channels.map((c) => c.lastSeenAt)),
		};
	}

	private emitListChanged(): void {
		this.listChanged.fire({ items: this.getDiscoveryList() });
	}
}

/** How a session state reads as a channel event; Connecting says nothing yet. */
const SESSION_EVENTS: Partial<Record<ConnectionState, ChannelEvent>> = {
	[ConnectionState.Connected]: 'linkUp',
	[ConnectionState.Reconnecting]: 'linkDown',
	[ConnectionState.Disconnected]: 'closed',
};

/**
 * The name the list shows: the newest name the brick itself gave, if any; otherwise the most
 * trustworthy stale-capable one, marked unconfirmed.
 */
function resolveName(record: BrickRecord): BrickName {
	let best: { source: NameSource; record: NameRecord } | undefined;
	for (const [source, name] of record.names) {
		if (CONFIRMED_SOURCES.has(source) && (!best || name.at >= best.record.at)) {
			best = { source, record: name };
		}
	}
	if (best) {
		return { value: best.record.value, source: best.source, confirmed: true };
	}
	for (const source of UNCONFIRMED_ORDER) {
		const name = record.names.get(source);
		if (name) { return { value: name.value, source, confirmed: false }; }
	}
	return { value: record.brickId, source: 'fallback', confirmed: false };
}
