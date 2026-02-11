import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { readBrickPanelDiscoveryConfig } from '../config/brickPanelDiscoveryConfig';

function createTempExtensionRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-cockpit-discovery-config-'));
	fs.mkdirSync(path.join(root, 'config'), { recursive: true });
	return root;
}

test('readBrickPanelDiscoveryConfig reads configured values from JSON file', () => {
	const root = createTempExtensionRoot();
	try {
		fs.writeFileSync(
			path.join(root, 'config', 'brick-panel.scan.json'),
			JSON.stringify({
				discoveryRefreshFastMs: 3200,
				discoveryRefreshSlowMs: 17000
			}),
			'utf8'
		);
		const config = readBrickPanelDiscoveryConfig(root);
		assert.equal(config.discoveryRefreshFastMs, 3200);
		assert.equal(config.discoveryRefreshSlowMs, 17000);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('readBrickPanelDiscoveryConfig falls back to defaults when file is missing', () => {
	const root = createTempExtensionRoot();
	try {
		const config = readBrickPanelDiscoveryConfig(root);
		assert.equal(config.discoveryRefreshFastMs, 2500);
		assert.equal(config.discoveryRefreshSlowMs, 15000);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('readBrickPanelDiscoveryConfig sanitizes invalid values and keeps slow >= fast', () => {
	const root = createTempExtensionRoot();
	try {
		fs.writeFileSync(
			path.join(root, 'config', 'brick-panel.scan.json'),
			JSON.stringify({
				discoveryRefreshFastMs: 100,
				discoveryRefreshSlowMs: 300
			}),
			'utf8'
		);
		const config = readBrickPanelDiscoveryConfig(root);
		assert.equal(config.discoveryRefreshFastMs, 500);
		assert.equal(config.discoveryRefreshSlowMs, 1000);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
