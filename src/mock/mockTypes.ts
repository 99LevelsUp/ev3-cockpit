import type { SensorPort } from '../device/sensorTypes';
import type { MotorPort } from '../device/motorTypes';

// ---------------------------------------------------------------------------
// Value generators — define how mock sensor values evolve over time
// ---------------------------------------------------------------------------

export type ValueGeneratorKind = 'constant' | 'sine' | 'randomWalk' | 'step';

export interface ConstantGenerator {
	kind: 'constant';
	value: number;
}

export interface SineGenerator {
	kind: 'sine';
	min: number;
	max: number;
	periodMs: number;
}

export interface RandomWalkGenerator {
	kind: 'randomWalk';
	min: number;
	max: number;
	stepSize: number;
}

export interface StepGenerator {
	kind: 'step';
	values: number[];
	intervalMs: number;
}

export type ValueGenerator =
	| ConstantGenerator
	| SineGenerator
	| RandomWalkGenerator
	| StepGenerator;

// ---------------------------------------------------------------------------
// Sensor / Motor / Brick configuration
// ---------------------------------------------------------------------------

export interface MockSensorConfig {
	port: SensorPort;
	typeCode: number;
	mode: number;
	generator: ValueGenerator;
}

export interface MockMotorConfig {
	port: MotorPort;
	/** EV3 sensor type code for this motor (7 = large, 8 = medium). */
	typeCode: number;
	initialPosition: number;
}

export interface MockBrickConfig {
	name: string;
	firmwareVersion: string;
	batteryVoltage: number;
	batteryCurrent: number;
	/** Battery drain rate in V/hour — 0 = no drain. */
	batteryDrainRate: number;
	volume: number;
	sleepMinutes: number;
}

// ---------------------------------------------------------------------------
// Mock filesystem seed
// ---------------------------------------------------------------------------

export interface MockFsSeedDir {
	type: 'dir';
	name: string;
	children: MockFsSeedNode[];
}

export interface MockFsSeedFile {
	type: 'file';
	name: string;
	/** UTF-8 text content (mutually exclusive with base64). */
	text?: string;
	/** Base64-encoded binary content (mutually exclusive with text). */
	base64?: string;
}

export type MockFsSeedNode = MockFsSeedDir | MockFsSeedFile;

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

export interface MockFaultConfig {
	/** Probability (0.0–1.0) that a command returns an error reply. */
	errorRate: number;
	/** Extra latency added to each response (ms). */
	latencyMs: number;
	/** Random jitter added to latency (±jitterMs). */
	jitterMs: number;
	/** Probability (0.0–1.0) that a command times out (never responds). */
	timeoutRate: number;
}

// ---------------------------------------------------------------------------
// Top-level MockWorld configuration
// ---------------------------------------------------------------------------

export interface MockWorldConfig {
	sensors: MockSensorConfig[];
	motors: MockMotorConfig[];
	brick: MockBrickConfig;
	fsSeed: MockFsSeedNode[];
	fault: MockFaultConfig;
}
