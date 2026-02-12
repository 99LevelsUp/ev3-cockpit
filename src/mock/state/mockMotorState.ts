import type { MockMotorConfig } from '../mockTypes';
import type { MotorPort } from '../../device/motorTypes';
import { EV3_SENSOR_TYPE } from '../../device/sensorTypes';

// ---------------------------------------------------------------------------
// Internal per-port state
// ---------------------------------------------------------------------------

interface PortState {
	typeCode: number;
	speed: number;
	running: boolean;
	tachoPosition: number;
}

function defaultPort(): PortState {
	return { typeCode: EV3_SENSOR_TYPE.EMPTY, speed: 0, running: false, tachoPosition: 0 };
}

const PORT_INDEX: Record<MotorPort, number> = { A: 0, B: 1, C: 2, D: 3 };

// ---------------------------------------------------------------------------
// MockMotorState
// ---------------------------------------------------------------------------

export class MockMotorState {
	private readonly ports: [PortState, PortState, PortState, PortState];

	public constructor(configs: MockMotorConfig[]) {
		this.ports = [defaultPort(), defaultPort(), defaultPort(), defaultPort()];

		for (const cfg of configs) {
			const p = this.ports[PORT_INDEX[cfg.port]];
			p.typeCode = cfg.typeCode;
			p.tachoPosition = cfg.initialPosition;
		}
	}

	/**
	 * Advance simulation by deltaMs.
	 * Running motors accumulate tacho position based on speed.
	 * Speed is in %, tacho in degrees: at 100 % → 1000 °/s (EV3 large motor spec).
	 */
	public tick(deltaMs: number): void {
		const degreesPerSecondAt100 = 1000;
		for (const p of this.ports) {
			if (!p.running || p.speed === 0) { continue; }
			const degreesPerMs = (p.speed / 100) * degreesPerSecondAt100 / 1000;
			p.tachoPosition += degreesPerMs * deltaMs;
		}
	}

	/** Set motor speed (-100..100). Does NOT start the motor. */
	public setSpeed(port: MotorPort, speed: number): void {
		this.ports[PORT_INDEX[port]].speed = Math.max(-100, Math.min(100, speed));
	}

	/** Start motor (must have speed set beforehand). */
	public start(port: MotorPort): void {
		this.ports[PORT_INDEX[port]].running = true;
	}

	/** Stop motor. If brake=true, speed is zeroed. */
	public stop(port: MotorPort, brake: boolean): void {
		const p = this.ports[PORT_INDEX[port]];
		p.running = false;
		if (brake) { p.speed = 0; }
	}

	/** Reset tacho counter to 0. */
	public resetTacho(port: MotorPort): void {
		this.ports[PORT_INDEX[port]].tachoPosition = 0;
	}

	/** Read tacho position (degrees, integer). */
	public readTacho(port: MotorPort): number {
		return Math.round(this.ports[PORT_INDEX[port]].tachoPosition);
	}

	/** Get current speed setting. */
	public getSpeed(port: MotorPort): number {
		return this.ports[PORT_INDEX[port]].speed;
	}

	/** Is the motor currently running? */
	public isRunning(port: MotorPort): boolean {
		return this.ports[PORT_INDEX[port]].running;
	}

	/** Get type code for a motor port. */
	public getTypeCode(port: MotorPort): number {
		return this.ports[PORT_INDEX[port]].typeCode;
	}
}
