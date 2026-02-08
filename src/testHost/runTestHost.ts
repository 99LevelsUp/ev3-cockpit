import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
	const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
	const workspacePath = path.resolve(__dirname, '..', '..', 'test-fixtures', 'empty-workspace');

	await runTests({
		extensionDevelopmentPath,
		extensionTestsPath,
		launchArgs: [workspacePath, '--disable-extensions']
	});
}

void main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`[HOST] Extension host tests failed: ${message}`);
	process.exitCode = 1;
});
