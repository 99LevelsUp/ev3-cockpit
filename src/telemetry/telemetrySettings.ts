/**
 * The telemetry settings a user can change (owner decision D9, step-6 plan U6).
 *
 * The values live in one place, `package.json`'s `contributes.configuration`: VS Code shows them
 * in its settings editor and hands back the declared default for whatever the user left unset.
 * This module holds keys and the ranges that make a value usable, not values. Code that runs
 * outside VS Code — tests, the hardware harness — reads the same defaults from the manifest with
 * {@link telemetrySettingsFromPackage}.
 */

/** How the read model decides a value is stale and when it drops it. */
export interface TelemetrySettings {
	/** A value is stale once it is this many of its own reading intervals old. 1 or more. */
	readonly staleFactor: number;
	/** How long a stale value is kept, marked, before it is dropped, in milliseconds. 0 or more. */
	readonly staleTimeoutMs: number;
}

/** Each setting's key under `ev3-cockpit`, and the range a value must be in to be used. */
const SETTINGS: { readonly [K in keyof TelemetrySettings]: { readonly key: string; readonly min: number } } = {
	staleFactor: { key: 'telemetry.staleFactor', min: 1 },
	staleTimeoutMs: { key: 'telemetry.staleTimeoutMs', min: 0 },
};

/** The part of a VS Code configuration section this needs: `getConfiguration('ev3-cockpit')`. */
export interface SettingsSection {
	get<T>(key: string): T | undefined;
	inspect<T>(key: string): { readonly defaultValue?: T } | undefined;
}

/** Whether a value can be used for a setting, or why not. */
export function checkTelemetrySettings(settings: TelemetrySettings): void {
	for (const name of Object.keys(SETTINGS) as (keyof TelemetrySettings)[]) {
		const value = settings[name];
		if (!usable(value, SETTINGS[name].min)) {
			throw new RangeError(`Telemetry setting ${name} must be a number of at least ${SETTINGS[name].min}, not ${String(value)}.`);
		}
	}
}

/**
 * Reads the settings, taking the declared default for a value that cannot be used and saying so.
 * Throws when even the declared default is unusable: the manifest is then broken.
 */
export function readTelemetrySettings(section: SettingsSection, warn: (message: string) => void): TelemetrySettings {
	const read = (name: keyof TelemetrySettings): number => {
		const { key, min } = SETTINGS[name];
		const value = section.get<unknown>(key);
		if (usable(value, min)) { return value; }
		const fallback = section.inspect<unknown>(key)?.defaultValue;
		if (!usable(fallback, min)) {
			throw new RangeError(`Telemetry setting ${name} (ev3-cockpit.${key}) has no usable default in package.json.`);
		}
		warn(`Setting ev3-cockpit.${key} = ${String(value)} is not a number of at least ${min}; using its default, ${fallback}.`);
		return fallback;
	};
	return { staleFactor: read('staleFactor'), staleTimeoutMs: read('staleTimeoutMs') };
}

/** The declared defaults, read from a parsed `package.json`: for code that runs outside VS Code. */
export function telemetrySettingsFromPackage(manifest: unknown): TelemetrySettings {
	const properties = (manifest as {
		contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
	}).contributes?.configuration?.properties ?? {};
	const read = (name: keyof TelemetrySettings): number => {
		const { key, min } = SETTINGS[name];
		const value = properties[`ev3-cockpit.${key}`]?.default;
		if (!usable(value, min)) {
			throw new RangeError(`Telemetry setting ${name} (ev3-cockpit.${key}) has no usable default in package.json.`);
		}
		return value;
	};
	return { staleFactor: read('staleFactor'), staleTimeoutMs: read('staleTimeoutMs') };
}

function usable(value: unknown, min: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= min;
}
