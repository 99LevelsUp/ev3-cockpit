import type { Ev3CommandRequest } from './ev3CommandClient';
import type { Ev3Packet } from './ev3Packet';
import type { CommandResult } from '../scheduler/types';

/**
 * Minimal interface for sending EV3 commands and receiving results.
 *
 * @remarks
 * Abstracts the send path so that callers (e.g. device services) do not
 * need to depend on the full {@link EV3CommandClient} class. Useful for
 * testing and for composing command pipelines.
 */
export interface Ev3CommandSendLike {
	/**
	 * Sends an EV3 command and returns the result including timing metadata.
	 *
	 * @param request - Command request specifying packet type and payload
	 * @returns Scheduler result wrapping the raw EV3 reply packet
	 */
	send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>>;
}
