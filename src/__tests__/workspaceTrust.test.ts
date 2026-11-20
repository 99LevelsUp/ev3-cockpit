/**
 * The cockpit in a workspace that is not trusted yet (found on HOSTC, 13.11.2026).
 *
 * Without a declaration VS Code disables the extension in Restricted Mode, silently: the installed
 * cockpit did not start in a new window and nothing said why. The cockpit runs nothing from the
 * workspace, and since its settings moved to the cockpit daemon (U11) a workspace's own
 * `.vscode/settings.json` can no longer change any of them — the access mode included — so it
 * supports untrusted workspaces fully.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
	capabilities?: { untrustedWorkspaces?: { supported?: unknown; restrictedConfigurations?: string[]; description?: string } };
	contributes?: { configuration?: unknown; commands?: { command: string; title: string; category?: string }[] };
};

describe('Workspace trust', () => {
	it('runs in a workspace not trusted yet, and says why that is safe', () => {
		assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, true);
		assert.ok(manifest.capabilities?.untrustedWorkspaces?.description);
	});

	it('declares no VS Code settings a workspace could change: they live in the daemon (R25)', () => {
		assert.equal(manifest.contributes?.configuration, undefined);
		assert.equal(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations, undefined);
		const settings = manifest.contributes?.commands?.find((c) => c.command === 'ev3-cockpit.settings');
		assert.equal(`${settings?.category}: ${settings?.title}`, 'EVƎ: Settings');
	});
});
