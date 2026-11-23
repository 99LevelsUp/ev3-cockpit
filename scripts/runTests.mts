import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runTests } = require('@vscode/test-electron') as typeof import('@vscode/test-electron');

async function main(): Promise<void> {
	try {
		const extensionDevelopmentPath = path.resolve(import.meta.dirname, '..');
		const extensionTestsPath = path.resolve(import.meta.dirname, '..', 'out', 'vscode', 'integration', 'index');

		// Download VS Code, unzip it and run the integration test
		await runTests({ extensionDevelopmentPath, extensionTestsPath });
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	}
}

void main();
