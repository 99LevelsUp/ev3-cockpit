/**
 * Service for controlling the EV3 brick LED color and pattern.
 *
 * @packageDocumentation
 */

import { Logger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, uint16le } from '../protocol/ev3Bytecode';
import { DeviceCommandHelper } from './deviceCommandHelper';

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
	private readonly helper: DeviceCommandHelper;
	private lastPattern?: LedPattern;

	public constructor(options: LedServiceOptions) {
		this.helper = new DeviceCommandHelper({
			commandClient: options.commandClient,
			defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_LED_TIMEOUT_MS,
			logger: options.logger,
			servicePrefix: 'led'
		});
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

		await this.helper.sendCommand({ payload });

		this.lastPattern = pattern;
		this.helper.getLogger().info('LED pattern set', { pattern });
	}

	public getLastPattern(): LedPattern | undefined {
		return this.lastPattern;
	}
}
