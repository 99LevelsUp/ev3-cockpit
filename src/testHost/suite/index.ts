import * as vscode from 'vscode';
import { CORE_HOST_TEST_CASES } from './coreCases';
import { DEPLOY_HOST_TEST_CASES } from './deployCases';
import type { HostTestCase } from './hostTestCases';
import { PROVIDER_HOST_TEST_CASES } from './providerCases';
import { TCP_HOST_TEST_CASES } from './tcpCases';
import {
	EXTENSION_ID,
	runCase,
	resetWorkspaceSettings,
	waitForCondition
} from './testInfrastructure';

function getHostTestCases(): HostTestCase[] {
	return [
		...CORE_HOST_TEST_CASES,
		...PROVIDER_HOST_TEST_CASES,
		...TCP_HOST_TEST_CASES,
		...DEPLOY_HOST_TEST_CASES
	];
}

export async function run(): Promise<void> {
	await waitForCondition(
		'extension registration',
		() => vscode.extensions.getExtension(EXTENSION_ID) !== undefined
	);

	await resetWorkspaceSettings();

	const cases = getHostTestCases();
	let passed = 0;
	let failed = 0;
	for (const [name, fn] of cases) {
		const ok = await runCase(name, fn);
		if (ok) {
			passed += 1;
		} else {
			failed += 1;
		}
	}

	console.log(`\nℹ host tests ${cases.length}`);
	console.log(`ℹ pass ${passed}`);
	console.log(`ℹ fail ${failed}`);

	if (failed > 0) {
		throw new Error(`${failed} host test(s) failed.`);
	}
}
