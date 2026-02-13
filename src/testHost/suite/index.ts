import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildRemoteProjectRoot } from '../../fs/deployActions';
import { startFakeEv3TcpServer, startFakeDiscoveryBeacon } from './fakeEv3Server';
import {
	EXTENSION_ID,
	waitForCondition,
	toSafeIdentifierForTest,
	withWorkspaceSettings,
	withReconnectPromptChoice,
	withAutoDismissedBatchPrompts,
	withTemporaryWorkspaceFolder,
	runCase,
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

async function testEv3FileSystemProvider(): Promise<void> {
	const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
	const fileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/test.txt');

	let failed = false;
	try {
		await vscode.workspace.fs.readDirectory(directoryUri);
	} catch (error) {
		failed = true;
		const message = error instanceof Error ? error.message : String(error);
		assert.match(
			message,
			/no active ev3 connection|not available|filesystem access/i,
			'Expected ev3:// access to fail with a provider-originated message when no connection is active.'
		);
	}
	assert.equal(failed, true, 'ev3:// readDirectory should fail without active connection.');

	let readFailed = false;
	try {
		await vscode.workspace.fs.readFile(fileUri);
	} catch (error) {
		readFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		assert.match(
			message,
			/no active ev3 connection|not available|filesystem access/i,
			'Expected ev3:// readFile to fail with offline provider message.'
		);
	}
	assert.equal(readFailed, true, 'ev3:// readFile should fail without active connection.');

	let writeFailed = false;
	try {
		await vscode.workspace.fs.writeFile(fileUri, new Uint8Array([0x61]));
	} catch (error) {
		writeFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		assert.match(
			message,
			/read-only|no active ev3 connection|not available/i,
			'Expected ev3:// writeFile to fail as read-only/offline.'
		);
	}
	assert.equal(writeFailed, true, 'ev3:// writeFile should fail without active connection.');
}

async function testMockConnectFlowWiresActiveFsProvider(): Promise<void> {
	await withWorkspaceSettings(
		{
			'transport.mode': 'mock'
		},
		async () => {
			await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3');
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			await vscode.commands.executeCommand('ev3-cockpit.emergencyStop');
			await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');

			const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
			let failed = false;
			try {
				await vscode.workspace.fs.readDirectory(directoryUri);
			} catch (error) {
				failed = true;
				const message = error instanceof Error ? error.message : String(error);
				assert.match(
					message,
					/no active ev3 connection|execution failed|payload|reply|status|unexpected|list/i,
					'Expected provider to fail with either offline connection or protocol-layer error.'
				);
			}
			assert.equal(failed, true, 'Mock transport should not fully emulate FS listing yet.');
		}
	);
}

async function testProviderRejectsNonActiveBrickAuthority(): Promise<void> {
	await withWorkspaceSettings(
		{
			'transport.mode': 'mock'
		},
		async () => {
			await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
			await new Promise<void>((resolve) => setTimeout(resolve, 200));

			let failed = false;
			try {
				await vscode.workspace.fs.readDirectory(vscode.Uri.parse('ev3://brick-2/home/root/lms2012/prjs/'));
			} catch (error) {
				failed = true;
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /not available|brick/i);
			} finally {
				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
			}
			assert.equal(failed, true, 'Provider should reject non-active brick authority in current MVP.');
		}
	);
}

