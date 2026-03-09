import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostTestCase } from './hostTestCases';
import {
	EXTENSION_ID,
	toSafeIdentifierForTest,
	withWorkspaceSettings,
	resetWorkspaceSettings
} from './testInfrastructure';

async function testActivation(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `Extension "${EXTENSION_ID}" is not available in extension host.`);
	await extension.activate();
	assert.equal(extension.isActive, true, 'Extension should be active after activation.');
}

async function testBrickPanelViewContribution(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, 'Extension must be available.');
	const views = extension.packageJSON?.contributes?.views;
	assert.ok(views, 'Extension must contribute views.');
	const allViews = Object.values(views).flat() as Array<{ id: string; type?: string }>;
	const brickPanel = allViews.find((v) => v.id === 'ev3-cockpit.brick');
	assert.ok(brickPanel, 'Extension must contribute ev3-cockpit.brick webview view.');
	assert.equal(brickPanel.type, 'webview', 'Brick panel must be a webview view.');
}

async function testCommandsRegistration(): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	assert.ok(commands.includes('ev3-cockpit.connectEV3'));
	assert.ok(commands.includes('ev3-cockpit.deployAndRunExecutable'));
	assert.ok(commands.includes('ev3-cockpit.previewProjectDeploy'));
	assert.ok(commands.includes('ev3-cockpit.deployProject'));
	assert.ok(commands.includes('ev3-cockpit.previewProjectDeployToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployProjectToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployProjectAndRunExecutableToBrick'));
	assert.ok(commands.includes('ev3-cockpit.previewWorkspaceDeploy'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspace'));
	assert.ok(commands.includes('ev3-cockpit.previewWorkspaceDeployToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployProjectAndRunExecutable'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceAndRunExecutable'));
	assert.ok(commands.includes('ev3-cockpit.applyDeployProfile'));
	assert.ok(commands.includes('ev3-cockpit.applyDeployProfileToBrick'));
	assert.ok(commands.includes('ev3-cockpit.runRemoteProgram'));
	assert.ok(commands.includes('ev3-cockpit.stopProgram'));
	assert.ok(commands.includes('ev3-cockpit.restartProgram'));
	assert.ok(commands.includes('ev3-cockpit.reconnectEV3'));
	assert.ok(commands.includes('ev3-cockpit.disconnectEV3'));
	assert.ok(commands.includes('ev3-cockpit.emergencyStop'));
	assert.ok(commands.includes('ev3-cockpit.inspectTransports'));
	assert.ok(commands.includes('ev3-cockpit.transportHealthReport'));
	assert.ok(commands.includes('ev3-cockpit.inspectBrickSessions'));
	assert.ok(commands.includes('ev3-cockpit.revealInBricksTree'));
	assert.ok(commands.includes('ev3-cockpit.browseRemoteFs'));
	assert.ok(commands.includes('ev3-cockpit.refreshBricksView'));
	assert.ok(commands.includes('ev3-cockpit.setBricksTreeFilter'));
	assert.ok(commands.includes('ev3-cockpit.clearBricksTreeFilter'));
	assert.ok(commands.includes('ev3-cockpit.reconnectReadyBricks'));
	assert.ok(commands.includes('ev3-cockpit.previewWorkspaceDeployToReadyBricks'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceToReadyBricks'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks'));
	assert.ok(commands.includes('ev3-cockpit.toggleFavoriteBrick'));
	assert.ok(commands.includes('ev3-cockpit.uploadToBrickFolder'));
	assert.ok(commands.includes('ev3-cockpit.deleteRemoteEntryFromTree'));
	assert.ok(commands.includes('ev3-cockpit.runRemoteExecutableFromTree'));
	assert.ok(commands.includes('ev3-cockpit.retryDirectoryFromTree'));
}

async function testWorkspaceSettingsIsolation(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	await cfg.update('transport.tcp.port', 99999, vscode.ConfigurationTarget.Workspace);
	assert.equal(cfg.inspect('transport.tcp.port')?.workspaceValue, 99999);
	await resetWorkspaceSettings();
	assert.equal(cfg.inspect('transport.tcp.port')?.workspaceValue, undefined);
	assert.equal(cfg.inspect('transport.mode')?.workspaceValue, 'mock');
}

async function testBrickIdConsistencyWithExtension(): Promise<void> {
	const endpoints = ['active:5555', '127.0.0.1:12345', '192.168.1.100:5555', 'localhost:5555', 'MY-BRICK:5555', '  spaced : 80  ', 'UPPER.CASE:9999'];
	for (const endpoint of endpoints) {
		const testId = toSafeIdentifierForTest(endpoint);
		assert.ok(testId.length > 0);
		assert.ok(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(testId));
	}
	assert.equal(`tcp-${toSafeIdentifierForTest('active:5555')}`, 'tcp-active-5555');
}

async function testCommandsWithoutHardware(): Promise<void> {
	await withWorkspaceSettings(
		{ 'transport.mode': 'mock', 'transport.timeoutMs': 200 },
		async () => {
			await vscode.commands.executeCommand('ev3-cockpit.deployAndRunExecutable');
			await vscode.commands.executeCommand('ev3-cockpit.previewProjectDeploy');
			await vscode.commands.executeCommand('ev3-cockpit.deployProject');
			await vscode.commands.executeCommand('ev3-cockpit.previewProjectDeployToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployProjectToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployProjectAndRunExecutableToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeploy');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspace');
			await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployProjectAndRunExecutable');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutable');
			await vscode.commands.executeCommand('ev3-cockpit.applyDeployProfileToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.runRemoteProgram');
			await vscode.commands.executeCommand('ev3-cockpit.stopProgram');
			await vscode.commands.executeCommand('ev3-cockpit.restartProgram');
			await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
			await vscode.commands.executeCommand('ev3-cockpit.emergencyStop');
			await vscode.commands.executeCommand('ev3-cockpit.inspectTransports');
			await vscode.commands.executeCommand('ev3-cockpit.transportHealthReport');
			await vscode.commands.executeCommand('ev3-cockpit.inspectBrickSessions');
			await vscode.commands.executeCommand('ev3-cockpit.revealInBricksTree');
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			assert.ok(workspaceFolder);
			const diagnosticsReportPath = path.join(workspaceFolder.uri.fsPath, 'artifacts', 'diagnostics', 'brick-sessions-report.json');
			const diagnosticsReport = JSON.parse(await fs.readFile(diagnosticsReportPath, 'utf8')) as { generatedAtIso?: string; bricks?: unknown[]; runtimeSessions?: unknown[] };
			assert.equal(typeof diagnosticsReport.generatedAtIso, 'string');
			assert.ok(Array.isArray(diagnosticsReport.bricks));
			assert.ok(Array.isArray(diagnosticsReport.runtimeSessions));
			await vscode.commands.executeCommand('ev3-cockpit.browseRemoteFs');
			await vscode.commands.executeCommand('ev3-cockpit.refreshBricksView');
			await vscode.commands.executeCommand('ev3-cockpit.setBricksTreeFilter', 'host-batch');
			await vscode.commands.executeCommand('ev3-cockpit.clearBricksTreeFilter');
			await vscode.commands.executeCommand('ev3-cockpit.reconnectReadyBricks');
			await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToReadyBricks');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToReadyBricks');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks');
			await vscode.commands.executeCommand('ev3-cockpit.toggleFavoriteBrick');
			await vscode.commands.executeCommand('ev3-cockpit.uploadToBrickFolder');
			await vscode.commands.executeCommand('ev3-cockpit.deleteRemoteEntryFromTree');
			await vscode.commands.executeCommand('ev3-cockpit.runRemoteExecutableFromTree');
			await vscode.commands.executeCommand('ev3-cockpit.retryDirectoryFromTree');
		}
	);
}

export const CORE_HOST_TEST_CASES: HostTestCase[] = [
	['activation', testActivation],
	['brick panel view contribution', testBrickPanelViewContribution],
	['commands registration', testCommandsRegistration],
	['workspace settings isolation', testWorkspaceSettingsIsolation],
	['brick id consistency with extension', testBrickIdConsistencyWithExtension],
	['commands without hardware', testCommandsWithoutHardware]
];
