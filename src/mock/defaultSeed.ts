import type { MockWorldConfig } from './mockTypes';
import { EV3_SENSOR_TYPE } from '../device/sensorTypes';

/**
 * Default mock world configuration used when no seed file is provided.
 *
 * Sets up:
 * - Port 1: EV3 Touch sensor (constant 0 = not pressed)
 * - Port 3: EV3 Color sensor (sine 0–7, period 5 s)
 * - Motor A: Large motor, position 0
 * - Motor B: Medium motor, position 0
 * - Standard brick settings (battery 7.5 V, volume 80 %)
 * - Basic project directory in `/home/root/lms2012/prjs/`
 * - No faults injected
 */
export const DEFAULT_MOCK_CONFIG: MockWorldConfig = {
	sensors: [
		{
			port: 0,
			typeCode: EV3_SENSOR_TYPE.EV3_TOUCH,
			mode: 0,
			generator: { kind: 'constant', value: 0 }
		},
		{
			port: 2,
			typeCode: EV3_SENSOR_TYPE.EV3_COLOR,
			mode: 0,
			generator: { kind: 'sine', min: 0, max: 7, periodMs: 5000 }
		}
	],
	motors: [
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 },
		{ port: 'B', typeCode: EV3_SENSOR_TYPE.EV3_MEDIUM_MOTOR, initialPosition: 0 }
	],
	brick: {
		name: 'MockEV3',
		firmwareVersion: 'V1.10E',
		batteryVoltage: 7.5,
		batteryCurrent: 0.15,
		batteryDrainRate: 0,
		volume: 80,
		sleepMinutes: 30
	},
	fsSeed: [
		{
			type: 'dir',
			name: 'home',
			children: [
				{
					type: 'dir',
					name: 'root',
					children: [
						{
							type: 'dir',
							name: 'lms2012',
							children: [
								{
									type: 'dir',
									name: 'prjs',
									children: [
										{
											type: 'dir',
											name: 'MyProject',
											children: [
												{
													type: 'file',
													name: 'main.rbf',
													base64: 'TEVOAA=='
												}
											]
										}
									]
								}
							]
						}
					]
				}
			]
		}
	],
	fault: {
		errorRate: 0,
		latencyMs: 0,
		jitterMs: 0,
		timeoutRate: 0
	}
};
