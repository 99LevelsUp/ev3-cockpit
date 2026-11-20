/**
 * `ev3 config list | get <key> | set <key> <value>`: the cockpit's settings, which the daemon holds.
 *
 * Keys are spelled with dashes (`access-mode`); the camel-case spelling works too. A dangerous
 * setting — access mode `full` — changes only after the person at the terminal types yes; without a
 * terminal, or with `--json`, it is refused and the person is pointed to a terminal or to
 * `EVƎ: Settings` in VS Code.
 */

import type { SettingValue } from '../../contract/models';
import { cliKey, keyFromCli } from '../../daemon/settingsStore';
import { ContractError } from '../../client/connection';
import { WireErrorCode } from '../../contract/errors';
import { ExitCode, UsageError, table } from '../output';
import { settingRefusal } from '../confirm';
import { Command, CommandContext, arg, atMost } from './context';

function find(settings: readonly SettingValue[], spelled: string): SettingValue {
	const key = keyFromCli(spelled);
	const setting = settings.find((s) => s.spec.key === key);
	if (!setting) { throw new ContractError(WireErrorCode.InvalidRequest, `There is no setting ${spelled}. ev3 config list shows them.`); }
	return setting;
}

function parse(setting: SettingValue, text: string): boolean | number | string {
	const { spec } = setting;
	if (spec.type === 'boolean') {
		if (text === 'true' || text === 'false') { return text === 'true'; }
		throw new UsageError(`${cliKey(spec.key)} is true or false.`);
	}
	if (spec.type === 'number') {
		const value = Number(text);
		if (text.trim() === '' || !Number.isFinite(value)) { throw new UsageError(`${cliKey(spec.key)} is a number.`); }
		return value;
	}
	return text;
}

async function list(ctx: CommandContext): Promise<{ value: unknown; human: string[] }> {
	atMost(ctx, 1, 'ev3 config list');
	const settings = await (await ctx.client()).request('settings/list', {});
	return {
		value: settings,
		human: table(settings.map((s) => [cliKey(s.spec.key), String(s.value), s.value === s.spec.default ? '' : `(default ${String(s.spec.default)})`])),
	};
}

async function get(ctx: CommandContext): Promise<{ value: unknown; human: string }> {
	atMost(ctx, 2, 'ev3 config get <key>');
	const settings = await (await ctx.client()).request('settings/list', {});
	const setting = find(settings, arg(ctx, 1, 'the setting'));
	return { value: setting, human: String(setting.value) };
}

async function set(ctx: CommandContext): Promise<{ value: unknown; human: string; exitCode?: number }> {
	atMost(ctx, 3, 'ev3 config set <key> <value>');
	const spelled = arg(ctx, 1, 'the setting');
	const text = arg(ctx, 2, 'the value');
	const client = await ctx.client();
	const setting = find(await client.request('settings/list', {}), spelled);
	const value = parse(setting, text);
	const key = setting.spec.key;
	let confirmedByPerson = false;
	if (setting.spec.dangerous && value !== setting.spec.default) {
		const command = `ev3 config set ${cliKey(key)} ${String(value)}`;
		const warning = key === 'accessMode' && value === 'full'
			? 'Switch access mode to full? Extensions using the cockpit may then change any file on the brick and run shell commands on it, until the cockpit daemon ends.'
			: `Change ${cliKey(key)} to ${String(value)}? It widens what extensions may do on a brick.`;
		if (!await ctx.confirmer.confirm({ text: warning, refusal: settingRefusal(command), command })) {
			return { value: { changed: false, setting }, human: `Not changed: ${cliKey(key)} stays ${String(setting.value)}.`, exitCode: ExitCode.Failure };
		}
		confirmedByPerson = true;
	}
	const result = await client.request('settings/set', { key, value, ...(confirmedByPerson ? { confirmedByPerson } : {}) });
	return { value: result, human: `${cliKey(key)} = ${String(result.value)}` };
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
