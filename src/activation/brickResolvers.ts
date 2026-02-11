import * as vscode from 'vscode';
import * as path from 'node:path';
import { BrickControlService } from '../device/brickControlService';
import { BrickRegistry, BrickRole } from '../device/brickRegistry';
import { Logger } from '../diagnostics/logger';
import { readFeatureConfig } from '../config/featureConfig';
import { readSchedulerConfig } from '../config/schedulerConfig';
import { assertRemoteExecutablePath } from '../fs/remoteExecutable';
import { RemoteFsService } from '../fs/remoteFsService';
import { TransportMode } from '../transport/transportFactory';
import { DeployTargetContext } from '../commands/deployTypes';
import { isBrickRootNode, isBrickDirectoryNode, isBrickFileNode } from '../ui/brickTreeProvider';
import { ConnectedBrickDescriptor, normalizeBrickRootPath, toSafeIdentifier } from './helpers';
import { BrickConnectionProfile } from '../device/brickConnectionProfiles';

export interface BrickResolvers {
	resolveProbeTimeoutMs(): number;
	resolveCurrentTransportMode(): TransportMode | 'unknown';
	resolveConnectedBrickDescriptor(rootPath: string, profile?: BrickConnectionProfile): ConnectedBrickDescriptor;
	resolveConcreteBrickId(brickId: string): string;
	resolveBrickIdFromCommandArg(arg: unknown): string;
	resolveFsAccessContext(arg: unknown): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string };
	resolveControlAccessContext(arg: unknown): { brickId: string; authority: string; controlService: BrickControlService } | { error: string };
	resolveDeployTargetFromArg(arg: unknown): DeployTargetContext | { error: string };
	normalizeRunExecutablePath(input: string): string;
	resolveDefaultRunDirectory(brickId: string): string;
	resolveFsModeTarget(): vscode.ConfigurationTarget;
	ensureFullFsModeConfirmation(): Promise<boolean>;
}

/** Default Bluetooth probe timeout (ms); longer than USB/TCP due to pairing variability. */
const DEFAULT_BT_PROBE_TIMEOUT_MS = 8_000;

/** Default EV3 TCP communication port (LEGO standard). */
const DEFAULT_TCP_PORT = 5555;

function normalizeBrickNameCandidate(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.length > 12) {
		return undefined;
	}
	return trimmed;
}

