import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildRemoteProjectRoot } from '../../fs/deployActions';
import type { HostTestCase } from './hostTestCases';
import { startFakeDiscoveryBeacon, startFakeEv3TcpServer } from './fakeEv3Server';
import {
	toSafeIdentifierForTest,
	waitForCondition,
	withAutoDismissedBatchPrompts,
	withTemporaryWorkspaceFolder,
	withWorkspaceSettings
} from './testInfrastructure';

async function testWorkspaceDeployCommandsWithMockTcp(): Promise<void> {
	const fakeServer = await startFakeEv3TcpServer();
	const discoveryPort = 34000 + Math.floor(Math.random() * 1000);
	const stopBeacon = startFakeDiscoveryBeacon(discoveryPort, fakeServer.port);

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '',
				'transport.tcp.port': 5555,
				'transport.tcp.useDiscovery': true,
				'transport.tcp.discoveryPort': discoveryPort,
				'transport.tcp.discoveryTimeoutMs': 3000,
				'transport.tcp.handshakeTimeoutMs': 3000
			},
			async () => {
				await withTemporaryWorkspaceFolder(
					async (workspaceFsPath) => {
						await fs.mkdir(path.join(workspaceFsPath, 'docs'), { recursive: true });
						await fs.writeFile(path.join(workspaceFsPath, 'main.rbf'), Buffer.from([0x01, 0x02, 0x03, 0x04]));
						await fs.writeFile(path.join(workspaceFsPath, 'docs', 'notes.txt'), 'workspace-v1\n', 'utf8');
					},
					async (workspaceUri) => {
						await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
						await waitForCondition(
							'tcp connect should accept at least one socket for deploy test',
							() => fakeServer.getAcceptedConnectionCount() >= 1,
							6_000
						);
						await new Promise<void>((resolve) => setTimeout(resolve, 300));

						const remoteProjectRoot = buildRemoteProjectRoot(workspaceUri.fsPath, '/home/root/lms2012/prjs/');
						const remoteProjectUri = vscode.Uri.parse(`ev3://active${remoteProjectRoot}/`);
						const remoteProgramUri = vscode.Uri.parse(`ev3://active${remoteProjectRoot}/main.rbf`);
						const remoteNotesUri = vscode.Uri.parse(`ev3://active${remoteProjectRoot}/docs/notes.txt`);

						try {
							await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeploy');
							await assert.rejects(async () => await vscode.workspace.fs.readDirectory(remoteProjectUri), /not found|path not found|status|directory/i);

							await vscode.commands.executeCommand('ev3-cockpit.deployWorkspace');
							assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(remoteProgramUri)), [0x01, 0x02, 0x03, 0x04]);
							assert.equal(Buffer.from(await vscode.workspace.fs.readFile(remoteNotesUri)).toString('utf8'), 'workspace-v1\n');

							await fs.writeFile(path.join(workspaceUri.fsPath, 'main.rbf'), Buffer.from([0x05, 0x06, 0x07, 0x08]));
							await fs.writeFile(path.join(workspaceUri.fsPath, 'docs', 'notes.txt'), 'workspace-v2\n', 'utf8');

							const runCountBefore = fakeServer.getRunProgramCommandCount();
							await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutable');
							assert.ok(fakeServer.getRunProgramCommandCount() > runCountBefore);

							assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(remoteProgramUri)), [0x05, 0x06, 0x07, 0x08]);
							assert.equal(Buffer.from(await vscode.workspace.fs.readFile(remoteNotesUri)).toString('utf8'), 'workspace-v2\n');
							await vscode.workspace.fs.delete(remoteProjectUri, { recursive: true, useTrash: false });
						} finally {
							await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
							await new Promise<void>((resolve) => setTimeout(resolve, 300));
						}
					}
				);
			}
		);
	} finally {
		stopBeacon();
		await fakeServer.close();
	}
}

