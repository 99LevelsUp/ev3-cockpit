import { Transport } from '../contracts';

// ── Value dynamics ──────────────────────────────────────────────────

export interface NoneDynamic {
	readonly kind: 'none';
}

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

export type ValueDynamic = NoneDynamic | StaticDynamic | SineDynamic | TriangleDynamic | SquareDynamic;

/** All valid dynamic kind values, derived from the ValueDynamic union. */
export const VALID_DYNAMIC_KINDS: ReadonlyArray<ValueDynamic['kind']> = ['none', 'static', 'sine', 'triangle', 'square'];

// ── Battery configuration ───────────────────────────────────────────

export interface MockBatteryConfig {
	/** Battery level in percent (0–100). */
	readonly level: number;
	/** Battery voltage in volts. */
	readonly voltage?: number;
}

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

// ── Single brick configuration ──────────────────────────────────────

export interface MockBrickConfig {
	readonly id: string;
	readonly displayName: string;
	readonly firmwareVersion?: string;
	readonly battery: MockBatteryConfig;
	readonly motorPorts: MockPortConfig[];
	readonly sensorPorts: MockPortConfig[];
	/** ID of the master brick; undefined = standalone / master. */
	readonly parentId?: string;
	readonly error?: MockErrorConfig;
	readonly loss?: MockLossConfig;
	readonly filesystem?: MockFileEntry[];
	/** Names of the computers and bricks this brick remembers as Bluetooth peers, in list order. */
	readonly bluetoothPeers?: string[];
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
	// A workspace writes this file by hand (1.6.10): what the provider relies on across bricks too.
	const bricks = obj.bricks as { id: string; parentId?: string }[];
	const ids = new Set<string>();
	for (const brick of bricks) {
		if (ids.has(brick.id)) { throw new Error(`Brick id "${brick.id}" appears twice`); }
		ids.add(brick.id);
	}
	for (const brick of bricks) {
		if (brick.parentId !== undefined && (brick.parentId === brick.id || !ids.has(brick.parentId))) {
			throw new Error(`Brick "${brick.id}" parentId must name another brick of this config`);
		}
	}
	return raw as MockConfig;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRate = (value: unknown): boolean => isNumber(value) && value >= 0 && value <= 1;

function validateOptionalSections(b: Record<string, unknown>): void {
	const at = `Brick "${String(b.id)}"`;
	if (b.firmwareVersion !== undefined && typeof b.firmwareVersion !== 'string') {
		throw new Error(`${at} firmwareVersion must be a string`);
	}
	const battery = b.battery as Record<string, unknown>;
	if (battery.voltage !== undefined && !isNumber(battery.voltage)) {
		throw new Error(`${at} battery.voltage must be a number`);
	}
	if (b.parentId !== undefined && (typeof b.parentId !== 'string' || b.parentId.length === 0)) {
		throw new Error(`${at} parentId must be a non-empty string`);
	}
	if (b.error !== undefined) {
		const e = b.error as Record<string, unknown> | null;
		if (!e || typeof e !== 'object' || !isRate(e.connectFailRate) || !isRate(e.sendFailRate)) {
			throw new Error(`${at} error must hold connectFailRate and sendFailRate between 0 and 1`);
		}
	}
	if (b.loss !== undefined) {
		const l = b.loss as Record<string, unknown> | null;
		// visibleMs 0 pins a brick hidden; the cycle they make must not be empty (the provider takes a modulo of it).
		if (!l || typeof l !== 'object' || typeof l.enabled !== 'boolean'
			|| !isNumber(l.visibleMs) || l.visibleMs < 0 || !isNumber(l.hiddenMs) || l.hiddenMs < 0
			|| l.visibleMs + l.hiddenMs <= 0) {
			throw new Error(`${at} loss must hold enabled, and visibleMs and hiddenMs of 0 or more, not both 0`);
		}
	}
	if (b.filesystem !== undefined) {
		if (!Array.isArray(b.filesystem) || !b.filesystem.every((f) => f && typeof f === 'object'
			&& typeof (f as Record<string, unknown>).path === 'string' && typeof (f as Record<string, unknown>).content === 'string')) {
			throw new Error(`${at} filesystem must be a list of { path, content } strings`);
		}
	}
	if (b.bluetoothPeers !== undefined) {
		if (!Array.isArray(b.bluetoothPeers) || !b.bluetoothPeers.every((p) => typeof p === 'string')) {
			throw new Error(`${at} bluetoothPeers must be a list of names`);
		}
	}
}

function validateDynamic(d: Record<string, unknown>, at: string): void {
	switch (d.kind) {
	case 'static':
		if (!isNumber(d.value) && typeof d.value !== 'string') { throw new Error(`${at} static dynamic needs a number or string value`); }
		return;
	case 'sine':
	case 'triangle':
		if (!isNumber(d.min) || !isNumber(d.max) || !isNumber(d.periodMs) || d.periodMs <= 0) {
			throw new Error(`${at} ${String(d.kind)} dynamic needs min, max and a positive periodMs`);
		}
		return;
	case 'square':
		if (!isNumber(d.low) || !isNumber(d.high) || !isNumber(d.periodMs) || d.periodMs <= 0) {
			throw new Error(`${at} square dynamic needs low, high and a positive periodMs`);
		}
		return;
	default:
		return;
	}
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
	if (!b.battery || typeof b.battery !== 'object') {
		throw new Error('Brick battery must be an object');
	}
	const battery = b.battery as Record<string, unknown>;
	if (typeof battery.level !== 'number' || battery.level < 0 || battery.level > 100) {
		throw new Error('Brick battery.level must be a number between 0 and 100');
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
	validateOptionalSections(b);
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
	const at = `Port ${p.port}:`;
	if (p.peripheralType !== undefined && typeof p.peripheralType !== 'string') { throw new Error(`${at} peripheralType must be a string`); }
	if (p.unit !== undefined && typeof p.unit !== 'string') { throw new Error(`${at} unit must be a string`); }
	validateDynamic(d, at);
}
