import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCapabilityProfile } from '../compat/capabilityProfile';
import { CapabilityProbeResult } from '../protocol/capabilityProbe';

function probe(overrides: Partial<CapabilityProbeResult> = {}): CapabilityProbeResult {
	return {
		osVersion: 'Linux 2.6.33-rc',
		hwVersion: 'V0.60',
		fwVersion: 'V1.10E',
		osBuild: '1803051132',
		fwBuild: '1803051258',
		...overrides
	};
}

test('capability profile auto selects stock-default for stock v1.10+', () => {
	const profile = buildCapabilityProfile(probe(), 'auto');
	assert.equal(profile.id, 'stock-default');
	assert.equal(profile.supportsContinueList, true);
	assert.equal(profile.firmwareFamily, 'stock');
});

test('capability profile auto selects stock-legacy for stock v1.09', () => {
	const profile = buildCapabilityProfile(probe({ fwVersion: 'V1.09E' }), 'auto');
	assert.equal(profile.id, 'stock-legacy');
	assert.equal(profile.supportsContinueList, false);
});

test('capability profile auto selects conservative profile for unknown firmware', () => {
	const profile = buildCapabilityProfile(probe({ fwVersion: 'custom-2026', hwVersion: 'X1' }), 'auto');
	assert.equal(profile.id, 'compat-conservative');
	assert.equal(profile.firmwareFamily, 'unknown');
});

test('capability profile stock-strict mode forces strict profile', () => {
	const profile = buildCapabilityProfile(probe({ fwVersion: 'custom-2026' }), 'stock-strict');
	assert.equal(profile.id, 'stock-strict');
	assert.equal(profile.supportsContinueList, false);
});
