import type {
	BrickFilesystemSnapshot,
	BrickIdentity,
	BrickPower,
	BrickStorage,
	BrickUiSettings,
	BrickVersions
} from './brickDefinition';
import type { ButtonState } from './buttonService';
import type { LedPattern } from './ledService';
import type { MotorState } from './motorTypes';
import type { SensorInfo, SensorReading } from './sensorTypes';

export interface LayeredSensorReading {
	layer: number;
	port: number;
	typeCode: number;
	mode: number;
	value: number;
	timestampMs: number;
}

export interface BrickTelemetrySnapshot {
	brickId: string;
	deviceTypes?: number[];
	deviceTypesChanged?: number;
	layeredInputs?: Array<{ layer: number; port: number; typeCode: number; mode: number }>;
	sensors?: SensorInfo[];
	sensorReadings?: SensorReading[];
	layeredSensorReadings?: LayeredSensorReading[];
	motors?: MotorState[];
	button?: ButtonState;
	led?: LedPattern;
	identity?: BrickIdentity;
	ui?: BrickUiSettings;
	power?: BrickPower;
	storage?: BrickStorage;
	versions?: BrickVersions;
	filesystem?: BrickFilesystemSnapshot;
	updatedAtIso?: string;
}

function shallowEqualArray<T>(left: T[] | undefined, right: T[] | undefined): boolean {
	if (left === right) {
		return true;
	}
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) {
			return false;
		}
	}
	return true;
}

function shallowEqualObject(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
		return false;
	}
	const leftKeys = Object.keys(left as Record<string, unknown>);
	const rightKeys = Object.keys(right as Record<string, unknown>);
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	for (const key of leftKeys) {
		if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]) {
			return false;
		}
	}
	return true;
}

function shallowEqualArrayObjects<T extends object>(left?: T[], right?: T[]): boolean {
	if (left === right) {
		return true;
	}
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (!shallowEqualObject(left[i] as Record<string, unknown>, right[i] as Record<string, unknown>)) {
			return false;
		}
	}
	return true;
}

export class BrickTelemetryStore {
	private readonly snapshots = new Map<string, BrickTelemetrySnapshot>();

	public getSnapshot(brickId: string): BrickTelemetrySnapshot | undefined {
		return this.snapshots.get(brickId);
	}

	public getSensorInfo(brickId: string): SensorInfo[] | undefined {
		return this.snapshots.get(brickId)?.sensors;
	}

	public getMotorInfo(brickId: string): MotorState[] | undefined {
		return this.snapshots.get(brickId)?.motors;
	}

	public getButtonState(brickId: string): ButtonState | undefined {
		return this.snapshots.get(brickId)?.button;
	}

	public getLedPattern(brickId: string): LedPattern | undefined {
		return this.snapshots.get(brickId)?.led;
	}

	public update(
		brickId: string,
		patch: Omit<BrickTelemetrySnapshot, 'brickId' | 'updatedAtIso'>
	): boolean {
		const existing = this.snapshots.get(brickId);
		const next: BrickTelemetrySnapshot = {
			brickId,
			...existing,
			...patch,
			updatedAtIso: new Date().toISOString()
		};

		let changed = false;
		if (!existing) {
			changed = true;
		} else {
			changed ||= !shallowEqualArray(existing.deviceTypes, next.deviceTypes);
			changed ||= existing.deviceTypesChanged !== next.deviceTypesChanged;
			changed ||= !shallowEqualArrayObjects(existing.layeredInputs, next.layeredInputs);
			changed ||= !shallowEqualArrayObjects(existing.sensors, next.sensors);
			changed ||= !shallowEqualArrayObjects(existing.sensorReadings, next.sensorReadings);
			changed ||= !shallowEqualArrayObjects(existing.layeredSensorReadings, next.layeredSensorReadings);
			changed ||= !shallowEqualArrayObjects(existing.motors, next.motors);
			changed ||= !shallowEqualObject(existing.button, next.button);
			changed ||= existing.led !== next.led;
			changed ||= !shallowEqualObject(existing.identity, next.identity);
			changed ||= !shallowEqualObject(existing.ui, next.ui);
			changed ||= !shallowEqualObject(existing.power, next.power);
			changed ||= !shallowEqualObject(existing.storage, next.storage);
			changed ||= !shallowEqualObject(existing.versions, next.versions);
			changed ||= !shallowEqualObject(existing.filesystem, next.filesystem);
		}

		if (changed) {
			this.snapshots.set(brickId, next);
		}
		return changed;
	}

	public pruneMissing(validBrickIds: Set<string>): void {
		for (const brickId of this.snapshots.keys()) {
			if (!validBrickIds.has(brickId)) {
				this.snapshots.delete(brickId);
			}
		}
	}
}
