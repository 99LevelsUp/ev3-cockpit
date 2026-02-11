/**
 * EV3 motor port identifier (A..D).
 */
export type MotorPort = 'A' | 'B' | 'C' | 'D';

export const MOTOR_PORTS: readonly MotorPort[] = ['A', 'B', 'C', 'D'] as const;

/**
 * Port bitmask for EV3 output commands.
 * A=0x01, B=0x02, C=0x04, D=0x08, ALL=0x0F.
 */
export const MOTOR_PORT_MASK: Record<MotorPort | 'ALL', number> = {
	A: 0x01,
	B: 0x02,
	C: 0x04,
	D: 0x08,
	ALL: 0x0f
} as const;

export function isMotorPort(value: string): value is MotorPort {
	return value === 'A' || value === 'B' || value === 'C' || value === 'D';
}

/**
 * Motor port index (0-based, matching firmware layer convention).
 */
export function motorPortIndex(port: MotorPort): number {
	return MOTOR_PORTS.indexOf(port);
}

export type MotorStopMode = 'brake' | 'coast';

/**
 * Result of reading the tacho position counter.
 */
export interface TachoReading {
	port: MotorPort;
	position: number;
	timestampMs: number;
}

/**
 * Motor state snapshot for UI display.
 */
export interface MotorState {
	port: MotorPort;
	speed: number;
	running: boolean;
}
