import * as vscode from 'vscode';
import { BrickRegistry } from '../device/brickRegistry';
import { Logger } from '../diagnostics/logger';

interface BatchCommandOptions {
	getLogger(): Logger;
	getBrickRegistry(): BrickRegistry;
}

interface BatchCommandRegistrations {
	reconnectReadyBricks: vscode.Disposable;
	deployWorkspaceToReadyBricks: vscode.Disposable;
}

export function registerBatchCommands(options: BatchCommandOptions): BatchCommandRegistrations {
	const reconnectReadyBricks = vscode.commands.registerCommand('ev3-cockpit.reconnectReadyBricks', async () => {
		const logger = options.getLogger();
		const readyBricks = options
			.getBrickRegistry()
			.listSnapshots()
			.filter((entry) => entry.status === 'READY');
		if (readyBricks.length === 0) {
			vscode.window.showInformationMessage('No ready bricks available for batch reconnect.');
			return;
		}

		for (const brick of readyBricks) {
			try {
				await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', brick.brickId);
			} catch (error) {
				logger.warn('Batch reconnect failed for brick', {
					brickId: brick.brickId,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}

		vscode.window.showInformationMessage(`Batch reconnect finished for ${readyBricks.length} brick(s).`);
	});

	const deployWorkspaceToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceToReadyBricks',
		async () => {
			const logger = options.getLogger();
			const readyBricks = options
				.getBrickRegistry()
				.listSnapshots()
				.filter((entry) => entry.status === 'READY');
			if (readyBricks.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace deploy.');
				return;
			}

			for (const brick of readyBricks) {
				try {
					await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brick.brickId);
				} catch (error) {
					logger.warn('Batch workspace deploy failed for brick', {
						brickId: brick.brickId,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}

			vscode.window.showInformationMessage(`Batch workspace deploy finished for ${readyBricks.length} brick(s).`);
		}
	);

	return {
		reconnectReadyBricks,
		deployWorkspaceToReadyBricks
	};
}