async function testTcpConnectFlowWithMockDiscoveryAndServer(): Promise<void> {
	const fakeServer = await startFakeEv3TcpServer();
	const discoveryPort = 33000 + Math.floor(Math.random() * 1000);
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
				const tcpBrickId = `tcp-${toSafeIdentifierForTest('active:5555')}`;
				await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
				await waitForCondition(
					'tcp connect should accept at least one socket',
					() => fakeServer.getAcceptedConnectionCount() >= 1,
					6_000
				);
				await new Promise<void>((resolve) => setTimeout(resolve, 300));

				const selectedBrickRoot = {
					kind: 'brick',
					brickId: tcpBrickId,
					displayName: 'EV3 TCP (active)',
					role: 'standalone',
					transport: 'tcp',
					status: 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/'
				};
				await vscode.commands.executeCommand('ev3-cockpit.stopProgram', selectedBrickRoot);
				await vscode.commands.executeCommand('ev3-cockpit.emergencyStop', selectedBrickRoot);
				await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', selectedBrickRoot);
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				await vscode.commands.executeCommand('ev3-cockpit.emergencyStop', selectedBrickRoot);

				const rootUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
				const explicitRootUri = vscode.Uri.parse(`ev3://${tcpBrickId}/home/root/lms2012/prjs/`);
				const sourceUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-source.txt');
				const copyUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-copy.txt');
				const renamedUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-renamed.txt');
				const sourceDirUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir');
				const sourceDirFileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir/nested.txt');
				const copiedDirUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-copy');
				const copiedDirFileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-copy/nested.txt');
				const renamedDirUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-renamed');
				const renamedDirFileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-renamed/nested.txt');
				const blockedUri = vscode.Uri.parse('ev3://active/etc/');

				const explicitListing = await vscode.workspace.fs.readDirectory(explicitRootUri);
				assert.ok(Array.isArray(explicitListing));

				await vscode.workspace.fs.writeFile(sourceUri, Buffer.from('host-suite-data', 'utf8'));
				const readBack = await vscode.workspace.fs.readFile(sourceUri);
				assert.equal(Buffer.from(readBack).toString('utf8'), 'host-suite-data');

				await vscode.workspace.fs.copy(sourceUri, copyUri, { overwrite: false });
				await vscode.workspace.fs.rename(copyUri, renamedUri, { overwrite: false });

				const listingBeforeDelete = await vscode.workspace.fs.readDirectory(rootUri);
				assert.ok(listingBeforeDelete.some(([name]) => name === 'host-suite-source.txt'));
				assert.ok(listingBeforeDelete.some(([name]) => name === 'host-suite-renamed.txt'));

				await vscode.workspace.fs.createDirectory(sourceDirUri);
				await vscode.workspace.fs.writeFile(sourceDirFileUri, Buffer.from('host-suite-dir-data', 'utf8'));
				await vscode.workspace.fs.copy(sourceDirUri, copiedDirUri, { overwrite: false });
				const copiedDirData = await vscode.workspace.fs.readFile(copiedDirFileUri);
				assert.equal(Buffer.from(copiedDirData).toString('utf8'), 'host-suite-dir-data');

				await vscode.workspace.fs.rename(copiedDirUri, renamedDirUri, { overwrite: false });
				const renamedDirData = await vscode.workspace.fs.readFile(renamedDirFileUri);
				assert.equal(Buffer.from(renamedDirData).toString('utf8'), 'host-suite-dir-data');

				await assert.rejects(
					async () => {
						await vscode.workspace.fs.delete(renamedDirUri, { recursive: false, useTrash: false });
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not empty|permissions|not allowed|directory/i);
						return true;
					}
				);

				await vscode.workspace.fs.delete(renamedUri, { recursive: false, useTrash: false });
				await vscode.workspace.fs.delete(sourceUri, { recursive: false, useTrash: false });
				await vscode.workspace.fs.delete(renamedDirUri, { recursive: true, useTrash: false });
				await vscode.workspace.fs.delete(sourceDirUri, { recursive: true, useTrash: false });

				const listingAfterDelete = await vscode.workspace.fs.readDirectory(rootUri);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-source.txt'), false);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-renamed.txt'), false);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-dir'), false);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-dir-renamed'), false);

				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readDirectory(blockedUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /safe mode|outside safe roots|permissions|blocked/i);
						return true;
					}
				);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', selectedBrickRoot);

				const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
				try {
					await vscode.workspace.fs.readDirectory(directoryUri);
					assert.fail('ev3:// readDirectory should fail after disconnect.');
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					assert.match(
						message,
						/no active ev3 connection|execution failed|payload|reply|status|unexpected|list/i,
						'Expected provider to fail with either offline connection or protocol-layer error.'
					);
				}
			}
		);
	} finally {
		stopBeacon();
		await fakeServer.close();
	}
}

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
						await fs.mkdir(path.join(workspaceFsPath, 'docs'), {
							recursive: true
						});
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
							await assert.rejects(
								async () => {
									await vscode.workspace.fs.readDirectory(remoteProjectUri);
								},
								(error: unknown) => {
									const message = error instanceof Error ? error.message : String(error);
									assert.match(message, /not found|path not found|status|directory/i);
									return true;
								}
							);

							await vscode.commands.executeCommand('ev3-cockpit.deployWorkspace');

							const deployedProgramV1 = await vscode.workspace.fs.readFile(remoteProgramUri);
							assert.deepEqual(Array.from(deployedProgramV1), [0x01, 0x02, 0x03, 0x04]);
							const deployedNotesV1 = await vscode.workspace.fs.readFile(remoteNotesUri);
							assert.equal(Buffer.from(deployedNotesV1).toString('utf8'), 'workspace-v1\n');

							await fs.writeFile(path.join(workspaceUri.fsPath, 'main.rbf'), Buffer.from([0x05, 0x06, 0x07, 0x08]));
							await fs.writeFile(path.join(workspaceUri.fsPath, 'docs', 'notes.txt'), 'workspace-v2\n', 'utf8');

							const runCountBefore = fakeServer.getRunProgramCommandCount();
							await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutable');
							const runCountAfter = fakeServer.getRunProgramCommandCount();
							assert.ok(
								runCountAfter > runCountBefore,
								'Expected deployWorkspaceAndRunExecutable to send at least one direct run command.'
							);

							const deployedProgramV2 = await vscode.workspace.fs.readFile(remoteProgramUri);
							assert.deepEqual(Array.from(deployedProgramV2), [0x05, 0x06, 0x07, 0x08]);
							const deployedNotesV2 = await vscode.workspace.fs.readFile(remoteNotesUri);
							assert.equal(Buffer.from(deployedNotesV2).toString('utf8'), 'workspace-v2\n');

							await vscode.workspace.fs.delete(remoteProjectUri, {
								recursive: true,
								useTrash: false
							});
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
	assert.ok(workspaceFolder, 'Expected at least one workspace folder for multi-brick host test.');
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

				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readDirectory(brickAProjectUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not found|path not found|status|directory/i);
						return true;
					}
				);
				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickANode);

				const brickAProgramV1 = await vscode.workspace.fs.readFile(brickAProgramUri);
				assert.deepEqual(Array.from(brickAProgramV1), [0x10, 0x11, 0x12, 0x13]);
				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readFile(brickBProgramUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not found|path not found|status|file/i);
						return true;
					}
				);

				const runCountABefore = fakeServerA.getRunProgramCommandCount();
				const runCountBBefore = fakeServerB.getRunProgramCommandCount();
				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick', brickANode);
				assert.ok(
					fakeServerA.getRunProgramCommandCount() > runCountABefore,
					'Expected selected-brick deploy+run to target brick A.'
				);
				assert.equal(
					fakeServerB.getRunProgramCommandCount(),
					runCountBBefore,
					'Expected selected-brick deploy+run to not affect brick B.'
				);

				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickBNode);
				const brickBProgramV1 = await vscode.workspace.fs.readFile(brickBProgramUri);
				assert.deepEqual(Array.from(brickBProgramV1), [0x10, 0x11, 0x12, 0x13]);

				await vscode.workspace.fs.writeFile(brickAUniqueUri, Buffer.from('only-on-a', 'utf8'));
				const uniqueOnA = await vscode.workspace.fs.readFile(brickAUniqueUri);
				assert.equal(Buffer.from(uniqueOnA).toString('utf8'), 'only-on-a');
				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readFile(brickBUniqueUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not found|path not found|status|file/i);
						return true;
					}
				);

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
	assert.ok(workspaceFolder, 'Expected workspace folder for batch host test.');
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
					await assert.rejects(
						async () => {
							await vscode.workspace.fs.readFile(brickAProgramUri);
						},
						(error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							assert.match(message, /not found|path not found|status|file/i);
							return true;
						}
					);
					await assert.rejects(
						async () => {
							await vscode.workspace.fs.readFile(brickBProgramUri);
						},
						(error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							assert.match(message, /not found|path not found|status|file/i);
							return true;
						}
					);

					await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToReadyBricks', [brickAId, brickBId]);
					const brickAProgram = await vscode.workspace.fs.readFile(brickAProgramUri);
					const brickBProgram = await vscode.workspace.fs.readFile(brickBProgramUri);
					assert.deepEqual(Array.from(brickAProgram), [0x21, 0x22, 0x23, 0x24]);
					assert.deepEqual(Array.from(brickBProgram), [0x21, 0x22, 0x23, 0x24]);

					await fs.writeFile(localProgramPath, Buffer.from([0x31, 0x32, 0x33, 0x34]));
					const runCountABefore = fakeServerA.getRunProgramCommandCount();
					const runCountBBefore = fakeServerB.getRunProgramCommandCount();
					await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks', [brickAId]);
					assert.ok(
						fakeServerA.getRunProgramCommandCount() > runCountABefore,
						'Expected selected batch deploy+run to run on brick A.'
					);
					assert.equal(
						fakeServerB.getRunProgramCommandCount(),
						runCountBBefore,
						'Expected selected batch deploy+run to not run on brick B.'
					);

					const brickAProgramAfterRun = await vscode.workspace.fs.readFile(brickAProgramUri);
					const brickBProgramAfterRun = await vscode.workspace.fs.readFile(brickBProgramUri);
					assert.deepEqual(Array.from(brickAProgramAfterRun), [0x31, 0x32, 0x33, 0x34]);
					assert.deepEqual(Array.from(brickBProgramAfterRun), [0x21, 0x22, 0x23, 0x24]);

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

