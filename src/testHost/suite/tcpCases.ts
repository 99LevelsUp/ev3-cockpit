/**
 * TCP transport integration test cases with fake EV3 server.
 *
 * @packageDocumentation
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { HostTestCase } from './hostTestCases';
import { startFakeDiscoveryBeacon, startFakeEv3TcpServer } from './fakeEv3Server';
import {
	toSafeIdentifierForTest,
	waitForAsyncCondition,
	waitForCondition,
	withReconnectPromptChoice,
	withWorkspaceSettings
} from './testInfrastructure';

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
				await waitForAsyncCondition(
					'tcp connect should restore explicit brick filesystem access',
					async () => {
						try {
							await vscode.workspace.fs.readDirectory(vscode.Uri.parse(`ev3://${tcpBrickId}/home/root/lms2012/prjs/`));
							return true;
						} catch {
							return false;
						}
					},
					6_000
				);

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

				assert.ok(Array.isArray(await vscode.workspace.fs.readDirectory(explicitRootUri)));
				await vscode.workspace.fs.writeFile(sourceUri, Buffer.from('host-suite-data', 'utf8'));
				assert.equal(Buffer.from(await vscode.workspace.fs.readFile(sourceUri)).toString('utf8'), 'host-suite-data');

				await vscode.workspace.fs.copy(sourceUri, copyUri, { overwrite: false });
				await vscode.workspace.fs.rename(copyUri, renamedUri, { overwrite: false });

				const listingBeforeDelete = await vscode.workspace.fs.readDirectory(rootUri);
				assert.ok(listingBeforeDelete.some(([name]) => name === 'host-suite-source.txt'));
				assert.ok(listingBeforeDelete.some(([name]) => name === 'host-suite-renamed.txt'));

				await vscode.workspace.fs.createDirectory(sourceDirUri);
				await vscode.workspace.fs.writeFile(sourceDirFileUri, Buffer.from('host-suite-dir-data', 'utf8'));
				await vscode.workspace.fs.copy(sourceDirUri, copiedDirUri, { overwrite: false });
				assert.equal(Buffer.from(await vscode.workspace.fs.readFile(copiedDirFileUri)).toString('utf8'), 'host-suite-dir-data');
				await vscode.workspace.fs.rename(copiedDirUri, renamedDirUri, { overwrite: false });
				assert.equal(Buffer.from(await vscode.workspace.fs.readFile(renamedDirFileUri)).toString('utf8'), 'host-suite-dir-data');

				await assert.rejects(
					async () => await vscode.workspace.fs.delete(renamedDirUri, { recursive: false, useTrash: false }),
					/not empty|permissions|not allowed|directory/i
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

				await assert.rejects(async () => await vscode.workspace.fs.readDirectory(blockedUri), /safe mode|outside safe roots|permissions|blocked/i);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', selectedBrickRoot);
				await assert.rejects(
					async () => await vscode.workspace.fs.readDirectory(vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/')),
					/no active ev3 connection|execution failed|payload|reply|status|unexpected|list/i
				);
			}
		);
	} finally {
		stopBeacon();
		await fakeServer.close();
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
				assert.ok(fakeServerA.getAcceptedConnectionCount() >= 1);

				const deferredPrompt = await withReconnectPromptChoice('Later', async () => {
					await cfg.update('transport.tcp.port', fakeServerB.port, vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
				});
				assert.equal(deferredPrompt.promptCount, 1);
				assert.equal(fakeServerB.getAcceptedConnectionCount(), 0);
				await vscode.workspace.fs.readDirectory(activeRootUri);

				const reconnectPrompt = await withReconnectPromptChoice('Reconnect all', async () => {
					await cfg.update('transport.tcp.host', 'localhost', vscode.ConfigurationTarget.Workspace);
					await waitForCondition(
						'reconnect all should open socket on server B',
						() => fakeServerB.getAcceptedConnectionCount() >= 1,
						6_000
					);
					await waitForAsyncCondition(
						'reconnect all should restore active filesystem access',
						async () => {
							try {
								await vscode.workspace.fs.readDirectory(activeRootUri);
								return true;
							} catch {
								return false;
							}
						},
						6_000
					);
				});
				assert.equal(reconnectPrompt.promptCount, 1);
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

export const TCP_HOST_TEST_CASES: HostTestCase[] = [
	['tcp connect flow with mock discovery and server', testTcpConnectFlowWithMockDiscoveryAndServer],
	['config reconnect prompt branches with mock tcp', testConfigChangeReconnectPromptBranchesWithMockTcp]
];