async function testMultiBrickSelectedDeployCommandsWithMockTcp(): Promise<void> {
	const fakeServerA = await startFakeEv3TcpServer();
	const fakeServerB = await startFakeEv3TcpServer();

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(workspaceFolder);
	const workspaceUri = workspaceFolder.uri;
	const workspaceFsPath = workspaceUri.fsPath;
	const localProgramPath = path.join(workspaceFsPath, 'host-multi-brick-main.rbf');
	const localNotesPath = path.join(workspaceFsPath, 'host-multi-brick-notes.txt');

	await fs.mkdir(workspaceFsPath, { recursive: true });
	await fs.writeFile(localProgramPath, Buffer.from([0x10, 0x11, 0x12, 0x13]));
	await fs.writeFile(localNotesPath, 'multi-brick-v1\n', 'utf8');

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '127.0.0.1',
				'transport.tcp.useDiscovery': false,
				'transport.tcp.handshakeTimeoutMs': 3000,
				'transport.tcp.port': fakeServerA.port,
				'deploy.includeGlobs': ['host-multi-brick-*']
			},
			async () => {
				const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
				const connectWithPort = async (port: number): Promise<void> => {
					await cfg.update('transport.tcp.port', port, vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 150));
					await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
					await new Promise<void>((resolve) => setTimeout(resolve, 250));
				};

				const makeBrickRootNode = (brickId: string) => ({
					kind: 'brick',
					brickId,
					displayName: `EV3 TCP (${brickId})`,
					role: 'standalone',
					transport: 'tcp',
					status: 'READY',
					isActive: false,
					rootPath: '/home/root/lms2012/prjs/'
				});

				const remoteProjectRoot = buildRemoteProjectRoot(workspaceUri.fsPath, '/home/root/lms2012/prjs/');
				const brickAId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerA.port}`)}`;
				const brickBId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerB.port}`)}`;
				const brickANode = makeBrickRootNode(brickAId);
				const brickBNode = makeBrickRootNode(brickBId);

				const brickAProjectUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/`);
				const brickARootUri = vscode.Uri.parse(`ev3://${brickAId}/home/root/lms2012/prjs/`);
				const brickBRootUri = vscode.Uri.parse(`ev3://${brickBId}/home/root/lms2012/prjs/`);
				const brickAProgramUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/host-multi-brick-main.rbf`);
				const brickBProgramUri = vscode.Uri.parse(`ev3://${brickBId}${remoteProjectRoot}/host-multi-brick-main.rbf`);
				const brickAUniqueUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/host-multi-brick-only-a.txt`);
				const brickBUniqueUri = vscode.Uri.parse(`ev3://${brickBId}${remoteProjectRoot}/host-multi-brick-only-a.txt`);

				await connectWithPort(fakeServerA.port);
				await connectWithPort(fakeServerB.port);
				await vscode.workspace.fs.readDirectory(brickARootUri);
				await vscode.workspace.fs.readDirectory(brickBRootUri);

				await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToBrick', brickANode);
				await assert.rejects(async () => await vscode.workspace.fs.readDirectory(brickAProjectUri), /not found|path not found|status|directory/i);
				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickANode);
				assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(brickAProgramUri)), [0x10, 0x11, 0x12, 0x13]);
				await assert.rejects(async () => await vscode.workspace.fs.readFile(brickBProgramUri), /not found|path not found|status|file/i);

				const runCountABefore = fakeServerA.getRunProgramCommandCount();
				const runCountBBefore = fakeServerB.getRunProgramCommandCount();
				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick', brickANode);
				assert.ok(fakeServerA.getRunProgramCommandCount() > runCountABefore);
				assert.equal(fakeServerB.getRunProgramCommandCount(), runCountBBefore);

				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickBNode);
				assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(brickBProgramUri)), [0x10, 0x11, 0x12, 0x13]);

				await vscode.workspace.fs.writeFile(brickAUniqueUri, Buffer.from('only-on-a', 'utf8'));
				assert.equal(Buffer.from(await vscode.workspace.fs.readFile(brickAUniqueUri)).toString('utf8'), 'only-on-a');
				await assert.rejects(async () => await vscode.workspace.fs.readFile(brickBUniqueUri), /not found|path not found|status|file/i);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', brickANode);
				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', brickBNode);
				await new Promise<void>((resolve) => setTimeout(resolve, 300));
			}
		);
	} finally {
		await fs.rm(localProgramPath, { force: true });
		await fs.rm(localNotesPath, { force: true });
		await fakeServerA.close();
		await fakeServerB.close();
	}
}

