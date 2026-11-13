/**
 * The telemetry settings a user can change (owner decision D9, step-6 plan U6 and U7).
 *
 * The values live in one place, `package.json`'s `contributes.configuration`: VS Code shows them
 * in its settings editor and hands back the declared default for whatever the user left unset.
 * This module holds keys and the ranges that make a value usable, not values. Code that runs
 * outside VS Code — tests, the hardware harness — reads the same defaults from the manifest with
 * {@link telemetrySettingsFromPackage} and {@link throttleSettingsFromPackage}.
 */

/** How the read model decides a value is stale and when it drops it. */
export interface TelemetrySettings {
	/** A value is stale once it is this many of its own reading intervals old. 1 or more. */
	readonly staleFactor: number;
	/** How long a stale value is kept, marked, before it is dropped, in milliseconds. 0 or more. */
	readonly staleTimeoutMs: number;
}

/** How a brick's telemetry tick slows down when its round trips grow, and comes back (step-6 U7). */
export interface ThrottleSettings {
	readonly enabled: boolean;
	/** Frames per window; the decision is taken at the end of each. A whole number, 5 or more. */
	readonly windowSize: number;
	/** The window's p95 may reach this many of the transport's measured round trips. 1 or more. */
	readonly tailFactor: number;
	/** How much one step slows the tick, or speeds it back. More than 1. */
	readonly step: number;
	/** The most the tick is slowed, as a multiple of the plan's. 1 or more. */
	readonly maxSlowdown: number;
	/** Windows in a row within the limit before the tick speeds up a step. A whole number, 1 or more. */
	readonly calmWindows: number;
}

/** How programs are followed and slow their brick's telemetry (step-6 U9, owner decision D11). */
export interface ProgramPresetSettings {
	/** While a program runs, the tick is at least this, in milliseconds; 0 turns it off. 0 or more. */
	readonly programRunningTickMs: number;
	/** How often a followed program's state is read, in milliseconds. 1 or more. */
	readonly programStatusIntervalMs: number;
}

/** The part of a VS Code configuration section this needs: `getConfiguration('ev3-cockpit')`. */
export interface SettingsSection {
	get<T>(key: string): T | undefined;
	inspect<T>(key: string): { readonly defaultValue?: T } | undefined;
}

/** What makes a value usable for one setting. */
interface Spec {
	readonly key: string;
	readonly kind: 'number' | 'integer' | 'boolean';
	/** The least usable value; with `above`, values must be greater than it. */
	readonly min?: number;
	readonly above?: boolean;
}

type Specs<T> = { readonly [K in keyof T]: Spec };

const STALE: Specs<TelemetrySettings> = {
	staleFactor: { key: 'telemetry.staleFactor', kind: 'number', min: 1 },
	staleTimeoutMs: { key: 'telemetry.staleTimeoutMs', kind: 'number', min: 0 },
};

const THROTTLE: Specs<ThrottleSettings> = {
	enabled: { key: 'telemetry.throttle.enabled', kind: 'boolean' },
	windowSize: { key: 'telemetry.throttle.windowSize', kind: 'integer', min: 5 },
	tailFactor: { key: 'telemetry.throttle.tailFactor', kind: 'number', min: 1 },
	step: { key: 'telemetry.throttle.step', kind: 'number', min: 1, above: true },
	maxSlowdown: { key: 'telemetry.throttle.maxSlowdown', kind: 'number', min: 1 },
	calmWindows: { key: 'telemetry.throttle.calmWindows', kind: 'integer', min: 1 },
};

const PRESET: Specs<ProgramPresetSettings> = {
	programRunningTickMs: { key: 'telemetry.programRunningTickMs', kind: 'number', min: 0 },
	programStatusIntervalMs: { key: 'programs.statusIntervalMs', kind: 'number', min: 1 },
};

/** Throws, naming the setting, for stale settings out of range. */
export function checkTelemetrySettings(settings: TelemetrySettings): void {
	check(STALE, settings);
}

/** Throws, naming the setting, for throttle settings out of range. */
export function checkThrottleSettings(settings: ThrottleSettings): void {
	check(THROTTLE, settings);
}

