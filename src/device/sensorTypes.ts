/**
 * EV3 sensor port index (0-based internally, shown as 1-4 to users).
 */
export type SensorPort = 0 | 1 | 2 | 3;

export const SENSOR_PORTS: readonly SensorPort[] = [0, 1, 2, 3] as const;

export function isSensorPort(value: number): value is SensorPort {
	return value >= 0 && value <= 3 && Number.isInteger(value);
}

export function sensorPortLabel(port: SensorPort): string {
	return `Port ${port + 1}`;
}

/**
 * EV3 device type codes returned by opINPUT_DEVICE(GET_TYPEMODE).
 * Subset of the most common types from the EV3 firmware source.
 */
export const EV3_SENSOR_TYPE = {
	NONE: 0,
	NXT_TOUCH: 1,
	NXT_LIGHT: 2,
	NXT_SOUND: 3,
	NXT_COLOR: 4,
	NXT_ULTRASONIC: 5,
	NXT_TEMPERATURE: 6,
	EV3_LARGE_MOTOR: 7,
	EV3_MEDIUM_MOTOR: 8,
	EV3_TOUCH: 16,
	EV3_COLOR: 29,
	EV3_ULTRASONIC: 30,
	EV3_GYRO: 32,
	EV3_IR: 33,
	UNKNOWN: 125,
	INITIALIZING: 126,
	EMPTY: 127,
	ERROR: 128
} as const;

export type Ev3SensorTypeCode = (typeof EV3_SENSOR_TYPE)[keyof typeof EV3_SENSOR_TYPE];

export function sensorTypeName(typeCode: number): string {
	for (const [name, code] of Object.entries(EV3_SENSOR_TYPE)) {
		if (code === typeCode) {
			return name.replace(/_/g, ' ');
		}
	}
	return `Unknown (${typeCode})`;
}

/**
 * Whether a type code represents a connected sensor (not empty/error/initializing).
 */
export function isSensorConnected(typeCode: number): boolean {
	return typeCode !== EV3_SENSOR_TYPE.NONE
		&& typeCode !== EV3_SENSOR_TYPE.EMPTY
		&& typeCode !== EV3_SENSOR_TYPE.INITIALIZING
		&& typeCode !== EV3_SENSOR_TYPE.ERROR
		&& typeCode !== EV3_SENSOR_TYPE.UNKNOWN;
}

/**
 * Sensor mode — 0-based index. Meaning depends on sensor type.
 */
export type SensorMode = number;

/**
 * Result of detecting what's connected to a port.
 */
export interface SensorInfo {
	port: SensorPort;
	typeCode: number;
	mode: SensorMode;
	connected: boolean;
	typeName: string;
}

/**
 * A single reading from a sensor port.
 */
export interface SensorReading {
	port: SensorPort;
	typeCode: number;
	mode: SensorMode;
	value: number;
	timestampMs: number;
}