async function testConfigChangeReconnectPromptBranchesWithMockTcp(): Promise<void> {
	const fakeServerA = await startFakeEv3TcpServer();
	const fakeServerB = await startFakeEv3TcpServer();

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '127.0.0.1',
				'transport.tcp.useDiscovery': false,
				'transport.tcp.handshakeTimeoutMs': 3000,
				'transport.tcp.port': fakeServerA.port
			},
			async () => {
				const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
				const activeRootUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');

				await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
				await new Promise<void>((resolve) => setTimeout(resolve, 500));
				await vscode.workspace.fs.readDirectory(activeRootUri);
				assert.ok(
					fakeServerA.getAcceptedConnectionCount() >= 1,
					'Expected initial tcp connect to open at least one socket on server A.'
				);

				const deferredPrompt = await withReconnectPromptChoice('Later', async () => {
					await cfg.update('transport.tcp.port', fakeServerB.port, vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
				});
				assert.equal(
					deferredPrompt.promptCount,
					1,
					'Expected reconnect prompt to appear once when relevant transport config changes.'
				);
				assert.equal(
					fakeServerB.getAcceptedConnectionCount(),
					0,
					'Expected Later choice to keep existing session without reconnecting to new endpoint.'
				);
				await vscode.workspace.fs.readDirectory(activeRootUri);

				const reconnectPrompt = await withReconnectPromptChoice('Reconnect all', async () => {
					await cfg.update('transport.tcp.host', 'localhost', vscode.ConfigurationTarget.Workspace);
					await waitForCondition(
						'reconnect all should open socket on server B',
						() => fakeServerB.getAcceptedConnectionCount() >= 1,
						6_000
					);
				});
				assert.equal(reconnectPrompt.promptCount, 1, 'Expected reconnect prompt to appear once for reconnect-all branch.');
				await vscode.workspace.fs.readDirectory(activeRootUri);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
				await new Promise<void>((resolve) => setTimeout(resolve, 300));
			}
		);
	} finally {
		await fakeServerA.close();
		await fakeServerB.close();
	}
}

