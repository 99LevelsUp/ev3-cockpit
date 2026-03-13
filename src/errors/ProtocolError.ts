/**
 * Protocol layer error class for EV3 bytecode protocol violations and malformed packets.
 *
 * @packageDocumentation
 */

import { ExtensionError } from './ExtensionError';

/**
 * Error codes for protocol-level failures.
 */
export enum ProtocolErrorCode {
	/** Packet is malformed or invalid */
	MALFORMED_PACKET = 'MALFORMED_PACKET',
	/** Invalid packet header */
	INVALID_HEADER = 'INVALID_HEADER',
	/** Invalid packet size */
	INVALID_SIZE = 'INVALID_SIZE',
	/** Invalid command type */
	INVALID_COMMAND_TYPE = 'INVALID_COMMAND_TYPE',
	/** Reply does not match expected format */
	INVALID_REPLY = 'INVALID_REPLY',
	/** Reply contains error status */
	REPLY_ERROR = 'REPLY_ERROR',
	/** Sequence number mismatch */
	SEQUENCE_MISMATCH = 'SEQUENCE_MISMATCH',
	/** Checksum validation failed */
	CHECKSUM_FAILED = 'CHECKSUM_FAILED',
	/** Unexpected reply type */
	UNEXPECTED_REPLY_TYPE = 'UNEXPECTED_REPLY_TYPE',
	/** Protocol version mismatch */
	VERSION_MISMATCH = 'VERSION_MISMATCH',
	/** Payload encoding error */
	ENCODING_ERROR = 'ENCODING_ERROR',
	/** Payload decoding error */
	DECODING_ERROR = 'DECODING_ERROR',
	/** Unknown protocol error */
	UNKNOWN = 'UNKNOWN'
}

/**
 * Recovery action recommendation for protocol errors.
 */
export type ProtocolRecoveryAction =
	| 'retry'
	| 'check-firmware'
	| 'update-extension'
	| 'report-bug'
	| 'none';

/**
 * Specialized error for EV3 protocol violations and communication issues.
 * Used when packets are malformed, replies are invalid, or protocol expectations are violated.
 */
export class ProtocolError extends ExtensionError {
	public readonly operation?: string;
	public readonly packetType?: number;
	public readonly expectedType?: number;
	public readonly rawData?: Uint8Array;
	public readonly recommendedAction: ProtocolRecoveryAction;

	public constructor(options: {
		code: ProtocolErrorCode;
		message: string;
		operation?: string;
		packetType?: number;
		expectedType?: number;
		rawData?: Uint8Array;
		recommendedAction?: ProtocolRecoveryAction;
		cause?: unknown;
	}) {
		super(options.code, options.message, options.cause);
		this.name = 'ProtocolError';
		this.operation = options.operation;
		this.packetType = options.packetType;
		this.expectedType = options.expectedType;
		this.rawData = options.rawData;
		this.recommendedAction = options.recommendedAction ?? inferRecoveryAction(options.code);
	}

	/**
	 * Get hex dump of raw data for debugging (limited to first 32 bytes).
	 */
	public getRawDataHex(): string | undefined {
		if (!this.rawData) {
			return undefined;
		}
		const slice = this.rawData.slice(0, 32);
		return Array.from(slice)
			.map(b => b.toString(16).padStart(2, '0'))
			.join(' ');
	}
}

/**
 * Infer recovery action from error code.
 */
function inferRecoveryAction(code: ProtocolErrorCode): ProtocolRecoveryAction {
	switch (code) {
		case ProtocolErrorCode.VERSION_MISMATCH:
			return 'check-firmware';
		case ProtocolErrorCode.MALFORMED_PACKET:
		case ProtocolErrorCode.ENCODING_ERROR:
		case ProtocolErrorCode.DECODING_ERROR:
			return 'report-bug';
		case ProtocolErrorCode.REPLY_ERROR:
		case ProtocolErrorCode.SEQUENCE_MISMATCH:
			return 'retry';
		default:
			return 'none';
	}
}

/**
 * User-facing error messages for protocol errors.
 */
export const PROTOCOL_ERROR_MESSAGES: Record<ProtocolErrorCode, string> = {
	[ProtocolErrorCode.MALFORMED_PACKET]: 'Received a malformed packet from the brick.',
	[ProtocolErrorCode.INVALID_HEADER]: 'Packet header is invalid.',
	[ProtocolErrorCode.INVALID_SIZE]: 'Packet size is invalid or exceeds limits.',
	[ProtocolErrorCode.INVALID_COMMAND_TYPE]: 'Invalid command type in packet.',
	[ProtocolErrorCode.INVALID_REPLY]: 'Reply packet does not match expected format.',
	[ProtocolErrorCode.REPLY_ERROR]: 'Brick replied with an error status.',
	[ProtocolErrorCode.SEQUENCE_MISMATCH]: 'Sequence number in reply does not match request.',
	[ProtocolErrorCode.CHECKSUM_FAILED]: 'Packet checksum validation failed.',
	[ProtocolErrorCode.UNEXPECTED_REPLY_TYPE]: 'Received unexpected reply type.',
	[ProtocolErrorCode.VERSION_MISMATCH]: 'Protocol version mismatch between extension and brick firmware.',
	[ProtocolErrorCode.ENCODING_ERROR]: 'Failed to encode command payload.',
	[ProtocolErrorCode.DECODING_ERROR]: 'Failed to decode reply payload.',
	[ProtocolErrorCode.UNKNOWN]: 'Unknown protocol error occurred.'
};
