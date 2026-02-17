import { Logger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, lc1, uint16le, gv0 } from '../protocol/ev3Bytecode';
import type { MotorPort, MotorStopMode, TachoReading } from './motorTypes';
import { MOTOR_PORT_MASK } from './motorTypes';
import { DeviceCommandHelper } from './deviceCommandHelper';

const OP = {
	OUTPUT_SPEED: 0xa5,
	OUTPUT_START: 0xa6,
	OUTPUT_STOP: 0xa3,
	OUTPUT_RESET: 0xa2,
	OUTPUT_GET_COUNT: 0xb3
} as const;

const LAYER_SELF = 0x00;

interface MotorServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

const DEFAULT_MOTOR_TIMEOUT_MS = 2000;

export class MotorService {
	private readonly helper: DeviceCommandHelper;

	public constructor(options: MotorServiceOptions) {
		this.helper = new DeviceCommandHelper({
			commandClient: options.commandClient,
			defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_MOTOR_TIMEOUT_MS,
			logger: options.logger,
			servicePrefix: 'motor'
		});
	}

	/**
	 * Set motor speed (with regulation) and start.
	 * Speed range: -100..+100.
	 */
	public async setSpeedAndStart(port: MotorPort, speed: number): Promise<void> {
		const clampedSpeed = Math.max(-100, Math.min(100, Math.round(speed)));
		const portMask = MOTOR_PORT_MASK[port];

		// opOUTPUT_SPEED(LAYER, NOS, SPEED) + opOUTPUT_START(LAYER, NOS)
		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.OUTPUT_SPEED]),
			lc0(LAYER_SELF),
			lc0(portMask),
			lc1(clampedSpeed),
			new Uint8Array([OP.OUTPUT_START]),
			lc0(LAYER_SELF),
			lc0(portMask)
		);

		await this.helper.sendCommand({
			payload,
			lane: 'high',
			idempotent: false
		});

		this.helper.getLogger().info('Motor started', { port, speed: clampedSpeed });
	}

	/**
	 * Stop motor on a specific port.
	 */
	public async stopMotor(port: MotorPort, mode: MotorStopMode = 'brake'): Promise<void> {
		const portMask = MOTOR_PORT_MASK[port];
		const brakeFlag = mode === 'brake' ? 1 : 0;

		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.OUTPUT_STOP]),
			lc0(LAYER_SELF),
			lc0(portMask),
			lc0(brakeFlag)
		);

		await this.helper.sendCommand({
			payload,
			lane: 'high',
			idempotent: true
		});
	}

	/**
	 * Reset tacho counter for a port.
	 */
	public async resetTacho(port: MotorPort): Promise<void> {
		const portMask = MOTOR_PORT_MASK[port];

		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.OUTPUT_RESET]),
			lc0(LAYER_SELF),
			lc0(portMask)
		);

		await this.helper.sendCommand({
			payload,
			lane: 'normal',
			idempotent: true
		});
	}

	/**
	 * Read tacho position counter (signed int32).
	 * Uses opOUTPUT_GET_COUNT → 4 bytes.
	 */
	public async readTacho(port: MotorPort): Promise<TachoReading> {
		const portIndex = ['A', 'B', 'C', 'D'].indexOf(port);

		// 4 global bytes for int32 reply
		const payload = concatBytes(
			uint16le(4),
			new Uint8Array([OP.OUTPUT_GET_COUNT]),
			lc0(LAYER_SELF),
			lc0(portIndex),
			gv0(0)
		);

		const result = await this.helper.sendCommand({
			payload,
			lane: 'normal',
			idempotent: true
		});

		const replyPayload = result.reply.payload;
		let position = 0;
		if (replyPayload.length >= 4) {
			position = new DataView(replyPayload.buffer, replyPayload.byteOffset, replyPayload.byteLength)
				.getInt32(0, true);
		}

		return {
			port,
			position,
			timestampMs: Date.now()
		};
	}
}
