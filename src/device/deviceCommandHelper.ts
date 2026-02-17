/**
 * Helper utilities for device services to eliminate code duplication.
 * Provides common patterns for sending commands and handling responses.
 */

import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import type { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import type { CommandResult } from '../scheduler/types';
import { EV3_COMMAND, EV3_REPLY, type Ev3Packet } from '../protocol/ev3Packet';

/**
 * Options for creating a device command helper.
 */
export interface DeviceCommandHelperOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
	servicePrefix?: string;
}

/**
 * Request options for sending a device command.
 */
export interface DeviceCommandRequest {
	payload: Uint8Array;
	lane?: Ev3CommandRequest['lane'];
	idempotent?: boolean;
	timeoutMs?: number;
	type?: typeof EV3_COMMAND[keyof typeof EV3_COMMAND];
}

/**
 * Helper class for device services to send commands with common patterns.
 * Eliminates code duplication across buttonService, ledService, motorService, etc.
 */
export class DeviceCommandHelper {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private readonly servicePrefix: string;
	private requestSeq = 0;

	public constructor(options: DeviceCommandHelperOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2000;
		this.logger = options.logger ?? new NoopLogger();
		this.servicePrefix = options.servicePrefix ?? 'device';
	}

	/**
	 * Send a command to the EV3 brick with automatic error handling.
	 * Throws if the reply is DIRECT_REPLY_ERROR.
	 */
	public async sendCommand(request: DeviceCommandRequest): Promise<CommandResult<Ev3Packet>> {
		const requestId = `${this.servicePrefix}-${this.nextSeq()}`;

		const result = await this.commandClient.send({
			id: requestId,
			lane: request.lane ?? 'normal',
			idempotent: request.idempotent ?? true,
			timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
			type: request.type ?? EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload: request.payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error(`${this.servicePrefix} command failed: DIRECT_REPLY_ERROR`);
		}

		return result;
	}

	/**
	 * Send a command without expecting a reply.
	 */
	public async sendCommandNoReply(request: Omit<DeviceCommandRequest, 'type'>): Promise<void> {
		const requestId = `${this.servicePrefix}-${this.nextSeq()}`;

		await this.commandClient.send({
			id: requestId,
			lane: request.lane ?? 'normal',
			idempotent: request.idempotent ?? true,
			timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_NO_REPLY,
			payload: request.payload
		});
	}

	/**
	 * Get the next request sequence number.
	 */
	private nextSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}

	/**
	 * Get the default timeout in milliseconds.
	 */
	public getDefaultTimeout(): number {
		return this.defaultTimeoutMs;
	}

	/**
	 * Get the logger instance.
	 */
	public getLogger(): Logger {
		return this.logger;
	}
}
