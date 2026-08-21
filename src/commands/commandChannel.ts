/**
 * The command layer: a typed command vocabulary executed against one brick session.
 *
 * This sits above the session manager, which owns connections, and below telemetry and
 * the filesystem, which both orchestrate commands. Two things live here that used to be
 * spread across the transports:
 *
 *  - the EV3 codec (`src/protocol/`) is a pure utility, used only from here;
 *  - message counters, reply matching, and command-to-response typing.
 *
 * The transports beneath are now byte movers: they carry a packet and return a packet,
 * and know nothing about what a command means. Before this split a `TransportProvider`
 * accepted a typed `BrickCommand`, which inverted the dependency — the lowest layer
 * owned the protocol that the layers above it were defined in terms of.
 */

import { BrickCommand, BrickResponse, SendCommandOptions } from '../contracts';
import { buildCommand } from '../protocol/ev3Commands';
import { encodeEv3Packet, decodeEv3Packet } from '../protocol/ev3Packet';
import { parseResponse } from '../protocol/ev3Responses';
import { getMessageCounter } from '../transports/pendingReply';
import { ProtocolError } from '../errors/CockpitError';

/**
 * Executes typed commands against one connected brick.
 *
 * Session-scoped, because the message counter is: two channels over one connection would
 * hand out colliding counters and match each other's replies.
 */
export interface CommandChannel {
	execute(command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse>;
}

/** Moves one packet and returns the reply packet. What a transport provides. */
export type SendPacket = (
	packet: Uint8Array,
	options?: SendCommandOptions & { expectedMessageCounter?: number },
) => Promise<Uint8Array>;

/**
 * A channel over a byte transport: frames commands, matches replies, decodes responses.
 *
 * The counter starts at zero and the first command sends 1, matching what the providers
 * did before this moved.
 */
export class PacketCommandChannel implements CommandChannel {
	private counter = 0;

	constructor(
		private readonly sendPacket: SendPacket,
		/** Names the transport in errors; the brick cannot tell us which one it was. */
		private readonly transportLabel: string,
	) {}

	async execute(command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> {
		this.counter = (this.counter + 1) & 0xffff;
		const expected = this.counter;

		const { type, payload } = buildCommand(command);
		const packet = encodeEv3Packet(expected, type, payload);

		const reply = await this.sendPacket(packet, { ...options, expectedMessageCounter: expected });

		const got = getMessageCounter(reply);
		if (got !== expected) {
			// Framing, not a lost link — typed so the heartbeat does not reconnect a brick
			// that is answering.
			throw new ProtocolError(
				`${this.transportLabel} reply counter mismatch: expected ${expected}, got ${got}.`
			);
		}

		return parseResponse(command, decodeEv3Packet(reply));
	}
}
