import type {
	MockSensorConfig,
	ValueGenerator,
	ConstantGenerator,
	SineGenerator,
	RandomWalkGenerator,
	StepGenerator
} from '../mockTypes';
import type { SensorPort } from '../../device/sensorTypes';
import { EV3_SENSOR_TYPE } from '../../device/sensorTypes';

// ---------------------------------------------------------------------------
// Internal per-port state
// ---------------------------------------------------------------------------

interface PortState {
	typeCode: number;
	mode: number;
	generator: ValueGenerator;
	/** Current value produced by the generator. */
	currentValue: number;
	/** Elapsed simulation time for this port (ms). */
	elapsedMs: number;
	/** Step index for StepGenerator. */
	stepIndex: number;
}

function defaultPort(): PortState {
	return {
		typeCode: EV3_SENSOR_TYPE.EMPTY,
		mode: 0,
		generator: { kind: 'constant', value: 0 },
		currentValue: 0,
		elapsedMs: 0,
		stepIndex: 0
	};
}

// ---------------------------------------------------------------------------
// Value generation
// ---------------------------------------------------------------------------

function generateValue(gen: ValueGenerator, state: PortState): number {
	switch (gen.kind) {
		case 'constant':
			return (gen as ConstantGenerator).value;

		case 'sine': {
			const s = gen as SineGenerator;
			const amplitude = (s.max - s.min) / 2;
			const center = s.min + amplitude;
			return center + amplitude * Math.sin((2 * Math.PI * state.elapsedMs) / s.periodMs);
		}

		case 'randomWalk': {
			const r = gen as RandomWalkGenerator;
			const delta = (Math.random() * 2 - 1) * r.stepSize;
			return Math.max(r.min, Math.min(r.max, state.currentValue + delta));
		}

		case 'step': {
			const st = gen as StepGenerator;
			if (st.values.length === 0) { return 0; }
			return st.values[state.stepIndex % st.values.length];
		}
	}
}

// ---------------------------------------------------------------------------
// MockSensorState
// ---------------------------------------------------------------------------

export class MockSensorState {
	private readonly ports: [PortState, PortState, PortState, PortState];

	public constructor(configs: MockSensorConfig[]) {
		this.ports = [defaultPort(), defaultPort(), defaultPort(), defaultPort()];

		for (const cfg of configs) {
			const p = this.ports[cfg.port];
			p.typeCode = cfg.typeCode;
			p.mode = cfg.mode;
			p.generator = cfg.generator;
			p.currentValue = generateValue(cfg.generator, p);
		}
	}

	/** Advance simulation by deltaMs. Updates all generator values. */
	public tick(deltaMs: number): void {
		for (const p of this.ports) {
			if (p.typeCode === EV3_SENSOR_TYPE.EMPTY) { continue; }
			p.elapsedMs += deltaMs;

			if (p.generator.kind === 'step') {
				const st = p.generator as StepGenerator;
				if (st.intervalMs > 0 && st.values.length > 0) {
					p.stepIndex = Math.floor(p.elapsedMs / st.intervalMs) % st.values.length;
				}
			}

			p.currentValue = generateValue(p.generator, p);
		}
	}

	/** Read current sensor value for a port. */
	public readValue(port: SensorPort): number {
		return this.ports[port].currentValue;
	}

	/** Get type code for a port. */
	public getTypeCode(port: SensorPort): number {
		return this.ports[port].typeCode;
	}

	/** Get current mode for a port. */
	public getMode(port: SensorPort): number {
		return this.ports[port].mode;
	}

	/** Set mode for a port (as the real brick would after opINPUT_DEVICE SET_TYPEMODE). */
	public setMode(port: SensorPort, typeCode: number, mode: number): void {
		this.ports[port].typeCode = typeCode;
		this.ports[port].mode = mode;
	}
}
