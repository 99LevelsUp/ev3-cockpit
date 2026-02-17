import { Logger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, uint16le, gv0 } from '../protocol/ev3Bytecode';
import { DeviceCommandHelper } from './deviceCommandHelper';

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
	private readonly helper: DeviceCommandHelper;

	public constructor(options: ButtonServiceOptions) {
		this.helper = new DeviceCommandHelper({
			commandClient: options.commandClient,
			defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_BUTTON_TIMEOUT_MS,
			logger: options.logger,
			servicePrefix: 'button'
		});
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

		const result = await this.helper.sendCommand({ payload });

		const replyPayload = result.reply.payload;
		const pressedButton = replyPayload.length >= 1 ? replyPayload[0] : 0;
		const buttonName = BUTTON_NAMES[pressedButton] ?? 'Unknown';

		return {
			pressedButton,
			buttonName,
			timestampMs: Date.now()
		};
	}
}
