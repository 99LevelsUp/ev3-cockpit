/**
 * Generic configuration sanitizer helpers shared across config modules.
 */

export function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

export function sanitizeNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.floor(value));
}

export function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

export function sanitizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function sanitizeGlobList(value: unknown): string[] {
	const cleaned = sanitizeStringList(value)
		.map((entry) => entry.replace(/\\/g, '/'))
		.map((entry) => entry.replace(/^\.\//, ''));
	return [...new Set(cleaned)];
}
