/**
 * The cockpit in a workspace that is not trusted yet (found on HOSTC, 13.11.2026).
 *
 * Without a declaration VS Code disables the extension in Restricted Mode, silently: the installed
 * cockpit did not start in a new window and nothing said why. The cockpit runs nothing from the
 * workspace, so it supports untrusted workspaces — but limited: `accessMode` opens the brick to
 * other extensions, shell included, and a cloned repository must not switch that on through its own
 * `.vscode/settings.json`. In an untrusted workspace VS Code then takes only the user's value.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
	capabilities?: { untrustedWorkspaces?: { supported?: unknown; restrictedConfigurations?: string[]; description?: string } };
};

describe('Workspace trust', () => {
	it('runs in a workspace not trusted yet, limited', () => {
		assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, 'limited');
		assert.ok(manifest.capabilities?.untrustedWorkspaces?.description, 'VS Code shows the user why it is limited');
	});

	it('takes the access mode only from the user while the workspace is not trusted', () => {
		assert.ok(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations?.includes('ev3-cockpit.accessMode'));
	});
});
