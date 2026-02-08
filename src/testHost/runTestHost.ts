import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
	const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
	const workspacePath = path.resolve(__dirname, '..', '..', 'test-fixtures', 'empty-workspace');
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-testhost-'));
	const userDataDir = path.join(tempRoot, 'user-data');
	const extensionsDir = path.join(tempRoot, 'extensions');
	await fs.mkdir(userDataDir, { recursive: true });
	await fs.mkdir(extensionsDir, { recursive: true });

	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				workspacePath,
				'--disable-extensions',
				'--disable-updates',
				'--skip-release-notes',
				'--skip-welcome',
				'--disable-workspace-trust',
				'--user-data-dir',
				userDataDir,
				'--extensions-dir',
				extensionsDir
			]
		});
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`[HOST] Extension host tests failed: ${message}`);
	process.exitCode = 1;
});
