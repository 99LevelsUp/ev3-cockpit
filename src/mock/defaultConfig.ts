import { Transport } from '../contracts';
import { MockConfig } from './mockConfig';

/** Default mock configuration used when no external config is supplied. */
export const DEFAULT_MOCK_CONFIG: MockConfig = {
	transport: Transport.Mock,
	bricks: [

		// ── Marvin ─────────────────────────────────────────────────────
		// Hitchhiker's Guide to the Galaxy. Paranoid Android. Brain the size of a planet.
		{
			id: 'marvin',
			displayName: 'Marvin',
			firmwareVersion: 'V1.10E',
			battery: { level: 3, voltage: 6.1 },
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor',  unit: 'deg', dynamic: { kind: 'triangle', min: -10, max: 10,  periodMs: 8000 } },
				{ port: 'B', peripheralType: 'large-motor',  unit: 'deg', dynamic: { kind: 'triangle', min: -10, max: 10,  periodMs: 9000 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'ultrasonic-sensor', unit: 'cm', dynamic: { kind: 'static', value: 0  } },
				{ port: '2', peripheralType: 'touch-sensor',      unit: '',   dynamic: { kind: 'static', value: 0  } },
			],
			filesystem: [
				{ path: '/home/root/lms2012/prjs/LifeTheUniverseAndEverything/LifeTheUniverseAndEverything.rbf', content: '' },
				{ path: '/home/root/lms2012/prjs/LifeTheUniverseAndEverything/Answer.rbf',                       content: '' },
			],
		},

		// ── Bender ─────────────────────────────────────────────────────
		// Futurama. Bending unit, model 22.
		{
			id: 'bender',
			displayName: 'Bender',
			firmwareVersion: 'V1.10E',
			battery: { level: 60, voltage: 7.1 },
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor',  unit: 'deg', dynamic: { kind: 'sine',     min: -90, max: 90,  periodMs: 2000 } },
				{ port: 'B', peripheralType: 'large-motor',  unit: 'deg', dynamic: { kind: 'triangle', min: -90, max: 90,  periodMs: 2500 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'touch-sensor',       unit: '',   dynamic: { kind: 'static', value: 0 } },
				{ port: '2', peripheralType: 'color-sensor',       unit: '',   dynamic: { kind: 'square', low: 0, high: 7, periodMs: 3000 } },
			],
			filesystem: [
				{ path: '/home/root/lms2012/prjs/BiteMyShinyMetal/BiteMyShinyMetal.rbf', content: '' },
				{ path: '/home/root/lms2012/prjs/BiteMyShinyMetal/beer.rbf',             content: '' },
			],
		},

		// ── R2D2 ────────────────────────────────────────────────────────
		// Star Wars. Reliable astromech droid.
		{
			id: 'r2d2',
			displayName: 'R2D2',
			firmwareVersion: 'V1.10E',
			battery: { level: 92, voltage: 7.9 },
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'sine', min: 0, max: 360, periodMs: 3000 } },
				{ port: 'B', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'sine', min: 0, max: 360, periodMs: 3200 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'ultrasonic-sensor', unit: 'cm', dynamic: { kind: 'sine',   min: 10, max: 255, periodMs: 5000 } },
				{ port: '2', peripheralType: 'color-sensor',      unit: '',   dynamic: { kind: 'static', value: 3 } },
			],
			filesystem: [
				{ path: '/home/root/lms2012/prjs/Astromech/Astromech.rbf',       content: '' },
				{ path: '/home/root/lms2012/prjs/Astromech/NavigationGrid.rbf',  content: '' },
				{ path: '/home/root/lms2012/prjs/Astromech/BeepSequence.rbf',    content: '' },
			],
		},

		// ── SkyNet ──────────────────────────────────────────────────────
		// Terminator. Master controller. Periodically disappears from discovery.
		{
			id: 'skynet',
			displayName: 'SkyNet',
			firmwareVersion: 'V1.10E',
			battery: { level: 99, voltage: 8.1 },
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor',  unit: 'deg', dynamic: { kind: 'triangle', min: 0,   max: 360, periodMs: 4000 } },
				{ port: 'B', peripheralType: 'medium-motor', unit: '',    dynamic: { kind: 'square',   low: 0,   high: 1,  periodMs: 1500 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'ultrasonic-sensor', unit: 'cm', dynamic: { kind: 'sine', min: 5, max: 255, periodMs: 2000 } },
				{ port: '2', peripheralType: 'color-sensor',      unit: '',   dynamic: { kind: 'none' } },
			],
			loss: { enabled: true, visibleMs: 15000, hiddenMs: 5000 },
			filesystem: [
				{ path: '/home/root/lms2012/prjs/Judgment/Judgment.rbf',       content: '' },
				{ path: '/home/root/lms2012/prjs/Judgment/TargetLock.rbf',     content: '' },
				{ path: '/home/root/lms2012/prjs/Judgment/GridScan.rbf',       content: '' },
			],
		},

		// ── T800 ────────────────────────────────────────────────────────
		// Terminator T-800. Slave unit of SkyNet.
		{
			id: 't800',
			displayName: 'T800',
			firmwareVersion: 'V1.10E',
			battery: { level: 74, voltage: 7.5 },
			parentId: 'skynet',
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'triangle', min: -180, max: 180, periodMs: 2000 } },
				{ port: 'B', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'triangle', min: -180, max: 180, periodMs: 2200 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'touch-sensor',       unit: '',   dynamic: { kind: 'static', value: 0 } },
				{ port: '2', peripheralType: 'ultrasonic-sensor',  unit: 'cm', dynamic: { kind: 'sine', min: 5, max: 100, periodMs: 3000 } },
			],
			filesystem: [
				{ path: '/home/root/lms2012/prjs/T800/T800.rbf',         content: '' },
				{ path: '/home/root/lms2012/prjs/T800/ArmSequence.rbf',  content: '' },
			],
		},

		// ── T1000 ───────────────────────────────────────────────────────
		// Terminator T-1000. Liquid metal. Slave unit of SkyNet.
		{
			id: 't1000',
			displayName: 'T1000',
			firmwareVersion: 'V1.10E',
			battery: { level: 88, voltage: 7.7 },
			parentId: 'skynet',
			motorPorts: [
				{ port: 'A', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'sine', min: 0, max: 360, periodMs: 800 } },
				{ port: 'B', peripheralType: 'large-motor', unit: 'deg', dynamic: { kind: 'sine', min: 0, max: 360, periodMs: 850 } },
			],
			sensorPorts: [
				{ port: '1', peripheralType: 'color-sensor', unit: '', dynamic: { kind: 'static', value: 0 } },
				{ port: '2', peripheralType: 'none',         unit: '', dynamic: { kind: 'none' } },
			],
			filesystem: [
				{ path: '/home/root/lms2012/prjs/T1000/T1000.rbf',       content: '' },
				{ path: '/home/root/lms2012/prjs/T1000/MorphSequence.rbf', content: '' },
			],
		},

	],
};
