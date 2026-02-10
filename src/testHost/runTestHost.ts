import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

async function runVsCodeExtensionTests(
	vscodeExecutablePath: string,
	args: readonly string[],
	cwd: string
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(vscodeExecutablePath, args, {
			cwd,
			stdio: 'inherit',
			env: process.env
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`VS Code test host exited with code ${String(code)}.`));
		});
	});
}

async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
	const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
	const workspacePath = path.resolve(__dirname, '..', '..', 'test-fixtures', 'empty-workspace');
	const vscodeVersion = process.env.VSCODE_TEST_VERSION?.trim() || '1.109.0';
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-testhost-'));
	const userDataDir = path.join(tempRoot, 'user-data');
	const extensionsDir = path.join(tempRoot, 'extensions');
	await fs.mkdir(userDataDir, { recursive: true });
	await fs.mkdir(extensionsDir, { recursive: true });

	try {
		const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
		const launchArgs = [
			workspacePath,
			'--disable-extensions',
			'--disable-updates',
			'--skip-release-notes',
			'--skip-welcome',
			'--disable-workspace-trust',
			'--user-data-dir',
			userDataDir,
			'--extensions-dir',
			extensionsDir,
			'--extensionDevelopmentPath',
			extensionDevelopmentPath,
			'--extensionTestsPath',
			extensionTestsPath
		];
		await runVsCodeExtensionTests(vscodeExecutablePath, launchArgs, extensionDevelopmentPath);
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`[HOST] Extension host tests failed: ${message}`);
	process.exitCode = 1;
});
