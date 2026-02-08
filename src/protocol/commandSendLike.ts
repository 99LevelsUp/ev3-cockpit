import type { Ev3CommandRequest } from './ev3CommandClient';
import type { Ev3Packet } from './ev3Packet';
import type { CommandResult } from '../scheduler/types';

export interface Ev3CommandSendLike {
	send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>>;
}
