import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelyEv3SerialCandidate } from '../device/brickDiscoveryService';

test('isLikelyEv3SerialCandidate returns true for EV3 fingerprint in pnpId', () => {
	const candidate = { path: 'COM5', manufacturer: '', serialNumber: '', pnpId: 'USB\\VID_0694&PID_005D' };
	assert.ok(isLikelyEv3SerialCandidate(candidate));
});

test('isLikelyEv3SerialCandidate returns true for LEGO in manufacturer', () => {
	const candidate = { path: 'COM3', manufacturer: 'LEGO', serialNumber: '', pnpId: '' };
	assert.ok(isLikelyEv3SerialCandidate(candidate));
});

test('isLikelyEv3SerialCandidate returns true for EV3 in serialNumber', () => {
	const candidate = { path: 'COM4', manufacturer: '', serialNumber: 'EV3-ABC', pnpId: '' };
	assert.ok(isLikelyEv3SerialCandidate(candidate));
});

test('isLikelyEv3SerialCandidate returns true for MINDSTORMS keyword', () => {
	const candidate = { path: 'COM6', manufacturer: 'Mindstorms Device', serialNumber: '', pnpId: '' };
	assert.ok(isLikelyEv3SerialCandidate(candidate));
});

test('isLikelyEv3SerialCandidate returns false for unrelated device', () => {
	const candidate = { path: 'COM7', manufacturer: 'Arduino', serialNumber: '12345', pnpId: 'USB\\VID_0000' };
	assert.ok(!isLikelyEv3SerialCandidate(candidate));
});

test('isLikelyEv3SerialCandidate returns false for generic Bluetooth SPP without EV3 hints', () => {
	const candidate = {
		path: 'COM11',
		manufacturer: 'Microsoft',
		serialNumber: '',
		pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\8&XXX&0&000000000000_00000009'
	};
	assert.ok(!isLikelyEv3SerialCandidate(candidate));
});

test('isLikelyEv3SerialCandidate returns true for preferred port even if no fingerprint', () => {
	const candidate = { path: 'COM8', manufacturer: '', serialNumber: '', pnpId: '' };
	assert.ok(isLikelyEv3SerialCandidate(candidate, 'COM8'));
});

test('isLikelyEv3SerialCandidate is case insensitive for preferred port', () => {
	const candidate = { path: 'com9', manufacturer: '', serialNumber: '', pnpId: '' };
	// Preferred port must match after normalizing the path to uppercase
	assert.ok(isLikelyEv3SerialCandidate(candidate, 'COM9'));
});

test('isLikelyEv3SerialCandidate returns false when preferred port does not match and no fingerprint', () => {
	const candidate = { path: 'COM10', manufacturer: '', serialNumber: '', pnpId: '' };
	assert.ok(!isLikelyEv3SerialCandidate(candidate, 'COM99'));
});