/**
 * Regression test: workspace settings must be fully isolated between tests.
 * Sets a non-baseline key, then verifies `resetWorkspaceSettings` clears it.
 * This prevents the stale-settings bug where `transport.tcp.port` leaked from
 * one run into the next, causing brick-ID mismatches.
 */
async function testWorkspaceSettingsIsolation(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	const poisonKey = 'transport.tcp.port';
	const poisonValue = 99999;

	await cfg.update(poisonKey, poisonValue, vscode.ConfigurationTarget.Workspace);
	const before = cfg.inspect(poisonKey);
	assert.equal(
		before?.workspaceValue,
		poisonValue,
		'Poison value should be present in workspace config before reset.'
	);

	await resetWorkspaceSettings();

	const after = cfg.inspect(poisonKey);
	assert.equal(
		after?.workspaceValue,
		undefined,
		'Poison key must be cleared by resetWorkspaceSettings — stale settings leaked to subsequent tests.'
	);

	const mode = cfg.inspect('transport.mode');
	assert.equal(
		mode?.workspaceValue,
		'mock',
		'Baseline key transport.mode must be restored by resetWorkspaceSettings.'
	);
}

/**
 * Regression test: `toSafeIdentifierForTest` must match the extension's
 * `toSafeIdentifier` for every endpoint pattern the tests use.
 * A mismatch here causes "Brick not registered" errors because the test
 * looks up the brick under one ID while the extension registered it under
 * another.
 */
