/**
 * `ev3 config list | get <key> | set <key> <value>`: the cockpit's settings, which the daemon holds.
 *
 * The keys are exactly the ones the contract's settings definition lists, spelled as `ev3 config`
 * spells them (`access-mode`, `telemetry.stale-factor`); the contract's own spelling (`accessMode`)
 * works too. Any other key is a wrong command line and reaches no daemon. A dangerous setting —
 * access mode `full` — changes only after a person said yes to the daemon's question, which comes
 * to this terminal when it can answer; without a terminal, or with `--json`, the daemon refuses it
 * and names the command a person can run.
 */

import { SETTING_SPECS } from '../../contract/generated';
import type { SettingScalar, SettingSpec } from '../../contract/generated';
import { UsageError, table } from '../output';
import { Command, CommandContext, arg, atMost } from './context';

/** The setting a key names, by its CLI spelling or its contract key; a usage error for any other. */
export function settingSpec(spelled: string): SettingSpec {
	const spec = SETTING_SPECS.find((s) => s.cliKey === spelled || s.key === spelled);
	if (!spec) {
		throw new UsageError(`There is no setting ${spelled}. The settings are: ${SETTING_SPECS.map((s) => s.cliKey).join(', ')}.`);
	}
	return spec;
}

/** A value as the setting's type reads it; the daemon checks the limits. */
export function parseSettingValue(spec: SettingSpec, text: string): SettingScalar {
	if (spec.type === 'boolean') {
		if (text === 'true' || text === 'false') { return text === 'true'; }
		throw new UsageError(`${spec.cliKey} is true or false.`);
	}
	if (spec.type === 'number' || spec.type === 'integer') {
		const value = Number(text);
		if (text.trim() === '' || !Number.isFinite(value)) { throw new UsageError(`${spec.cliKey} is a number.`); }
		if (spec.type === 'integer' && !Number.isInteger(value)) { throw new UsageError(`${spec.cliKey} is a whole number.`); }
		return value;
	}
	if (spec.enum && !spec.enum.includes(text)) { throw new UsageError(`${spec.cliKey} is one of ${spec.enum.join(', ')}.`); }
	return text;
}

async function list(ctx: CommandContext): Promise<{ value: unknown; human: string[] }> {
	atMost(ctx, 1, 'ev3 config list');
	const { settings } = await (await ctx.client()).request('settings/list', {});
	return {
		value: settings,
		human: table(settings.map((s) => [s.spec.cliKey, String(s.value), s.value === s.spec.default ? '' : `(default ${String(s.spec.default)})`])),
	};
}

async function get(ctx: CommandContext): Promise<{ value: unknown; human: string }> {
	atMost(ctx, 2, 'ev3 config get <key>');
	const spec = settingSpec(arg(ctx, 1, 'the setting'));
	const { settings } = await (await ctx.client()).request('settings/list', {});
	const setting = settings.find((s) => s.spec.key === spec.key);
	if (!setting) { throw new Error(`The cockpit daemon does not have the setting ${spec.cliKey}; update the older of the two.`); }
	return { value: setting, human: String(setting.value) };
}

async function set(ctx: CommandContext): Promise<{ value: unknown; human: string }> {
	atMost(ctx, 3, 'ev3 config set <key> <value>');
	const spec = settingSpec(arg(ctx, 1, 'the setting'));
	const value = parseSettingValue(spec, arg(ctx, 2, 'the value'));
	const result = await (await ctx.client()).request('settings/set', { key: spec.key, value });
	return { value: result, human: `${spec.cliKey} = ${String(result.value)}` };
}

const config: Command = {
	usage: 'ev3 config list | get <key> | set <key> <value>',
	summary: 'Read and change the cockpit\'s settings.',
	async run(ctx) {
		const sub = ctx.args[0] ?? 'list';
		if (sub === 'list') { return list(ctx); }
		if (sub === 'get') { return get(ctx); }
		if (sub === 'set') { return set(ctx); }
		throw new UsageError(`ev3 config has no ${sub}. Usage: ${this.usage}`);
	},
};

export const configCommands: Readonly<Record<string, Command>> = { config };
