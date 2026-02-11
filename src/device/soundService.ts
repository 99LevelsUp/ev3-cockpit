import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc2, lcs, uint16le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

const OP = {
	SOUND: 0x94
} as const;

const SOUND_SUBCODE = {
	TONE: 0x01,
	PLAY: 0x02
} as const;

interface SoundServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

const DEFAULT_SOUND_TIMEOUT_MS = 3000;

export class SoundService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;

	public constructor(options: SoundServiceOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SOUND_TIMEOUT_MS;
		this.logger = options.logger ?? new NoopLogger();
	}

	/**
	 * Play a tone at the given frequency (Hz) and duration (ms).
	 * Volume: 0–100.
	 */
	public async playTone(volume: number, frequencyHz: number, durationMs: number): Promise<void> {
		const vol = Math.max(0, Math.min(100, Math.round(volume)));
		const freq = Math.max(250, Math.min(10000, Math.round(frequencyHz)));
		const dur = Math.max(1, Math.round(durationMs));

		// opSOUND(TONE, VOLUME, FREQUENCY, DURATION)
		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.SOUND, SOUND_SUBCODE.TONE]),
			lc2(vol),
			lc2(freq),
			lc2(dur)
		);

		const requestId = `sound-tone-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: false,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error(`Play tone failed: DIRECT_REPLY_ERROR`);
		}

		this.logger.info('Tone played', { volume: vol, frequencyHz: freq, durationMs: dur, requestId });
	}

	/**
	 * Play a sound file from the brick filesystem.
	 * Path should be relative to /home/root/lms2012/prjs/ (without .rsf extension).
	 */
	public async playSoundFile(volume: number, filePath: string): Promise<void> {
		const vol = Math.max(0, Math.min(100, Math.round(volume)));

		// opSOUND(PLAY, VOLUME, FILENAME)
		const payload = concatBytes(
			uint16le(0),
			new Uint8Array([OP.SOUND, SOUND_SUBCODE.PLAY]),
			lc2(vol),
			lcs(filePath)
		);

		const requestId = `sound-file-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: false,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error(`Play sound file failed: DIRECT_REPLY_ERROR (file: ${filePath})`);
		}

		this.logger.info('Sound file played', { volume: vol, filePath, requestId });
	}

	private nextSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
