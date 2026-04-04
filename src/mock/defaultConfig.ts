import { Transport } from '../contracts';
import { MockConfig } from './mockConfig';

/** Default mock configuration used when no external config is supplied. */
export const DEFAULT_MOCK_CONFIG: MockConfig = {
	transport: Transport.Mock,
	bricks: [
		{
			id: 'ev3-alpha',
			displayName: 'EV3 Alpha',
			firmwareVersion: 'v1.0.0-mock',
			batteryLevel: 85,
			batteryVoltage: 7.4,
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'sine', min: 0, max: 360, periodMs: 4000 } },
				{ port: 'B', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'triangle', min: -180, max: 180, periodMs: 3000 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'color-sensor', unit: 'rgb', dynamic: { kind: 'static', value: 3 } },
				{ port: '2', peripheralType: 'ultrasonic', unit: 'cm', dynamic: { kind: 'sine', min: 5, max: 255, periodMs: 6000 } },
			],
			buttons: { left: false, right: false, up: false, down: false, enter: false, back: false },
			filesystem: [
				{ path: '/home/robot/hello.py', content: 'print("Hello EV3!")' },
			],
		},
	],
};