async function testBrickIdConsistencyWithExtension(): Promise<void> {
	const endpoints = [
		'active:5555',
		'127.0.0.1:12345',
		'192.168.1.100:5555',
		'localhost:5555',
		'MY-BRICK:5555',
		'  spaced : 80  ',
		'UPPER.CASE:9999'
	];

	for (const endpoint of endpoints) {
		const testId = toSafeIdentifierForTest(endpoint);
		assert.ok(testId.length > 0, `toSafeIdentifierForTest should produce non-empty ID for "${endpoint}".`);
		assert.ok(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(testId),
			`toSafeIdentifierForTest("${endpoint}") = "${testId}" must be lowercase alphanumeric with dashes, no leading/trailing dashes.`
		);
	}

	// Verify the critical test-used endpoint produces the expected brick ID
	assert.equal(
		`tcp-${toSafeIdentifierForTest('active:5555')}`,
		'tcp-active-5555',
		'Brick ID for default tcp endpoint must be tcp-active-5555.'
	);
}

async function testCommandsWithoutHardware(): Promise<void> {
	await withWorkspaceSettings(
		{
			'transport.mode': 'mock',
			'transport.timeoutMs': 200
		},
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
			assert.ok(workspaceFolder, 'Expected workspace folder for diagnostics report verification.');
			const diagnosticsReportPath = path.join(
				workspaceFolder.uri.fsPath,
				'artifacts',
				'diagnostics',
				'brick-sessions-report.json'
			);
			const diagnosticsReportRaw = await fs.readFile(diagnosticsReportPath, 'utf8');
			const diagnosticsReport = JSON.parse(diagnosticsReportRaw) as {
				generatedAtIso?: string;
				bricks?: unknown[];
				runtimeSessions?: unknown[];
			};
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

export async function run(): Promise<void> {
	await waitForCondition(
		'extension registration',
		() => vscode.extensions.getExtension(EXTENSION_ID) !== undefined
	);

	await resetWorkspaceSettings();

	const cases: Array<[string, () => Promise<void>]> = [
		['activation', testActivation],
		['brick panel view contribution', testBrickPanelViewContribution],
		['commands registration', testCommandsRegistration],
		['workspace settings isolation', testWorkspaceSettingsIsolation],
		['brick id consistency with extension', testBrickIdConsistencyWithExtension],
		['commands without hardware', testCommandsWithoutHardware],
		['ev3 filesystem provider offline', testEv3FileSystemProvider],
		['mock connect flow wires active fs provider', testMockConnectFlowWiresActiveFsProvider],
		['provider rejects non-active brick authority', testProviderRejectsNonActiveBrickAuthority],
		['tcp connect flow with mock discovery and server', testTcpConnectFlowWithMockDiscoveryAndServer],
		['workspace deploy commands with mock tcp', testWorkspaceDeployCommandsWithMockTcp],
		['config reconnect prompt branches with mock tcp', testConfigChangeReconnectPromptBranchesWithMockTcp],
		['multi-brick selected deploy commands with mock tcp', testMultiBrickSelectedDeployCommandsWithMockTcp],
		['batch commands with multi-brick mock tcp', testBatchCommandsWithMultiBrickMockTcp],
	];

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
