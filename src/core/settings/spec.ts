/**
 * Every cockpit setting: its key, type, range, default and whether changing it is dangerous.
 *
 * The daemon holds the values; this is the one place that says what a value may be. A dangerous
 * setting widens what clients may do on a brick, so only a person may change it, through a VS Code
 * dialog or an answer typed in a terminal, and an MCP server or an add-on never.
 */

export type SettingType = 'boolean' | 'number' | 'integer' | 'string';

export interface SettingRule {
	readonly key: string;
	readonly type: SettingType;
	readonly default: boolean | number | string;
	readonly minimum?: number;
	/** Values must be greater than `minimum`, not equal to it. */
	readonly exclusiveMinimum?: boolean;
	readonly maximum?: number;
	readonly enum?: readonly string[];
	readonly description: string;
	readonly dangerous: boolean;
	/** Never written to the settings file: it lasts only as long as the daemon. */
	readonly notStored?: boolean;
}

export const SETTING_RULES: readonly SettingRule[] = [
	{
		key: 'accessMode', type: 'string', enum: ['safe', 'full'], default: 'safe', dangerous: true, notStored: true,
		description: 'What clients may do on a brick. safe: write, delete and run only in the projects folder and on the SD card, read everywhere. full: change any file and run shell commands. full lasts until the daemon ends.',
	},
	{
		key: 'rememberBricks', type: 'string', enum: ['wait', 'auto'], default: 'wait', dangerous: false,
		description: 'Bricks that were connected when the cockpit last ended: wait connects them only on Connect; auto connects them as soon as they are seen.',
	},
	{
		key: 'telemetry.staleFactor', type: 'number', default: 3, minimum: 1, dangerous: false,
		description: 'A value is stale once no newer reading has come for this many of its own reading intervals.',
	},
	{
		key: 'telemetry.staleTimeoutMs', type: 'number', default: 10000, minimum: 0, dangerous: false,
		description: 'How long a stale value is still shown, marked, before it is dropped, in milliseconds.',
	},
	{
		key: 'telemetry.throttle.enabled', type: 'boolean', default: true, dangerous: false,
		description: 'Slow a brick\'s telemetry while it answers slowly, and speed it back up when it recovers.',
	},
	{
		key: 'telemetry.throttle.windowSize', type: 'integer', default: 20, minimum: 5, dangerous: false,
		description: 'Telemetry frames per window; the slowest 5 % of a window decides whether to slow down.',
	},
	{
		key: 'telemetry.throttle.tailFactor', type: 'number', default: 3, minimum: 1, dangerous: false,
		description: 'How many times the link\'s usual round trip a window\'s p95 may reach before slowing down.',
	},
	{
		key: 'telemetry.throttle.step', type: 'number', default: 1.5, minimum: 1, exclusiveMinimum: true, dangerous: false,
		description: 'How much one step slows the telemetry tick down, or speeds it back up.',
	},
	{
		key: 'telemetry.throttle.maxSlowdown', type: 'number', default: 4, minimum: 1, dangerous: false,
		description: 'The most the telemetry tick is slowed, as a multiple of its planned tick.',
	},
	{
		key: 'telemetry.throttle.calmWindows', type: 'integer', default: 3, minimum: 1, dangerous: false,
		description: 'Windows in a row within the limit before the telemetry speeds up a step.',
	},
	{
		key: 'telemetry.programRunningTickMs', type: 'number', default: 200, minimum: 0, dangerous: false,
		description: 'While a program runs, its brick\'s telemetry is read no more often than this, in milliseconds; 0 turns it off.',
	},
	{
		key: 'transfer.tcpPacketBytes', type: 'integer', default: 1024, minimum: 64, maximum: 65535, dangerous: false,
		description: 'Largest packet a file transfer sends over Wi-Fi. The stock firmware takes 1024; a larger packet on it can corrupt a file when the link drops.',
	},
	{
		key: 'transfer.btPacketBytes', type: 'integer', default: 1024, minimum: 64, maximum: 65535, dangerous: false,
		description: 'Largest packet a file transfer sends over Bluetooth. The stock firmware takes 1024; a larger packet on it can corrupt a file when the link drops.',
	},
	{
		key: 'programs.statusIntervalMs', type: 'number', default: 1000, minimum: 1, dangerous: false,
		description: 'How often a followed program\'s state is read, in milliseconds.',
	},
];

export type SettingValues = Readonly<Record<string, boolean | number | string>>;

export function ruleFor(key: string): SettingRule | undefined {
	return SETTING_RULES.find((rule) => rule.key === key);
}

/** Why a value is not usable for a setting, or undefined when it is. */
export function problemWith(rule: SettingRule, value: unknown): string | undefined {
	if (rule.type === 'boolean') { return typeof value === 'boolean' ? undefined : 'must be true or false'; }
	if (rule.type === 'string') {
		if (typeof value !== 'string') { return 'must be text'; }
		if (rule.enum && !rule.enum.includes(value)) { return `must be one of ${rule.enum.join(', ')}`; }
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) { return 'must be a number'; }
	if (rule.type === 'integer' && !Number.isInteger(value)) { return 'must be a whole number'; }
	if (rule.minimum !== undefined) {
		if (rule.exclusiveMinimum ? value <= rule.minimum : value < rule.minimum) {
			return `must be ${rule.exclusiveMinimum ? 'greater than' : 'at least'} ${rule.minimum}`;
		}
	}
	if (rule.maximum !== undefined && value > rule.maximum) { return `must be at most ${rule.maximum}`; }
	return undefined;
}

/** Every setting at its default. */
export function defaultSettings(): SettingValues {
	return Object.fromEntries(SETTING_RULES.map((rule) => [rule.key, rule.default]));
}

/**
 * A view of setting values in the shape the telemetry settings readers take, so they read the
 * daemon's values and fall back to these defaults.
 */
export function settingsSection(values: SettingValues): {
	get<T>(key: string): T | undefined;
	inspect<T>(key: string): { readonly defaultValue?: T } | undefined;
} {
	return {
		get: <T>(key: string) => values[key] as T | undefined,
		inspect: <T>(key: string) => {
			const rule = ruleFor(key);
			return rule ? { defaultValue: rule.default as T } : undefined;
		},
	};
}
