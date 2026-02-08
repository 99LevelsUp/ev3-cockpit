import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPLOY_PROFILE_PRESETS, resolveDeployProfilePreset } from '../config/deployProfiles';

test('deployProfiles exposes expected preset ids in stable order', () => {
	assert.deepEqual(
		DEPLOY_PROFILE_PRESETS.map((entry) => entry.id),
		['safe-sync', 'atomic-sync', 'full-sync']
	);
});

test('deployProfiles resolve returns preset with expected key settings', () => {
	const safe = resolveDeployProfilePreset('safe-sync');
	const atomic = resolveDeployProfilePreset('atomic-sync');
	const full = resolveDeployProfilePreset('full-sync');

	assert.equal(safe.settings['fs.mode'], 'safe');
	assert.equal(safe.settings['deploy.incremental.enabled'], true);
	assert.equal(safe.settings['deploy.atomic.enabled'], false);

	assert.equal(atomic.settings['fs.mode'], 'safe');
	assert.equal(atomic.settings['deploy.atomic.enabled'], true);
	assert.equal(atomic.settings['deploy.verifyAfterUpload'], 'md5');

	assert.equal(full.settings['fs.mode'], 'full');
	assert.equal(full.settings['deploy.cleanup.enabled'], true);
	assert.equal(full.settings['deploy.cleanup.confirmBeforeDelete'], true);
});

