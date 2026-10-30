/**
 * One brick on one transport — a channel — as the discovery list tracks it.
 *
 * One class for every transport: the state lives in a {@link ChannelStateMachine} the channel
 * holds through its interface, and what differs between transports stays in their providers.
 */

import { BrickKey } from '../contracts/brickKey';
import { ChannelState, Transport } from '../contracts/enums';
import { BrickChannelSnapshot, SignalInfo } from '../contracts/models';
import { BaseChannelStateMachine, ChannelEvent, ChannelStateMachine } from './channelStateMachine';

export class BrickChannel {
	private signalInfo?: SignalInfo;
	private lastSeenAt = 0;
	private _heardAt?: number;
	private _everConnected = false;
	private _expired = false;

	constructor(
		readonly brickKey: BrickKey,
		readonly transport: Transport,
		/** The provider's priority for this transport (`TransportProvider.priority`). */
		readonly priority: number,
		private readonly machine: ChannelStateMachine = new BaseChannelStateMachine(),
	) {}

	get state(): ChannelState { return this.machine.state; }

	/** Whether a session over this channel has ever been connected this session. */
	get everConnected(): boolean { return this._everConnected; }

	/** When the brick last answered a presence check over this channel, if it ever has. */
	get heardAt(): number | undefined { return this._heardAt; }

	/** Whether discovery has given the channel up for good (`removed`) and nothing has seen it since. */
	get expired(): boolean { return this._expired; }

	accepts(event: ChannelEvent): boolean {
		return this.machine.accepts(event);
	}

	/** Apply an event to the machine. Returns true when the state changed. */
	apply(event: ChannelEvent): boolean {
		const changed = this.machine.apply(event);
		if (event === 'linkUp') { this._everConnected = true; }
		if (event === 'seen' || event === 'linkUp') { this._expired = false; }
		return changed;
	}

	/** Record that discovery has given the channel up for good. */
	markExpired(): void {
		this._expired = true;
	}

	/** Record what discovery last saw on this channel. */
	observe(lastSeenAt: number, signalInfo?: SignalInfo, heardAt?: number): void {
		this.lastSeenAt = lastSeenAt;
		this.signalInfo = signalInfo;
		if (heardAt !== undefined) { this._heardAt = heardAt; }
	}

	snapshot(): BrickChannelSnapshot {
		return {
			brickKey: this.brickKey,
			transport: this.transport,
			priority: this.priority,
			state: this.machine.state,
			...(this.signalInfo ? { signalInfo: this.signalInfo } : {}),
			lastSeenAt: this.lastSeenAt,
			...(this._heardAt !== undefined ? { heardAt: this._heardAt } : {}),
		};
	}
}
