/**
 * `EVƎ: Settings` (R25): the daemon's settings, read and changed from VS Code. The cockpit's
 * settings live in the daemon now, shared by every client, not in VS Code's settings.
 *
 * Every key is listed with its value. A change to a dangerous setting away from its default —
 * access mode `full` — asks the person in a modal dialog first; declining changes nothing.
 *
 * Free of `vscode`: the command hands it pickers, an input box and the dialog.
 */

import type { SettingValue } from '../../contract/models';

export interface SettingsUi {
	pick<T extends { readonly label: string }>(items: readonly T[], options: { readonly title: string; readonly placeHolder: string }): PromiseLike<T | undefined>;
	input(options: { readonly title: string; readonly value: string; readonly prompt: string; readonly validate: (value: string) => string | undefined }): PromiseLike<string | undefined>;
	/** A modal question with one action; true only when that action was chosen. */
	confirm(message: string, detail: string, action: string): PromiseLike<boolean>;
	showInfo(message: string): void;
	showError(message: string): void;
}

export interface SettingsClient {
	settings(): readonly SettingValue[];
	request(method: 'settings/set', params: { key: string; value: boolean | number | string; confirmedByPerson?: boolean }): Promise<SettingValue>;
}

export const FULL_ACTION = 'Allow';

export interface SettingRow {
	readonly label: string;
	readonly description: string;
	readonly detail: string;
	readonly setting: SettingValue;
}

/** One row per setting, its value beside it and a mark where it is not the default. */
export function settingRows(settings: readonly SettingValue[]): SettingRow[] {
	return [...settings]
		.sort((a, b) => a.spec.key.localeCompare(b.spec.key))
		.map((setting) => ({
			label: setting.spec.key,
			description: `${String(setting.value)}${setting.value === setting.spec.default ? '' : ' (changed)'}`,
			detail: setting.spec.description,
			setting,
		}));
}

/** What a typed value means for a setting, or why it cannot be one. */
export function parseSettingValue(setting: SettingValue, text: string): { value: number | string } | { problem: string } {
	const { spec } = setting;
	if (spec.type === 'number') {
		const value = Number(text.trim());
		if (text.trim() === '' || !Number.isFinite(value)) { return { problem: 'Type a number.' }; }
		if (spec.minimum !== undefined && value < spec.minimum) { return { problem: `At least ${spec.minimum}.` }; }
		if (spec.maximum !== undefined && value > spec.maximum) { return { problem: `At most ${spec.maximum}.` }; }
		return { value };
	}
	return { value: text };
}

/** Picks a setting, asks for its new value, confirms a dangerous change, and sets it. */
export async function editSettings(client: SettingsClient, ui: SettingsUi): Promise<void> {
	const row = await ui.pick(settingRows(client.settings()), { title: 'EVƎ: Settings', placeHolder: 'Pick a setting to change' });
	if (!row) { return; }
	const { setting } = row;
	const { spec } = setting;
	let value: boolean | number | string;
	if (spec.type === 'boolean' || spec.enum) {
		const options = spec.type === 'boolean' ? ['true', 'false'] : [...spec.enum!];
		const picked = await ui.pick(options.map((option) => ({
			label: option, description: option === String(setting.value) ? 'current' : option === String(spec.default) ? 'default' : '',
		})), { title: spec.key, placeHolder: spec.description });
		if (!picked) { return; }
		value = spec.type === 'boolean' ? picked.label === 'true' : picked.label;
	} else {
		const typed = await ui.input({
			title: spec.key, value: String(setting.value), prompt: spec.description,
			validate: (text) => { const parsed = parseSettingValue(setting, text); return 'problem' in parsed ? parsed.problem : undefined; },
		});
		if (typed === undefined) { return; }
		const parsed = parseSettingValue(setting, typed);
		if ('problem' in parsed) { ui.showError(`EVƎ Cockpit: ${spec.key} — ${parsed.problem}`); return; }
		value = parsed.value;
	}
	if (value === setting.value) { return; }

	let confirmedByPerson = false;
	if (spec.dangerous && value !== spec.default) {
		confirmedByPerson = await ui.confirm(
			`Set ${spec.key} to ${String(value)}?`,
			spec.key === 'accessMode'
				? 'Full access lets every program connected to the cockpit — VS Code, the ev3 command, add-ons and AI agents — write and delete anywhere on the brick, its system files included. It lasts until the cockpit daemon ends.'
				: spec.description,
			FULL_ACTION);
		if (!confirmedByPerson) { return; }
	}
	try {
		await client.request('settings/set', { key: spec.key, value, ...(confirmedByPerson ? { confirmedByPerson } : {}) });
		ui.showInfo(`EVƎ Cockpit: ${spec.key} is ${String(value)}.`);
	} catch (error) {
		ui.showError(`EVƎ Cockpit: could not set ${spec.key} — ${error instanceof Error ? error.message : String(error)}`);
	}
}