export function createBrickResolvers(deps: {
	brickRegistry: BrickRegistry;
	getLogger: () => Logger;
}): BrickResolvers {
	const resolveProbeTimeoutMs = (): number => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const modeRaw = cfg.get('transport.mode');
		const mode: TransportMode =
			modeRaw === 'usb' || modeRaw === 'bluetooth' || modeRaw === 'tcp' || modeRaw === 'mock' || modeRaw === 'auto'
				? modeRaw
				: 'auto';

		const base = readSchedulerConfig().timeoutMs;
		const btProbeRaw = cfg.get('transport.bluetooth.probeTimeoutMs');
		const btProbe =
			typeof btProbeRaw === 'number' && Number.isFinite(btProbeRaw) ? Math.max(50, Math.floor(btProbeRaw)) : DEFAULT_BT_PROBE_TIMEOUT_MS;

		if (mode === 'bluetooth') {
			return Math.max(base, btProbe);
		}

		return base;
	};

	const resolveFsModeTarget = (): vscode.ConfigurationTarget => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const inspected = cfg.inspect('fs.mode');
		if (inspected?.workspaceFolderValue !== undefined) {
			return vscode.ConfigurationTarget.WorkspaceFolder;
		}
		if (inspected?.workspaceValue !== undefined) {
			return vscode.ConfigurationTarget.Workspace;
		}
		return vscode.ConfigurationTarget.Global;
	};

	const ensureFullFsModeConfirmation = async (): Promise<boolean> => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get('fs.mode');
		const confirmationRequired = cfg.get('fs.fullMode.confirmationRequired', true);
		if (mode !== 'full' || !confirmationRequired) {
			return true;
		}

		const choice = await vscode.window.showWarningMessage(
			'Full EV3 filesystem mode allows risky operations outside safe roots. Continue?',
			{ modal: true },
			'Enable Full Mode'
		);
		if (choice === 'Enable Full Mode') {
			deps.getLogger().info('Full filesystem mode explicitly confirmed by user.');
			return true;
		}

		await cfg.update('fs.mode', 'safe', resolveFsModeTarget());
		deps.getLogger().warn('Full filesystem mode rejected by user; reverted to safe mode.');
		return false;
	};

	const normalizeRunExecutablePath = (input: string): string => {
		const trimmed = input.trim();
		if (!trimmed) {
			throw new Error('Executable path must not be empty.');
		}

		let candidate = trimmed;
		if (candidate.toLowerCase().startsWith('ev3://')) {
			const parsed = vscode.Uri.parse(candidate);
			candidate = parsed.path;
		}

		const normalized = path.posix.normalize(candidate.startsWith('/') ? candidate : `/${candidate}`);
		assertRemoteExecutablePath(normalized);
		return normalized;
	};

	const resolveCurrentTransportMode = (): TransportMode | 'unknown' => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get('transport.mode');
		return mode === 'auto' || mode === 'usb' || mode === 'bluetooth' || mode === 'tcp' || mode === 'mock'
			? mode
			: 'unknown';
	};

	const resolveConnectedBrickDescriptor = (rootPath: string, profile?: BrickConnectionProfile): ConnectedBrickDescriptor => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const transport = profile?.transport.mode ?? resolveCurrentTransportMode();
		const normalizedRootPath = normalizeBrickRootPath(profile?.rootPath ?? rootPath);
		const role: BrickRole = 'standalone';
		const profileDisplayName = normalizeBrickNameCandidate(profile?.displayName);

		if (transport === 'tcp') {
			const hostRaw = profile?.transport.tcpHost ?? cfg.get('transport.tcp.host');
			const host = typeof hostRaw === 'string' && hostRaw.trim().length > 0 ? hostRaw.trim() : 'active';
			const portRaw = profile?.transport.tcpPort ?? cfg.get('transport.tcp.port');
			const port = typeof portRaw === 'number' && Number.isFinite(portRaw) ? Math.max(1, Math.floor(portRaw)) : DEFAULT_TCP_PORT;
			const endpoint = `${host}:${port}`;
			const fallbackDisplayName = `EV3 TCP (${endpoint})`;
			return {
				brickId: `tcp-${toSafeIdentifier(endpoint)}`,
				displayName: profileDisplayName ?? fallbackDisplayName,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'bluetooth') {
			const portRaw = profile?.transport.bluetoothPort ?? cfg.get('transport.bluetooth.port');
			const port = typeof portRaw === 'string' && portRaw.trim().length > 0 ? portRaw.trim() : 'auto';
			const fallbackDisplayName = `EV3 Bluetooth (${port})`;
			return {
				brickId: `bluetooth-${toSafeIdentifier(port)}`,
				displayName: profileDisplayName ?? fallbackDisplayName,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'usb') {
			const pathRaw = profile?.transport.usbPath ?? cfg.get('transport.usb.path');
			const usbPath = typeof pathRaw === 'string' && pathRaw.trim().length > 0 ? pathRaw.trim() : 'auto';
			const fallbackDisplayName = `EV3 USB (${usbPath})`;
			return {
				brickId: `usb-${toSafeIdentifier(usbPath)}`,
				displayName: profileDisplayName ?? fallbackDisplayName,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'mock') {
			return {
				brickId: 'mock-active',
				displayName: profileDisplayName ?? 'EV3 Mock',
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		return {
			brickId: 'auto-active',
			displayName: profileDisplayName ?? 'EV3 (Auto)',
			role,
			transport,
			rootPath: normalizedRootPath
		};
	};

	const resolveConcreteBrickId = (brickId: string): string =>
		brickId === 'active' ? deps.brickRegistry.getActiveBrickId() ?? 'active' : brickId;

	const resolveBrickIdFromCommandArg = (arg: unknown): string => {
		if (typeof arg === 'string' && arg.trim().length > 0) {
			return arg.trim();
		}
		if (isBrickRootNode(arg)) {
			return arg.brickId;
		}
		if (isBrickDirectoryNode(arg) || isBrickFileNode(arg)) {
			return arg.brickId;
		}
		return 'active';
	};

	const resolveFsAccessContext = (
		arg: unknown
	): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string } => {
		const requestedBrickId = resolveBrickIdFromCommandArg(arg);
		const authority = requestedBrickId === 'active' ? 'active' : requestedBrickId;
		const fsService = deps.brickRegistry.resolveFsService(requestedBrickId);
		if (!fsService) {
			const snapshot = requestedBrickId === 'active' ? undefined : deps.brickRegistry.getSnapshot(requestedBrickId);
			if (snapshot) {
				return {
					error: `Brick "${requestedBrickId}" is currently ${snapshot.status.toLowerCase()}.`
				};
			}
			return {
				error:
					requestedBrickId === 'active'
						? 'No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.'
						: `Brick "${requestedBrickId}" is not connected.`
			};
		}

		const brickId = requestedBrickId === 'active' ? deps.brickRegistry.getActiveBrickId() ?? 'active' : requestedBrickId;
		return {
			brickId,
			authority,
			fsService
		};
	};

	const resolveControlAccessContext = (
		arg: unknown
	): { brickId: string; authority: string; controlService: BrickControlService } | { error: string } => {
		const requestedBrickId = resolveBrickIdFromCommandArg(arg);
		const authority = requestedBrickId === 'active' ? 'active' : requestedBrickId;
		const controlService = deps.brickRegistry.resolveControlService(requestedBrickId);
		if (!controlService) {
			const snapshot = requestedBrickId === 'active' ? undefined : deps.brickRegistry.getSnapshot(requestedBrickId);
			if (snapshot) {
				return {
					error: `Brick "${requestedBrickId}" is currently ${snapshot.status.toLowerCase()}.`
				};
			}
			return {
				error:
					requestedBrickId === 'active'
						? 'No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.'
						: `Brick "${requestedBrickId}" is not connected.`
			};
		}

		const brickId = requestedBrickId === 'active' ? deps.brickRegistry.getActiveBrickId() ?? 'active' : requestedBrickId;
		return {
			brickId,
			authority,
			controlService
		};
	};

	const resolveDeployTargetFromArg = (arg: unknown): DeployTargetContext | { error: string } => {
		const fsContext = resolveFsAccessContext(arg);
		if ('error' in fsContext) {
			return fsContext;
		}

		const rootPath =
			isBrickRootNode(arg)
				? arg.rootPath
				: isBrickDirectoryNode(arg)
				? arg.remotePath
				: deps.brickRegistry.getSnapshot(fsContext.brickId)?.rootPath;

		return {
			brickId: fsContext.brickId,
			authority: fsContext.authority,
			rootPath,
			fsService: fsContext.fsService
		};
	};

	const resolveDefaultRunDirectory = (brickId: string): string => {
		const concreteBrickId = resolveConcreteBrickId(brickId);
		const snapshot = deps.brickRegistry.getSnapshot(concreteBrickId);
		if (snapshot?.rootPath) {
			return snapshot.rootPath;
		}
		const defaultRoot = readFeatureConfig().fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
		return normalizeBrickRootPath(defaultRoot);
	};

	return {
		resolveProbeTimeoutMs,
		resolveCurrentTransportMode,
		resolveConnectedBrickDescriptor,
		resolveConcreteBrickId,
		resolveBrickIdFromCommandArg,
		resolveFsAccessContext,
		resolveControlAccessContext,
		resolveDeployTargetFromArg,
		normalizeRunExecutablePath,
		resolveDefaultRunDirectory,
		resolveFsModeTarget,
		ensureFullFsModeConfirmation
	};
}
