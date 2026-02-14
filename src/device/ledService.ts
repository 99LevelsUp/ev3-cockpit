import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, uint16le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

const OP = {
	UI_WRITE: 0x82
} as const;

const UI_WRITE_SUBCODE = {
	LED: 0x1b
} as const;

/**
 * Valid EV3 LED pattern values (0x00–0x09).
 * 0=off, 1=green, 2=red, 3=orange,
 * 4=green-flash, 5=red-flash, 6=orange-flash,
 * 7=green-pulse, 8=red-pulse, 9=orange-pulse.
 */
export type LedPattern = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export const LED_PATTERN_NAMES: Record<LedPattern, string> = {
	0: 'Off',
	1: 'Green',
	2: 'Red',
	3: 'Orange',
	4: 'Green Flash',
	5: 'Red Flash',
	6: 'Orange Flash',
	7: 'Green Pulse',
	8: 'Red Pulse',
	9: 'Orange Pulse'
};

export function isValidLedPattern(value: number): value is LedPattern {
	return Number.isInteger(value) && value >= 0 && value <= 9;
}

interface LedServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

const DEFAULT_LED_TIMEOUT_MS = 2000;

export class LedService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;
	private lastPattern?: LedPattern;

	public constructor(options: LedServiceOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_LED_TIMEOUT_MS;
		this.logger = options.logger ?? new NoopLogger();
	}

	/**
	 * Set the brick status LED pattern.
	 */
	public async setLedPattern(pattern: LedPattern): Promise<void> {
		if (!isValidLedPattern(pattern)) {
			throw new Error(`Invalid LED pattern: ${pattern}. Must be 0–9.`);
		}

		// opUI_WRITE(LED, PATTERN)
		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.UI_WRITE, UI_WRITE_SUBCODE.LED]),
			lc0(pattern)
		);

		const requestId = `led-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error(`LED set failed: DIRECT_REPLY_ERROR`);
		}

		this.lastPattern = pattern;
		this.logger.info('LED pattern set', { pattern, requestId });
	}

	public getLastPattern(): LedPattern | undefined {
		return this.lastPattern;
	}

	private nextSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
