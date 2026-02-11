import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, uint16le, gv0 } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

const OP = {
	UI_READ: 0x81
} as const;

const UI_READ_SUBCODE = {
	GET_PRESS: 0x0d
} as const;

/**
 * EV3 button identifiers.
 * The firmware returns a bitmask for pressed buttons.
 */
export const EV3_BUTTON = {
	NONE: 0,
	UP: 1,
	ENTER: 2,
	DOWN: 3,
	RIGHT: 4,
	LEFT: 5,
	BACK: 6
} as const;

export type Ev3ButtonId = typeof EV3_BUTTON[keyof typeof EV3_BUTTON];

export const BUTTON_NAMES: Record<number, string> = {
	[EV3_BUTTON.NONE]: 'None',
	[EV3_BUTTON.UP]: 'Up',
	[EV3_BUTTON.ENTER]: 'Enter',
	[EV3_BUTTON.DOWN]: 'Down',
	[EV3_BUTTON.RIGHT]: 'Right',
	[EV3_BUTTON.LEFT]: 'Left',
	[EV3_BUTTON.BACK]: 'Back'
};

export interface ButtonState {
	pressedButton: number;
	buttonName: string;
	timestampMs: number;
}

interface ButtonServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

const DEFAULT_BUTTON_TIMEOUT_MS = 2000;

export class ButtonService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;

	public constructor(options: ButtonServiceOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BUTTON_TIMEOUT_MS;
		this.logger = options.logger ?? new NoopLogger();
	}

	/**
	 * Read the currently pressed button on the EV3 Brick.
	 * Returns 0 (NONE) if no button is pressed.
	 * Uses opUI_READ(GET_PRESS, BUTTON) → 1 global byte.
	 */
	public async readButton(): Promise<ButtonState> {
		// 1 global byte for the button result
		const payload = concatBytes(
			uint16le(1),
			new Uint8Array([OP.UI_READ, UI_READ_SUBCODE.GET_PRESS]),
			lc0(0), // BUTTON parameter (0 = query which is pressed)
			gv0(0)  // result → global var 0
		);

		const requestId = `button-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error('Button read failed: DIRECT_REPLY_ERROR');
		}

		const replyPayload = result.reply.payload;
		const pressedButton = replyPayload.length >= 1 ? replyPayload[0] : 0;
		const buttonName = BUTTON_NAMES[pressedButton] ?? 'Unknown';

		return {
			pressedButton,
			buttonName,
			timestampMs: Date.now()
		};
	}

	private nextSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
