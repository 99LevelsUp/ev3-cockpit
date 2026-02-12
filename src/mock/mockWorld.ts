import type { MockWorldConfig } from './mockTypes';
import type { MockTransportResponder } from '../transport/mockTransportAdapter';
import { MockSensorState } from './state/mockSensorState';
import { MockMotorState } from './state/mockMotorState';
import { MockBrickState } from './state/mockBrickState';
import { MockFsTree } from './fs/mockFsTree';
import { createMockCommandResponder } from './mockCommandResponder';
import { wrapWithFaultInjector } from './faultInjector';
import { DEFAULT_MOCK_CONFIG } from './defaultSeed';

/**
 * MockWorld aggregates all mock state objects and provides
 * the `MockTransportResponder` function that plugs directly
 * into `MockTransportAdapter`.
 */
export class MockWorld {
	public readonly sensors: MockSensorState;
	public readonly motors: MockMotorState;
	public readonly brick: MockBrickState;
	public readonly fs: MockFsTree;

	private readonly config: MockWorldConfig;
	private responder: MockTransportResponder;
	private tickTimer: ReturnType<typeof setInterval> | null = null;

	private constructor(config: MockWorldConfig) {
		this.config = config;
		this.sensors = new MockSensorState(config.sensors);
		this.motors = new MockMotorState(config.motors);
		this.brick = new MockBrickState(config.brick);
		this.fs = new MockFsTree();
		this.fs.loadSeed(config.fsSeed);

		const inner = createMockCommandResponder({
			sensors: this.sensors,
			motors: this.motors,
			brick: this.brick,
			fs: this.fs
		});

		this.responder = this.hasFaults(config)
			? wrapWithFaultInjector(inner, config.fault)
			: inner;
	}

	/**
	 * Create a MockWorld from configuration.
	 * Uses `DEFAULT_MOCK_CONFIG` if no config provided.
	 */
	public static create(config?: MockWorldConfig): MockWorld {
		return new MockWorld(config ?? DEFAULT_MOCK_CONFIG);
	}

	/** Get the transport responder — pass this to `MockTransportAdapter`. */
	public getResponder(): MockTransportResponder {
		return this.responder;
	}

	/**
	 * Advance all simulations by deltaMs.
	 * Call this periodically (e.g., every 100ms) to update sensor generators,
	 * motor positions, and battery drain.
	 */
	public tick(deltaMs: number): void {
		this.sensors.tick(deltaMs);
		this.motors.tick(deltaMs);
		this.brick.tick(deltaMs);
	}

	/**
	 * Start automatic ticking at the given interval (ms).
	 * The timer calls `tick()` with the interval as delta.
	 */
	public startTicking(intervalMs = 100): void {
		this.stopTicking();
		this.tickTimer = setInterval(() => this.tick(intervalMs), intervalMs);
	}

	/** Stop automatic ticking. */
	public stopTicking(): void {
		if (this.tickTimer !== null) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	}

	/** Reset all state back to initial seed config. */
	public reset(): void {
		const fresh = new MockWorld(this.config);
		// Swap internal state references
		(this as { sensors: MockSensorState }).sensors = fresh.sensors;
		(this as { motors: MockMotorState }).motors = fresh.motors;
		(this as { brick: MockBrickState }).brick = fresh.brick;
		(this as { fs: MockFsTree }).fs = fresh.fs;
		this.responder = fresh.responder;
	}

	/** Dispose — stop timers. */
	public dispose(): void {
		this.stopTicking();
	}

	private hasFaults(config: MockWorldConfig): boolean {
		const f = config.fault;
		return f.errorRate > 0 || f.latencyMs > 0 || f.jitterMs > 0 || f.timeoutRate > 0;
	}
}
