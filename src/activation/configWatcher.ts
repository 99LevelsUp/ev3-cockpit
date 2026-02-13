import * as vscode from 'vscode';
import { captureConnectionProfileFromWorkspace, BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import { BrickRegistry } from '../device/brickRegistry';
import { BrickSessionManager } from '../device/brickSessionManager';
import { Logger } from '../diagnostics/logger';
import { toErrorMessage } from '../commands/commandUtils';

export const RUNTIME_RECONNECT_CONFIG_KEYS = [
	'ev3-cockpit.transport.mode',
	'ev3-cockpit.transport.usb.path',
	'ev3-cockpit.transport.bluetooth.port',
	'ev3-cockpit.transport.tcp.host',
	'ev3-cockpit.transport.tcp.port',
	'ev3-cockpit.compat.profile'
] as const;

export function createConfigWatcher(deps: {
	getLogger: () => Logger;
	brickRegistry: BrickRegistry;
	sessionManager: BrickSessionManager<any, any, any>;
	profileStore: BrickConnectionProfileStore;
	ensureFullFsModeConfirmation: () => Promise<boolean>;
	resolveMockDiscoveryEnabled?: () => boolean;
	onMockDiscoveryChanged?: (enabled: boolean) => Promise<void> | void;
}): vscode.Disposable {
	let reconnectPromptInFlight = false;
	const affectsRuntimeReconnectConfig = (event: vscode.ConfigurationChangeEvent): boolean => {
		return RUNTIME_RECONNECT_CONFIG_KEYS.some((section) => event.affectsConfiguration(section));
	};
	const offerReconnectAfterConfigChange = async (): Promise<void> => {
		if (reconnectPromptInFlight) {
			return;
		}

		const connectedBrickIds = deps.brickRegistry
			.listSnapshots()
			.filter((snapshot) => snapshot.status === 'READY' && deps.sessionManager.isSessionAvailable(snapshot.brickId))
			.map((snapshot) => snapshot.brickId);
		if (connectedBrickIds.length === 0) {
			return;
		}

		reconnectPromptInFlight = true;
		try {
			const choice = await vscode.window.showInformationMessage(
				`Connection settings changed. Reconnect ${connectedBrickIds.length} brick(s) now to apply them?`,
				'Reconnect all',
				'Later'
			);
			if (choice !== 'Reconnect all') {
				deps.getLogger().info('Reconnect prompt after configuration change was deferred by user.', {
					brickIds: connectedBrickIds
				});
				return;
			}

			deps.getLogger().info('Reconnect all requested after configuration change.', {
				brickIds: connectedBrickIds
			});
			for (const brickId of connectedBrickIds) {
				try {
					const snapshot = deps.brickRegistry.getSnapshot(brickId);
					if (snapshot) {
						const updatedProfile = captureConnectionProfileFromWorkspace(
							brickId,
							snapshot.displayName,
							snapshot.rootPath
						);
						await deps.profileStore.upsert(updatedProfile);
					}
					await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', brickId);
				} catch (error) {
					deps.getLogger().warn('Reconnect after configuration change failed.', {
						brickId,
						error: toErrorMessage(error)
					});
				}
			}
		} finally {
			reconnectPromptInFlight = false;
		}
	};

	return vscode.workspace.onDidChangeConfiguration((event) => {
		void (async () => {
			if (event.affectsConfiguration('ev3-cockpit.fs.mode') || event.affectsConfiguration('ev3-cockpit.fs.fullMode.confirmationRequired')) {
				const confirmed = await deps.ensureFullFsModeConfirmation();
				if (!confirmed) {
					return;
				}
			}

			if (
				deps.onMockDiscoveryChanged
				&& deps.resolveMockDiscoveryEnabled
				&& (event.affectsConfiguration('ev3-cockpit.mock') || event.affectsConfiguration('ev3-cockpit.ui.discovery.showMockBricks'))
			) {
				await deps.onMockDiscoveryChanged(deps.resolveMockDiscoveryEnabled());
			}

			if (event.affectsConfiguration('ev3-cockpit')) {
				deps.getLogger().info('EV3 Cockpit configuration changed. Existing brick sessions stay online; new connections use updated settings.');
				if (affectsRuntimeReconnectConfig(event)) {
					await offerReconnectAfterConfigChange();
				}
			}
		})();
	});
}
