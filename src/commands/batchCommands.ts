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
	const resolveRequestedBrickIds = async (arg: unknown): Promise<string[] | undefined> => {
		if (Array.isArray(arg)) {
			const ids = arg.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
			return ids.length > 0 ? ids : undefined;
		}
		if (typeof arg === 'string' && arg.trim().length > 0) {
			return [arg.trim()];
		}
		return undefined;
	};

	const selectReadyBrickIds = async (arg: unknown, actionLabel: string): Promise<string[]> => {
		const readyBricks = options
			.getBrickRegistry()
			.listSnapshots()
			.filter((entry) => entry.status === 'READY');
		if (readyBricks.length === 0) {
			return [];
		}

		const requestedBrickIds = await resolveRequestedBrickIds(arg);
		if (requestedBrickIds) {
			const allowed = new Set(readyBricks.map((entry) => entry.brickId));
			return requestedBrickIds.filter((brickId) => allowed.has(brickId));
		}

		const picks = readyBricks.map((entry) => ({
			label: entry.displayName,
			description: `${entry.transport} | ${entry.role}`,
			detail: entry.brickId,
			brickId: entry.brickId,
			picked: true
		}));
		const selected = await vscode.window.showQuickPick(picks, {
			title: actionLabel,
			placeHolder: 'Select target bricks',
			canPickMany: true
		});
		if (!selected || selected.length === 0) {
			return [];
		}
		return selected.map((entry) => entry.brickId);
	};

	const reconnectReadyBricks = vscode.commands.registerCommand('ev3-cockpit.reconnectReadyBricks', async (arg?: unknown) => {
		const logger = options.getLogger();
		const selectedBrickIds = await selectReadyBrickIds(arg, 'Reconnect Ready Bricks');
		if (selectedBrickIds.length === 0) {
			vscode.window.showInformationMessage('No ready bricks available for batch reconnect.');
			return;
		}

		for (const brickId of selectedBrickIds) {
			try {
				await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', brickId);
			} catch (error) {
				logger.warn('Batch reconnect failed for brick', {
					brickId,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}

		vscode.window.showInformationMessage(`Batch reconnect finished for ${selectedBrickIds.length} brick(s).`);
	});

	const deployWorkspaceToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceToReadyBricks',
		async (arg?: unknown) => {
			const logger = options.getLogger();
			const selectedBrickIds = await selectReadyBrickIds(arg, 'Deploy Workspace To Ready Bricks');
			if (selectedBrickIds.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace deploy.');
				return;
			}

			for (const brickId of selectedBrickIds) {
				try {
					await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickId);
				} catch (error) {
					logger.warn('Batch workspace deploy failed for brick', {
						brickId,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}

			vscode.window.showInformationMessage(`Batch workspace deploy finished for ${selectedBrickIds.length} brick(s).`);
		}
	);

	return {
		reconnectReadyBricks,
		deployWorkspaceToReadyBricks
	};
}
