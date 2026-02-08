import * as vscode from 'vscode';
import { buildCapabilityProfile } from '../compat/capabilityProfile';
import { readFeatureConfig } from '../config/featureConfig';
import { BrickControlService } from '../device/brickControlService';
import { BrickRegistry } from '../device/brickRegistry';
import { Logger } from '../diagnostics/logger';
import { RemoteFsService } from '../fs/remoteFsService';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { BrickTreeProvider } from '../ui/brickTreeProvider';
import { TransportMode } from '../transport/transportFactory';
import { BrickRole } from '../device/brickRegistry';

interface ConnectedBrickDescriptor {
	brickId: string;
	displayName: string;
	role: BrickRole;
	transport: TransportMode | 'unknown';
	rootPath: string;
}

interface ConnectCommandOptions {
	getCommandClient(): Ev3CommandClient;
	getLogger(): Logger;
	getBrickRegistry(): BrickRegistry;
	getTreeProvider(): BrickTreeProvider;
	clearProgramSession(reason: string): void;
	resolveProbeTimeoutMs(): number;
	resolveConnectedBrickDescriptor(rootPath: string): ConnectedBrickDescriptor;
}

interface ConnectCommandRegistrations {
	connect: vscode.Disposable;
	disconnect: vscode.Disposable;
	reconnect: vscode.Disposable;
}

