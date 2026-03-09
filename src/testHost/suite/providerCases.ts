import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { HostTestCase } from './hostTestCases';
import { withWorkspaceSettings } from './testInfrastructure';

async function testEv3FileSystemProvider(): Promise<void> {
	const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
	const fileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/test.txt');
	await assert.rejects(async () => await vscode.workspace.fs.readDirectory(directoryUri), /no active ev3 connection|not available|filesystem access/i);
	await assert.rejects(async () => await vscode.workspace.fs.readFile(fileUri), /no active ev3 connection|not available|filesystem access/i);
	await assert.rejects(async () => await vscode.workspace.fs.writeFile(fileUri, new Uint8Array([0x61])), /read-only|no active ev3 connection|not available/i);
}

async function testMockConnectFlowWiresActiveFsProvider(): Promise<void> {
	await withWorkspaceSettings({ 'transport.mode': 'mock' }, async () => {
		await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3');
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		await vscode.commands.executeCommand('ev3-cockpit.emergencyStop');
		await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
		await assert.rejects(
			async () => await vscode.workspace.fs.readDirectory(vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/')),
			/no active ev3 connection|execution failed|payload|reply|status|unexpected|list/i
		);
	});
}

async function testProviderRejectsNonActiveBrickAuthority(): Promise<void> {
	await withWorkspaceSettings({ 'transport.mode': 'mock' }, async () => {
		await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		try {
			await assert.rejects(
				async () => await vscode.workspace.fs.readDirectory(vscode.Uri.parse('ev3://brick-2/home/root/lms2012/prjs/')),
				/not available|brick/i
			);
		} finally {
			await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
		}
	});
}

export const PROVIDER_HOST_TEST_CASES: HostTestCase[] = [
	['ev3 filesystem provider offline', testEv3FileSystemProvider],
	['mock connect flow wires active fs provider', testMockConnectFlowWiresActiveFsProvider],
	['provider rejects non-active brick authority', testProviderRejectsNonActiveBrickAuthority]
];
