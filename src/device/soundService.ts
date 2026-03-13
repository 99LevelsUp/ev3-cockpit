/**
 * Service for playing tones and sound files on the EV3 brick speaker.
 *
 * @packageDocumentation
 */

import { Logger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc2, lcs, uint16le } from '../protocol/ev3Bytecode';
import { DeviceCommandHelper } from './deviceCommandHelper';

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
	private readonly helper: DeviceCommandHelper;

	public constructor(options: SoundServiceOptions) {
		this.helper = new DeviceCommandHelper({
			commandClient: options.commandClient,
			defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_SOUND_TIMEOUT_MS,
			logger: options.logger,
			servicePrefix: 'sound'
		});
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

		await this.helper.sendCommand({
			payload,
			lane: 'normal',
			idempotent: false
		});

		this.helper.getLogger().info('Tone played', { volume: vol, frequencyHz: freq, durationMs: dur });
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

		await this.helper.sendCommand({
			payload,
			lane: 'normal',
			idempotent: false
		});

		this.helper.getLogger().info('Sound file played', { volume: vol, filePath });
	}
}
