/**
 * Which daemon a client talks to: the user's own, or a development or test daemon on a channel of
 * its own (KTD17). The VS Code extension sets `EV3_COCKPIT_CHANNEL` in its Development and Test
 * modes; the client library and the `ev3` command honour it.
 */

/** The environment variable that names a channel. */
export const CHANNEL_ENV = 'EV3_COCKPIT_CHANNEL';

/** The channel the environment names, or undefined for the user's own daemon. */
export function channelFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const channel = env[CHANNEL_ENV]?.trim();
	return channel ? channel : undefined;
}

/** `dev` and `dev-<suffix>`: a development daemon, which borrows bricks from the user's daemon. */
export function isDevelopmentChannel(channel: string | undefined): boolean {
	return channel === 'dev' || (channel?.startsWith('dev-') ?? false);
}

/** The environment without a channel: what reaches the user's own daemon from inside a development one. */
export function withoutChannel(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const copy = { ...env };
	delete copy[CHANNEL_ENV];
	return copy;
}