async function testBatchCommandsWithMultiBrickMockTcp(): Promise<void> {
	const fakeServerA = await startFakeEv3TcpServer();
	const fakeServerB = await startFakeEv3TcpServer();

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(workspaceFolder);
	const workspaceUri = workspaceFolder.uri;
	const workspaceFsPath = workspaceUri.fsPath;
	const localProgramPath = path.join(workspaceFsPath, 'host-batch-main.rbf');
	const localNotesPath = path.join(workspaceFsPath, 'host-batch-notes.txt');

	await fs.mkdir(workspaceFsPath, { recursive: true });
	await fs.writeFile(localProgramPath, Buffer.from([0x21, 0x22, 0x23, 0x24]));
	await fs.writeFile(localNotesPath, 'batch-v1\n', 'utf8');

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '127.0.0.1',
				'transport.tcp.useDiscovery': false,
				'transport.tcp.handshakeTimeoutMs': 3000,
				'transport.tcp.port': fakeServerA.port,
				'deploy.includeGlobs': ['host-batch-*']
			},
			async () => {
				await withAutoDismissedBatchPrompts(async () => {
					const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
					const remoteProjectRoot = buildRemoteProjectRoot(workspaceUri.fsPath, '/home/root/lms2012/prjs/');
					const brickAId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerA.port}`)}`;
					const brickBId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerB.port}`)}`;
					const brickARootUri = vscode.Uri.parse(`ev3://${brickAId}/home/root/lms2012/prjs/`);
					const brickBRootUri = vscode.Uri.parse(`ev3://${brickBId}/home/root/lms2012/prjs/`);
					const brickAProgramUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/host-batch-main.rbf`);
					const brickBProgramUri = vscode.Uri.parse(`ev3://${brickBId}${remoteProjectRoot}/host-batch-main.rbf`);

					const waitForBrickReady = async (brickRootUri: vscode.Uri): Promise<void> => {
						const deadline = Date.now() + 5000;
						while (Date.now() < deadline) {
							try {
								await vscode.workspace.fs.readDirectory(brickRootUri);
								return;
							} catch {
								await new Promise<void>((resolve) => setTimeout(resolve, 150));
							}
						}
						throw new Error(`Timed out waiting for ready brick: ${brickRootUri.toString()}`);
					};

					const connectWithPort = async (port: number, brickRootUri: vscode.Uri): Promise<void> => {
						await cfg.update('transport.tcp.port', port, vscode.ConfigurationTarget.Workspace);
						await new Promise<void>((resolve) => setTimeout(resolve, 150));
						await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
						await waitForBrickReady(brickRootUri);
					};

					await connectWithPort(fakeServerA.port, brickARootUri);
					await connectWithPort(fakeServerB.port, brickBRootUri);
					await vscode.commands.executeCommand('ev3-cockpit.reconnectReadyBricks', [brickAId, brickBId]);
					await vscode.workspace.fs.readDirectory(brickARootUri);
					await vscode.workspace.fs.readDirectory(brickBRootUri);

					await cfg.update('transport.tcp.host', 'localhost', vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 250));
					await vscode.workspace.fs.readDirectory(brickARootUri);
					await vscode.workspace.fs.readDirectory(brickBRootUri);

					await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToReadyBricks', [brickAId]);
					await assert.rejects(async () => await vscode.workspace.fs.readFile(brickAProgramUri), /not found|path not found|status|file/i);
					await assert.rejects(async () => await vscode.workspace.fs.readFile(brickBProgramUri), /not found|path not found|status|file/i);

					await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToReadyBricks', [brickAId, brickBId]);
					assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(brickAProgramUri)), [0x21, 0x22, 0x23, 0x24]);
					assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(brickBProgramUri)), [0x21, 0x22, 0x23, 0x24]);

					await fs.writeFile(localProgramPath, Buffer.from([0x31, 0x32, 0x33, 0x34]));
					const runCountABefore = fakeServerA.getRunProgramCommandCount();
					const runCountBBefore = fakeServerB.getRunProgramCommandCount();
					await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks', [brickAId]);
					assert.ok(fakeServerA.getRunProgramCommandCount() > runCountABefore);
					assert.equal(fakeServerB.getRunProgramCommandCount(), runCountBBefore);

					assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(brickAProgramUri)), [0x31, 0x32, 0x33, 0x34]);
					assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(brickBProgramUri)), [0x21, 0x22, 0x23, 0x24]);

					await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', {
						kind: 'brick',
						brickId: brickAId,
						displayName: `EV3 TCP (${brickAId})`,
						role: 'standalone',
						transport: 'tcp',
						status: 'READY',
						isActive: false,
						rootPath: '/home/root/lms2012/prjs/'
					});
					await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', {
						kind: 'brick',
						brickId: brickBId,
						displayName: `EV3 TCP (${brickBId})`,
						role: 'standalone',
						transport: 'tcp',
						status: 'READY',
						isActive: false,
						rootPath: '/home/root/lms2012/prjs/'
					});
					await new Promise<void>((resolve) => setTimeout(resolve, 300));
				});
			}
		);
	} finally {
		await fs.rm(localProgramPath, { force: true });
		await fs.rm(localNotesPath, { force: true });
		await fakeServerA.close();
		await fakeServerB.close();
	}
}

export const DEPLOY_HOST_TEST_CASES: HostTestCase[] = [
	['workspace deploy commands with mock tcp', testWorkspaceDeployCommandsWithMockTcp],
	['multi-brick selected deploy commands with mock tcp', testMultiBrickSelectedDeployCommandsWithMockTcp],
	['batch commands with multi-brick mock tcp', testBatchCommandsWithMultiBrickMockTcp]
];