export function registerConnectCommands(options: ConnectCommandOptions): ConnectCommandRegistrations {
	const connect = vscode.commands.registerCommand('ev3-cockpit.connectEV3', async () => {
		vscode.window.showInformationMessage('Connecting to EV3 brick...');
		const activeClient = options.getCommandClient();
		const activeLogger = options.getLogger();
		const brickRegistry = options.getBrickRegistry();
		const treeProvider = options.getTreeProvider();
		let keepConnectionOpen = false;

		try {
			options.clearProgramSession('connect-start');
			brickRegistry.markActiveUnavailable('Connection reset before reconnect.');
			const connectingRoot = readFeatureConfig().fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
			brickRegistry.upsertConnecting(options.resolveConnectedBrickDescriptor(connectingRoot));
			treeProvider.refreshThrottled();
			await activeClient.close().catch(() => undefined);
			await activeClient.open();
			const probeCommand = 0x9d; // LIST_OPEN_HANDLES
			const result = await activeClient.send({
				id: 'connect-probe',
				lane: 'high',
				idempotent: true,
				timeoutMs: options.resolveProbeTimeoutMs(),
				type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
				payload: new Uint8Array([probeCommand])
			});
			const replyType = result.reply.type;
			const isSystemReply = replyType === EV3_REPLY.SYSTEM_REPLY || replyType === EV3_REPLY.SYSTEM_REPLY_ERROR;
			if (!isSystemReply) {
				throw new Error(`Unexpected probe reply type 0x${replyType.toString(16)}.`);
			}

			if (result.reply.payload.length < 2) {
				throw new Error('Probe reply payload is too short.');
			}

			const echoedCommand = result.reply.payload[0];
			const status = result.reply.payload[1];
			if (echoedCommand !== probeCommand) {
				throw new Error(
					`Probe reply command mismatch: expected 0x${probeCommand.toString(16)}, got 0x${echoedCommand.toString(16)}.`
				);
			}

			if (replyType === EV3_REPLY.SYSTEM_REPLY_ERROR || status !== 0x00) {
				throw new Error(`Probe reply returned status 0x${status.toString(16)}.`);
			}

			activeLogger.info('Connect probe completed', {
				requestId: result.requestId,
				lane: 'high',
				messageCounter: result.messageCounter,
				opcode: probeCommand,
				replyType,
				status,
				durationMs: result.durationMs,
				result: 'ok'
			});

			let capabilitySummary = '';
			const featureConfig = readFeatureConfig();
			let profile = buildCapabilityProfile(
				{
					osVersion: '',
					hwVersion: '',
					fwVersion: 'unknown',
					osBuild: '',
					fwBuild: ''
				},
				featureConfig.compatProfileMode
			);
			try {
				const capabilityResult = await activeClient.send({
					id: 'connect-capability',
					lane: 'high',
					idempotent: true,
					timeoutMs: options.resolveProbeTimeoutMs(),
					type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
					payload: buildCapabilityProbeDirectPayload()
				});
				if (capabilityResult.reply.type !== EV3_REPLY.DIRECT_REPLY) {
					throw new Error(`Unexpected capability reply type 0x${capabilityResult.reply.type.toString(16)}.`);
				}

				const capability = parseCapabilityProbeReply(capabilityResult.reply.payload);
				profile = buildCapabilityProfile(capability, featureConfig.compatProfileMode);
				activeLogger.info('Capability probe completed', {
					requestId: capabilityResult.requestId,
					lane: 'high',
					messageCounter: capabilityResult.messageCounter,
					durationMs: capabilityResult.durationMs,
					payloadBytes: capabilityResult.reply.payload.length,
					osVersion: capability.osVersion,
					hwVersion: capability.hwVersion,
					fwVersion: capability.fwVersion,
					osBuild: capability.osBuild,
					fwBuild: capability.fwBuild
				});
				activeLogger.info('Capability profile selected', {
					profileId: profile.id,
					firmwareFamily: profile.firmwareFamily,
					supportsContinueList: profile.supportsContinueList,
					uploadChunkBytes: profile.uploadChunkBytes,
					recommendedTimeoutMs: profile.recommendedTimeoutMs,
					fsMode: featureConfig.fs.mode,
					fsSafeRoots: featureConfig.fs.defaultRoots
				});

				if (capability.fwVersion || capability.fwBuild) {
					capabilitySummary = ` fw=${capability.fwVersion || '?'} (${capability.fwBuild || '?'})`;
				}
			} catch (capabilityError) {
				activeLogger.warn('Capability probe failed', {
					message: capabilityError instanceof Error ? capabilityError.message : String(capabilityError)
				});
				activeLogger.info('Capability profile selected (fallback)', {
					profileId: profile.id,
					firmwareFamily: profile.firmwareFamily,
					supportsContinueList: profile.supportsContinueList,
					uploadChunkBytes: profile.uploadChunkBytes,
					recommendedTimeoutMs: profile.recommendedTimeoutMs,
					fsMode: featureConfig.fs.mode,
					fsSafeRoots: featureConfig.fs.defaultRoots
				});
			}

			const connectedFsService = new RemoteFsService({
				commandClient: activeClient,
				capabilityProfile: profile,
				fsConfig: featureConfig.fs,
				defaultTimeoutMs: Math.max(options.resolveProbeTimeoutMs(), profile.recommendedTimeoutMs),
				logger: activeLogger
			});
			const connectedControlService = new BrickControlService({
				commandClient: activeClient,
				defaultTimeoutMs: Math.max(options.resolveProbeTimeoutMs(), profile.recommendedTimeoutMs),
				logger: activeLogger
			});
			const rootPath = featureConfig.fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
			const brickDescriptor = options.resolveConnectedBrickDescriptor(rootPath);
			brickRegistry.upsertReady({
				...brickDescriptor,
				fsService: connectedFsService,
				controlService: connectedControlService
			});
			keepConnectionOpen = true;
			activeLogger.info('Remote FS service ready', {
				scheme: 'ev3',
				brickId: brickDescriptor.brickId,
				mode: featureConfig.fs.mode
			});
			treeProvider.refreshThrottled();

			vscode.window.showInformationMessage(
				`EV3 connect probe completed (mc=${result.messageCounter})${capabilitySummary}. FS: ev3://active/`
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown scheduler error';
			activeLogger.error('Connect probe failed', { message });
			brickRegistry.markActiveUnavailable(message);
			treeProvider.refreshThrottled();
			vscode.window.showErrorMessage(`EV3 connect probe failed: ${message}`);
		} finally {
			if (!keepConnectionOpen) {
				await activeClient.close().catch((closeError: unknown) => {
					activeLogger.warn('Connect probe transport close failed', {
						error: closeError instanceof Error ? closeError.message : String(closeError)
					});
				});
			}
		}
	});

	const disconnect = vscode.commands.registerCommand('ev3-cockpit.disconnectEV3', async () => {
		const logger = options.getLogger();
		const brickRegistry = options.getBrickRegistry();
		const treeProvider = options.getTreeProvider();
		const commandClient = options.getCommandClient();

		try {
			const disconnectedBrickId = brickRegistry.getActiveBrickId();
			await commandClient.close();
			if (disconnectedBrickId) {
				brickRegistry.markUnavailable(disconnectedBrickId, 'Disconnected by user.');
			}
			treeProvider.refreshThrottled();
			options.clearProgramSession('disconnect-command');
			logger.info('Disconnected active EV3 session.');
			vscode.window.showInformationMessage('EV3 disconnected.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Disconnect failed', { message });
			vscode.window.showErrorMessage(`Disconnect failed: ${message}`);
		}
	});

	const reconnect = vscode.commands.registerCommand('ev3-cockpit.reconnectEV3', async () => {
		options.getLogger().info('Reconnect requested via command palette; delegating to connect flow.');
		await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
	});

	return { connect, disconnect, reconnect };
}
