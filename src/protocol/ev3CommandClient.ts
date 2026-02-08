import { Logger, NoopLogger } from '../diagnostics/logger';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { CommandResult, Lane, RetryPolicy } from '../scheduler/types';
import { TransportAdapter } from '../transport/transportAdapter';
import { decodeEv3Packet, encodeEv3Packet, Ev3Packet } from './ev3Packet';

export interface Ev3CommandRequest {
	id?: string;
	lane?: Lane;
	timeoutMs?: number;
	idempotent?: boolean;
	signal?: AbortSignal;
	retry?: RetryPolicy;
	type: number;
	payload?: Uint8Array;
}

interface Ev3CommandClientOptions {
	scheduler: CommandScheduler;
	transport: TransportAdapter;
	logger?: Logger;
}

export class Ev3CommandClient {
	private readonly scheduler: CommandScheduler;
	private readonly transport: TransportAdapter;
	private readonly logger: Logger;

	public constructor(options: Ev3CommandClientOptions) {
		this.scheduler = options.scheduler;
		this.transport = options.transport;
		this.logger = options.logger ?? new NoopLogger();
	}

	public async open(): Promise<void> {
		await this.transport.open();
	}

	public async close(): Promise<void> {
		await this.transport.close();
	}

	public async send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>> {
		const lane = request.lane ?? 'normal';
		const payload = request.payload ?? new Uint8Array();

		const result = await this.scheduler.enqueue<Ev3Packet>({
			id: request.id,
			lane,
			timeoutMs: request.timeoutMs,
			idempotent: request.idempotent,
			signal: request.signal,
			retry: request.retry,
			execute: async ({ messageCounter, timeoutMs, signal }) => {
				const packet = encodeEv3Packet(messageCounter, request.type, payload);
				const replyBytes = await this.transport.send(packet, {
					timeoutMs,
					signal,
					expectedMessageCounter: messageCounter
				});
				const reply = decodeEv3Packet(replyBytes);

				if (reply.messageCounter !== messageCounter) {
					throw new Error(
						`Reply messageCounter mismatch: expected ${messageCounter}, got ${reply.messageCounter}.`
					);
				}

				return reply;
			}
		});

		this.logger.debug('EV3 command completed', {
			requestId: result.requestId,
			lane,
			messageCounter: result.messageCounter,
			type: request.type,
			payloadBytes: payload.length,
			durationMs: result.durationMs
		});

		return result;
	}
}
