/**
 * The daemon's settings: one JSON file per user, checked against the rules in the core.
 *
 * A dangerous setting changes only on a person's confirmation, and only from a VS Code or CLI
 * connection: an MCP server or an add-on is refused with the command a person can run. Access mode
 * `full` is never written to the file, so editing the file cannot turn it on; it lasts until the
 * daemon ends, and a restart hands it to the successor.
 */

import * as fs from 'node:fs';
import { ContractError, needsPerson } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import { type ClientKind, type SettingValue, isPersonClient } from '../contract/models';
import { SETTING_RULES, SettingRule, SettingValues, defaultSettings, problemWith, ruleFor } from '../core/settings/spec';
import { EventEmitter } from '../core/events';
import { writeJson } from './stateStore';

/** Who asks for a change. */
export interface ChangeRequest {
	readonly kind: ClientKind;
	readonly confirmedByPerson?: boolean;
}

/** The setting's key as `ev3 config` spells it: `accessMode` → `access-mode`. */
export function cliKey(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** The setting `ev3 config` means by a key spelled either way. */
export function keyFromCli(spelled: string): string {
	return SETTING_RULES.find((rule) => rule.key === spelled || cliKey(rule.key) === spelled)?.key ?? spelled;
}

export class SettingsStore {
	private values: Record<string, boolean | number | string> = { ...defaultSettings() };
	private readonly changed = new EventEmitter<{ readonly key: string; readonly value: boolean | number | string }>();
	readonly onChange = this.changed.event;

	constructor(private readonly file: string, private readonly warn: (message: string) => void = () => undefined) {}

	/** Reads the file; a value that is not usable is dropped with a warning, a dangerous unstored one ignored. */
	load(): void {
		let stored: Record<string, unknown> = {};
		try {
			stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.warn(`The settings file ${this.file} could not be read (${(error as Error).message}); using defaults.`);
			}
		}
		for (const [key, value] of Object.entries(stored)) {
			const rule = ruleFor(key);
			if (!rule) { this.warn(`The settings file names an unknown setting ${key}; ignored.`); continue; }
			if (rule.notStored) { this.warn(`The settings file sets ${key}, which is never read from the file; ignored.`); continue; }
			const problem = problemWith(rule, value);
			if (problem) { this.warn(`Setting ${key} = ${JSON.stringify(value)} ${problem}; using its default.`); continue; }
			this.values[key] = value as boolean | number | string;
		}
	}

	all(): SettingValues {
		return { ...this.values };
	}

	value(key: string): boolean | number | string | undefined {
		return this.values[key];
	}

	list(): SettingValue[] {
		return SETTING_RULES.map((rule) => this.entry(rule));
	}

	/** Changes a setting; throws a contract error naming what is wrong or who must confirm. */
	set(key: string, value: unknown, request: ChangeRequest): SettingValue {
		const rule = ruleFor(key);
		if (!rule) { throw new ContractError(WireErrorCode.InvalidRequest, `There is no setting ${key}.`); }
		const problem = problemWith(rule, value);
		if (problem) { throw new ContractError(WireErrorCode.InvalidRequest, `Setting ${key} ${problem}.`); }
		if (rule.dangerous && value !== rule.default) {
			const command = `ev3 config set ${cliKey(key)} ${String(value)}`;
			if (!isPersonClient(request.kind)) {
				throw needsPerson(`${key} can be changed only by a person: run ${command} in a terminal, or use EVƎ: Settings in VS Code.`, command);
			}
			if (!request.confirmedByPerson) {
				throw needsPerson(`Changing ${key} needs your confirmation: run ${command} in an interactive terminal, or use EVƎ: Settings in VS Code.`, command);
			}
		}
		this.values[key] = value as boolean | number | string;
		if (!rule.notStored) { this.save(); }
		this.changed.fire({ key, value: value as boolean | number | string });
		return this.entry(rule);
	}

	/** Restores values that are never stored, handed over by the daemon this one replaced. */
	restoreUnstored(values: SettingValues): void {
		for (const rule of SETTING_RULES.filter((r) => r.notStored)) {
			const value = values[rule.key];
			if (value !== undefined && problemWith(rule, value) === undefined) { this.values[rule.key] = value; }
		}
	}

	/** The values that are never stored, for a handover. */
	unstored(): SettingValues {
		return Object.fromEntries(SETTING_RULES.filter((r) => r.notStored).map((r) => [r.key, this.values[r.key]]));
	}

	dispose(): void {
		this.changed.dispose();
	}

	private entry(rule: SettingRule): SettingValue {
		return {
			spec: {
				key: rule.key,
				type: rule.type === 'integer' ? 'number' : rule.type,
				default: rule.default,
				...(rule.type === 'integer' ? { integer: true } : {}),
				...(rule.minimum !== undefined ? { minimum: rule.minimum } : {}),
				...(rule.exclusiveMinimum ? { exclusiveMinimum: true } : {}),
				...(rule.maximum !== undefined ? { maximum: rule.maximum } : {}),
				...(rule.enum ? { enum: rule.enum } : {}),
				description: rule.description,
				dangerous: rule.dangerous,
			},
			value: this.values[rule.key] ?? rule.default,
		};
	}

	private save(): void {
		const stored = Object.fromEntries(SETTING_RULES
			.filter((rule) => !rule.notStored && this.values[rule.key] !== rule.default)
			.map((rule) => [rule.key, this.values[rule.key]]));
		writeJson(this.file, stored);
	}
}
