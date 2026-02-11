import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, uint16le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

const DIRECT_OP = {
	PROGRAM_STOP: 0x02,
	OUTPUT_STOP: 0xa3
} as const;

const VM_SLOT = {
	USER: 0x01
} as const;

const OUTPUT_LAYER = {
	SELF: 0x00
} as const;

const OUTPUT_PORT_MASK = {
	ALL: 0x0f
} as const;

interface BrickControlServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

/** Default EV3 Brick control command timeout (ms). */
const DEFAULT_BRICK_CONTROL_TIMEOUT_MS = 2000;

export class BrickControlService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;

	public constructor(options: BrickControlServiceOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BRICK_CONTROL_TIMEOUT_MS;
		this.logger = options.logger ?? new NoopLogger();
	}

	public async emergencyStopAll(): Promise<void> {
		// Compound direct command:
		// opPROGRAM_STOP(USER_SLOT), opOUTPUT_STOP(LAYER=0, NOS=ALL, BRAKE=1)
		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([DIRECT_OP.PROGRAM_STOP]),
			lc0(VM_SLOT.USER),
			new Uint8Array([DIRECT_OP.OUTPUT_STOP]),
			lc0(OUTPUT_LAYER.SELF),
			lc0(OUTPUT_PORT_MASK.ALL),
			lc0(1)
		);

		const requestId = `control-emergency-stop-${this.nextRequestSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'emergency',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Emergency stop failed with DIRECT_REPLY_ERROR.');
		}

		if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
			throw new Error(`Emergency stop failed with unexpected reply type 0x${result.reply.type.toString(16)}.`);
		}

		this.logger.info('Emergency stop completed', {
			requestId: result.requestId,
			lane: 'emergency',
			messageCounter: result.messageCounter,
			durationMs: result.durationMs
		});
	}

	public async stopProgram(): Promise<void> {
		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([DIRECT_OP.PROGRAM_STOP]),
			lc0(VM_SLOT.USER)
		);

		const requestId = `control-program-stop-${this.nextRequestSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'high',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Program stop failed with DIRECT_REPLY_ERROR.');
		}

		if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
			throw new Error(`Program stop failed with unexpected reply type 0x${result.reply.type.toString(16)}.`);
		}

		this.logger.info('Program stop completed', {
			requestId: result.requestId,
			lane: 'high',
			messageCounter: result.messageCounter,
			durationMs: result.durationMs
		});
	}

	private nextRequestSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
