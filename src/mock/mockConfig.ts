import { Transport } from '../contracts';

// ── Value dynamics ──────────────────────────────────────────────────

export interface StaticDynamic {
	readonly kind: 'static';
	readonly value: number | string;
}

export interface SineDynamic {
	readonly kind: 'sine';
	readonly min: number;
	readonly max: number;
	/** Period in milliseconds. */
	readonly periodMs: number;
}

export interface TriangleDynamic {
	readonly kind: 'triangle';
	readonly min: number;
	readonly max: number;
	readonly periodMs: number;
}

export interface SquareDynamic {
	readonly kind: 'square';
	readonly low: number;
	readonly high: number;
	readonly periodMs: number;
}

export type ValueDynamic = StaticDynamic | SineDynamic | TriangleDynamic | SquareDynamic;

/** All valid dynamic kind values, derived from the ValueDynamic union. */
export const VALID_DYNAMIC_KINDS: ReadonlyArray<ValueDynamic['kind']> = ['static', 'sine', 'triangle', 'square'];

// ── Port configuration ──────────────────────────────────────────────

export interface MockPortConfig {
	readonly port: string;
	readonly peripheralType?: string;
	readonly unit?: string;
	readonly dynamic: ValueDynamic;
}

// ── Error simulation ────────────────────────────────────────────────

export interface MockErrorConfig {
	/** Probability (0–1) that connect() will throw. */
	readonly connectFailRate: number;
	/** Probability (0–1) that send() will throw. */
	readonly sendFailRate: number;
}

// ── Loss / recovery simulation ──────────────────────────────────────

export interface MockLossConfig {
	/** Whether to simulate periodic disappearance from discovery. */
	readonly enabled: boolean;
	/** How long the brick stays visible (ms). */
	readonly visibleMs: number;
	/** How long the brick stays hidden (ms). */
	readonly hiddenMs: number;
}

// ── Filesystem ──────────────────────────────────────────────────────

export interface MockFileEntry {
	readonly path: string;
	readonly content: string;
}

// ── Button state ────────────────────────────────────────────────────

export interface MockButtonConfig {
	readonly [button: string]: boolean;
}

// ── Single brick configuration ──────────────────────────────────────

export interface MockBrickConfig {
	readonly id: string;
	readonly displayName: string;
	readonly firmwareVersion?: string;
	readonly batteryLevel: number;
	readonly batteryVoltage?: number;
	readonly motorPorts: MockPortConfig[];
	readonly sensorPorts: MockPortConfig[];
	readonly buttons?: MockButtonConfig;
	readonly error?: MockErrorConfig;
	readonly loss?: MockLossConfig;
	readonly filesystem?: MockFileEntry[];
}

// ── Top-level mock configuration ────────────────────────────────────

export interface MockConfig {
	readonly transport: Transport.Mock;
	readonly bricks: MockBrickConfig[];
}

// ── Validation ──────────────────────────────────────────────────────

export function validateMockConfig(raw: unknown): MockConfig {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Mock config must be a non-null object');
	}
	const obj = raw as Record<string, unknown>;
	if (obj.transport !== Transport.Mock) {
		throw new Error(`Mock config transport must be "${Transport.Mock}"`);
	}
	if (!Array.isArray(obj.bricks) || obj.bricks.length === 0) {
		throw new Error('Mock config must contain at least one brick');
	}
	for (const brick of obj.bricks as unknown[]) {
		validateBrickConfig(brick);
	}
	return raw as MockConfig;
}

function validateBrickConfig(raw: unknown): void {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Each brick must be a non-null object');
	}
	const b = raw as Record<string, unknown>;
	if (typeof b.id !== 'string' || b.id.length === 0) {
		throw new Error('Brick id must be a non-empty string');
	}
	if (typeof b.displayName !== 'string' || b.displayName.length === 0) {
		throw new Error('Brick displayName must be a non-empty string');
	}
	if (typeof b.batteryLevel !== 'number' || b.batteryLevel < 0 || b.batteryLevel > 100) {
		throw new Error('Brick batteryLevel must be a number between 0 and 100');
	}
	if (!Array.isArray(b.motorPorts)) {
		throw new Error('Brick motorPorts must be an array');
	}
	if (!Array.isArray(b.sensorPorts)) {
		throw new Error('Brick sensorPorts must be an array');
	}
	for (const port of [...b.motorPorts as unknown[], ...b.sensorPorts as unknown[]]) {
		validatePortConfig(port);
	}
}

function validatePortConfig(raw: unknown): void {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Port config must be a non-null object');
	}
	const p = raw as Record<string, unknown>;
	if (typeof p.port !== 'string' || p.port.length === 0) {
		throw new Error('Port name must be a non-empty string');
	}
	if (!p.dynamic || typeof p.dynamic !== 'object') {
		throw new Error('Port dynamic must be an object');
	}
	const d = p.dynamic as Record<string, unknown>;
	if (!(VALID_DYNAMIC_KINDS as readonly string[]).includes(d.kind as string)) {
		throw new Error(`Unknown dynamic kind: ${String(d.kind)}`);
	}
}
