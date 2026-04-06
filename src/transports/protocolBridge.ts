/**
 * Protocol bridge — convenience functions for transport providers.
 *
 * Wraps the low-level protocol exports into a simpler API that providers
 * can use to encode commands and decode responses.
 */

import { BrickCommand, BrickResponse } from '../contracts';
import { buildCommand, EncodedCommand } from '../protocol/ev3Commands';
import { encodeEv3Packet, decodeEv3Packet } from '../protocol/ev3Packet';
import { parseResponse } from '../protocol/ev3Responses';
import { getMessageCounter as getMsgCounter } from './pendingReply';

/** Encode a BrickCommand into { type, payload } ready for packet framing. */
export function encodeCommand(command: BrickCommand): EncodedCommand {
	return buildCommand(command);
}

/** Frame an encoded command into a wire-ready packet. */
export function encodePacket(messageCounter: number, type: number, payload: Uint8Array): Uint8Array {
	return encodeEv3Packet(messageCounter, type, payload);
}

/** Decode a raw reply packet into a typed BrickResponse. */
export function decodeResponse(command: BrickCommand, rawReply: Uint8Array): BrickResponse {
	const decoded = decodeEv3Packet(rawReply);
	return parseResponse(command, decoded);
}

/** Read the message counter from bytes 2–3 of a raw packet. */
export function getMessageCounter(rawPacket: Uint8Array): number {
	return getMsgCounter(rawPacket);
}

/**
 * Shared provider helper: encode a BrickCommand, frame it, send via adapter,
 * verify the reply counter, and decode the response.
 *
 * Eliminates duplicate send logic across USB / TCP / BT providers.
 */
export async function sendCommandViaAdapter(
	adapter: { send(packet: Uint8Array, options?: { expectedMessageCounter?: number }): Promise<Uint8Array> },
	command: BrickCommand,
	messageCounter: number,
	transportLabel: string,
): Promise<BrickResponse> {
	const { type, payload } = encodeCommand(command);
	const packet = encodePacket(messageCounter, type, payload);

	const reply = await adapter.send(packet, { expectedMessageCounter: messageCounter });
	const counter = getMessageCounter(reply);
	if (counter !== messageCounter) {
		throw new Error(
			`${transportLabel} reply counter mismatch: expected ${messageCounter}, got ${counter}.`
		);
	}

	return decodeResponse(command, reply);
}
