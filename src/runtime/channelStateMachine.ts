/**
 * Channel state machine — the state of one channel to one brick, as the list shows it.
 *
 * Behind an interface so a transport that ever needs other states can bring its own machine
 * without touching {@link BrickChannel} or the brick layer, which know only this interface.
 * Every current transport uses {@link BaseChannelStateMachine}: USB, Bluetooth, TCP and the
 * mock lose and regain a channel the same way, and what differs between them lives in their
 * providers (step-2 plan, KTD4).
 */

import { ChannelState } from '../contracts/enums';
import { InvalidTransitionError } from '../errors/CockpitError';

/**
 * What can happen to a channel. Facts, not commands: the machine decides what they mean.
 *
 * - `seen`: discovery reports the brick on this transport, or a presence check answered.
 * - `gone`: discovery stopped reporting it, or a presence check went unanswered.
 * - `linkUp`: a session over this channel is connected.
 * - `linkDown`: that session lost its link and is reconnecting.
 * - `closed`: that session ended — signed out, or a join that failed.
 */
export type ChannelEvent = 'seen' | 'gone' | 'linkUp' | 'linkDown' | 'closed';

/** The state of one channel, driven by {@link ChannelEvent}s. */
export interface ChannelStateMachine {
	readonly state: ChannelState;
	/** Whether `event` is a valid transition from the current state. */
	accepts(event: ChannelEvent): boolean;
	/**
	 * Apply an event. Returns true when the state changed.
	 * @throws {InvalidTransitionError} When the event is not valid in the current state.
	 */
	apply(event: ChannelEvent): boolean;
}

/**
 * Valid transitions. An event missing from a state's row is invalid there.
 *
 * Two rules worth naming. A connected channel stays connected while discovery misses it: the
 * live session is stronger evidence than a scan (USB discovery skips a device its own
 * transport holds claimed). And a lost channel stays lost when its session closes: closing
 * says nothing about whether the brick came back.
 */
const TRANSITIONS: Record<ChannelState, Partial<Record<ChannelEvent, ChannelState>>> = {
	[ChannelState.Absent]: {
		seen: ChannelState.Available,
	},
	[ChannelState.Available]: {
		seen: ChannelState.Available,
		gone: ChannelState.Lost,
		linkUp: ChannelState.Connected,
		closed: ChannelState.Available,
	},
	[ChannelState.Connected]: {
		seen: ChannelState.Connected,
		gone: ChannelState.Connected,
		linkUp: ChannelState.Connected,
		linkDown: ChannelState.Lost,
		closed: ChannelState.Available,
	},
	[ChannelState.Lost]: {
		seen: ChannelState.Available,
		gone: ChannelState.Lost,
		linkUp: ChannelState.Connected,
		linkDown: ChannelState.Lost,
		closed: ChannelState.Lost,
	},
};

/** The machine every current transport uses. */
export class BaseChannelStateMachine implements ChannelStateMachine {
	private _state = ChannelState.Absent;

	get state(): ChannelState { return this._state; }

	accepts(event: ChannelEvent): boolean {
		return TRANSITIONS[this._state][event] !== undefined;
	}

	apply(event: ChannelEvent): boolean {
		const next = TRANSITIONS[this._state][event];
		if (next === undefined) {
			throw new InvalidTransitionError(`Invalid channel transition: ${this._state} on ${event}`);
		}
		const changed = next !== this._state;
		this._state = next;
		return changed;
	}
}
