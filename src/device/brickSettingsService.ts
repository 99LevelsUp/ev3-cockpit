import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, lc2, lcs, uint16le, gv0 } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

const OP = {
	UI_READ: 0x81,
	UI_WRITE: 0x82,
	INFO: 0x7c
} as const;

const UI_READ_SUBCODE = {
	GET_VBATT: 0x01,
	GET_LBATT: 0x12,
	GET_SDCARD: 0x1d,
	GET_VOLUME: 0x1a,
	GET_SLEEP: 0x0e
} as const;

const UI_WRITE_SUBCODE = {
	SET_VOLUME: 0x06,
	SET_SLEEP: 0x07
} as const;

const INFO_SUBCODE = {
	SET_BRICKNAME: 0x08,
	GET_BRICKNAME: 0x0d
} as const;

export interface BatteryInfo {
	voltage: number;
	level: number;
}

export interface BrickSettings {
	brickName?: string;
	volume?: number;
	sleepMinutes?: number;
	battery?: BatteryInfo;
}

interface BrickSettingsServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

const DEFAULT_SETTINGS_TIMEOUT_MS = 2000;
const BRICKNAME_MAX_LEN = 12;

export class BrickSettingsService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;

	public constructor(options: BrickSettingsServiceOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SETTINGS_TIMEOUT_MS;
		this.logger = options.logger ?? new NoopLogger();
	}

	/**
	 * Read the brick name (up to 12 chars).
	 * Uses opINFO(GET_BRICKNAME, LEN) → string in global vars.
	 */
	public async getBrickName(): Promise<string> {
		const globalBytes = BRICKNAME_MAX_LEN + 1;
		const payload = concatBytes(
			uint16le(globalBytes),
			new Uint8Array([OP.INFO, INFO_SUBCODE.GET_BRICKNAME]),
			lc0(globalBytes),
			gv0(0)
		);

		const requestId = `settings-getname-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Get brick name failed: DIRECT_REPLY_ERROR');
		}

		return this.parseCString(result.reply.payload, 0, globalBytes);
	}

	/**
	 * Set the brick name (max 12 chars).
	 * Uses opINFO(SET_BRICKNAME, NAME).
	 */
	public async setBrickName(name: string): Promise<void> {
		const trimmed = name.slice(0, BRICKNAME_MAX_LEN);

		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.INFO, INFO_SUBCODE.SET_BRICKNAME]),
			lcs(trimmed)
		);

		const requestId = `settings-setname-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: false,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Set brick name failed: DIRECT_REPLY_ERROR');
		}

		this.logger.info('Brick name set', { name: trimmed, requestId });
	}

	/**
	 * Read battery voltage (float32) and level (int8 percentage).
	 */
	public async getBatteryInfo(): Promise<BatteryInfo> {
		// 4 bytes for voltage (float32) + 1 byte for level
		const globalBytes = 5;
		const payload = concatBytes(
			uint16le(globalBytes),
			new Uint8Array([OP.UI_READ, UI_READ_SUBCODE.GET_VBATT]),
			gv0(0),
			new Uint8Array([OP.UI_READ, UI_READ_SUBCODE.GET_LBATT]),
			gv0(4)
		);

		const requestId = `settings-battery-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Battery read failed: DIRECT_REPLY_ERROR');
		}

		const rp = result.reply.payload;
		const voltage = rp.length >= 4
			? new DataView(rp.buffer, rp.byteOffset, rp.byteLength).getFloat32(0, true)
			: 0;
		const level = rp.length >= 5 ? rp[4] : 0;

		return { voltage, level };
	}

	/**
	 * Read current volume setting (0–100).
	 */
	public async getVolume(): Promise<number> {
		const payload = concatBytes(
			uint16le(1),
			new Uint8Array([OP.UI_READ, UI_READ_SUBCODE.GET_VOLUME]),
			gv0(0)
		);

		const requestId = `settings-getvol-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Get volume failed: DIRECT_REPLY_ERROR');
		}

		return result.reply.payload.length >= 1 ? result.reply.payload[0] : 0;
	}

	/**
	 * Set volume (0–100).
	 */
	public async setVolume(volume: number): Promise<void> {
		const clamped = Math.max(0, Math.min(100, Math.round(volume)));

		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.UI_WRITE, UI_WRITE_SUBCODE.SET_VOLUME]),
			lc2(clamped)
		);

		const requestId = `settings-setvol-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Set volume failed: DIRECT_REPLY_ERROR');
		}

		this.logger.info('Volume set', { volume: clamped, requestId });
	}

	/**
	 * Read current sleep timer (minutes, 0 = never sleep).
	 */
	public async getSleepTimer(): Promise<number> {
		const payload = concatBytes(
			uint16le(1),
			new Uint8Array([OP.UI_READ, UI_READ_SUBCODE.GET_SLEEP]),
			gv0(0)
		);

		const requestId = `settings-getsleep-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Get sleep timer failed: DIRECT_REPLY_ERROR');
		}

		return result.reply.payload.length >= 1 ? result.reply.payload[0] : 0;
	}

	/**
	 * Set sleep timer (minutes, 0 = never sleep).
	 */
	public async setSleepTimer(minutes: number): Promise<void> {
		const clamped = Math.max(0, Math.min(120, Math.round(minutes)));

		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.UI_WRITE, UI_WRITE_SUBCODE.SET_SLEEP]),
			lc2(clamped)
		);

		const requestId = `settings-setsleep-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Set sleep timer failed: DIRECT_REPLY_ERROR');
		}

		this.logger.info('Sleep timer set', { minutes: clamped, requestId });
	}

	private parseCString(bytes: Uint8Array, offset: number, maxLen: number): string {
		const end = Math.min(bytes.length, offset + maxLen);
		let zeroIndex = end;
		for (let i = offset; i < end; i++) {
			if (bytes[i] === 0) {
				zeroIndex = i;
				break;
			}
		}
		return Buffer.from(bytes.subarray(offset, zeroIndex)).toString('utf8').trim();
	}

	private nextSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