/**
 * Reads the stale settings, taking the declared default for a value that cannot be used and saying
 * so. Throws when even the declared default is unusable: the manifest is then broken.
 */
export function readTelemetrySettings(section: SettingsSection, warn: (message: string) => void): TelemetrySettings {
	return readAll(STALE, section, warn);
}

/** Reads the throttle settings, as {@link readTelemetrySettings} reads the stale ones. */
export function readThrottleSettings(section: SettingsSection, warn: (message: string) => void): ThrottleSettings {
	return readAll(THROTTLE, section, warn);
}

/** Throws, naming the setting, for a program preset out of range. */
export function checkProgramPresetSettings(settings: ProgramPresetSettings): void {
	check(PRESET, settings);
}

/** Reads the program preset, as {@link readTelemetrySettings} reads the stale settings. */
export function readProgramPresetSettings(section: SettingsSection, warn: (message: string) => void): ProgramPresetSettings {
	return readAll(PRESET, section, warn);
}

/** The declared program preset, read from a parsed `package.json`. */
export function programPresetSettingsFromPackage(manifest: unknown): ProgramPresetSettings {
	return fromPackage(PRESET, manifest);
}

/** The declared stale defaults, read from a parsed `package.json`: for code that runs outside VS Code. */
export function telemetrySettingsFromPackage(manifest: unknown): TelemetrySettings {
	return fromPackage(STALE, manifest);
}

/** The declared throttle defaults, read from a parsed `package.json`. */
export function throttleSettingsFromPackage(manifest: unknown): ThrottleSettings {
	return fromPackage(THROTTLE, manifest);
}

// ── Internal ────────────────────────────────────────────────────────

function check<T>(specs: Specs<T>, settings: T): void {
	for (const name of Object.keys(specs) as (keyof T & string)[]) {
		if (!usable(settings[name], specs[name])) {
			throw new RangeError(`Telemetry setting ${name} must be ${describe(specs[name])}, not ${String(settings[name])}.`);
		}
	}
}

function readAll<T>(specs: Specs<T>, section: SettingsSection, warn: (message: string) => void): T {
	const result: Record<string, unknown> = {};
	for (const name of Object.keys(specs) as (keyof T & string)[]) {
		const spec = specs[name];
		const value = section.get<unknown>(spec.key);
		if (usable(value, spec)) { result[name] = value; continue; }
		const fallback = section.inspect<unknown>(spec.key)?.defaultValue;
		if (!usable(fallback, spec)) {
			throw new RangeError(`Telemetry setting ${name} (ev3-cockpit.${spec.key}) has no usable default in package.json.`);
		}
		warn(`Setting ev3-cockpit.${spec.key} = ${String(value)} is not ${describe(spec)}; using its default, ${String(fallback)}.`);
		result[name] = fallback;
	}
	return result as T;
}

function fromPackage<T>(specs: Specs<T>, manifest: unknown): T {
	const properties = (manifest as {
		contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
	}).contributes?.configuration?.properties ?? {};
	const result: Record<string, unknown> = {};
	for (const name of Object.keys(specs) as (keyof T & string)[]) {
		const spec = specs[name];
		const value = properties[`ev3-cockpit.${spec.key}`]?.default;
		if (!usable(value, spec)) {
			throw new RangeError(`Telemetry setting ${name} (ev3-cockpit.${spec.key}) has no usable default in package.json.`);
		}
		result[name] = value;
	}
	return result as T;
}

function usable(value: unknown, spec: Spec): boolean {
	if (spec.kind === 'boolean') { return typeof value === 'boolean'; }
	if (typeof value !== 'number' || !Number.isFinite(value)) { return false; }
	if (spec.kind === 'integer' && !Number.isInteger(value)) { return false; }
	if (spec.min === undefined) { return true; }
	return spec.above ? value > spec.min : value >= spec.min;
}

function describe(spec: Spec): string {
	if (spec.kind === 'boolean') { return 'true or false'; }
	const what = spec.kind === 'integer' ? 'a whole number' : 'a number';
	if (spec.min === undefined) { return what; }
	return `${what} ${spec.above ? 'greater than' : 'of at least'} ${spec.min}`;
}
