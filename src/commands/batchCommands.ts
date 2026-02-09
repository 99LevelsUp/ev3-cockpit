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

	const runBatchWithProgress = async (
		brickIds: string[],
		title: string,
		task: (brickId: string) => Promise<void>
	): Promise<{ completed: number; failed: number; cancelled: boolean }> => {
		let completed = 0;
		let failed = 0;
		let cancelled = false;

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title,
				cancellable: true
			},
			async (progress, token) => {
				progress.report({ message: `0/${brickIds.length}` });
				for (let index = 0; index < brickIds.length; index += 1) {
					const brickId = brickIds[index];
					if (token.isCancellationRequested) {
						cancelled = true;
						break;
					}
					try {
						await task(brickId);
						completed += 1;
					} catch {
						failed += 1;
					}
					const done = index + 1;
					progress.report({
						increment: 100 / brickIds.length,
						message: `${done}/${brickIds.length}`
					});
				}
			}
		);

		return {
			completed,
			failed,
			cancelled
		};
	};

	const reconnectReadyBricks = vscode.commands.registerCommand('ev3-cockpit.reconnectReadyBricks', async (arg?: unknown) => {
		const logger = options.getLogger();
		const selectedBrickIds = await selectReadyBrickIds(arg, 'Reconnect Ready Bricks');
		if (selectedBrickIds.length === 0) {
			vscode.window.showInformationMessage('No ready bricks available for batch reconnect.');
			return;
		}

		const result = await runBatchWithProgress(selectedBrickIds, 'Batch reconnect bricks', async (brickId) => {
			try {
				await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', brickId);
			} catch (error) {
				logger.warn('Batch reconnect failed for brick', {
					brickId,
					error: error instanceof Error ? error.message : String(error)
				});
				throw error;
			}
		});

		const suffix = result.cancelled ? ' (cancelled)' : '';
		vscode.window.showInformationMessage(
			`Batch reconnect finished: ok=${result.completed}, failed=${result.failed}${suffix}.`
		);
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

			const result = await runBatchWithProgress(
				selectedBrickIds,
				'Batch deploy workspace to bricks',
				async (brickId) => {
					try {
						await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickId);
					} catch (error) {
						logger.warn('Batch workspace deploy failed for brick', {
							brickId,
							error: error instanceof Error ? error.message : String(error)
						});
						throw error;
					}
				}
			);

			const suffix = result.cancelled ? ' (cancelled)' : '';
			vscode.window.showInformationMessage(
				`Batch workspace deploy finished: ok=${result.completed}, failed=${result.failed}${suffix}.`
			);
		}
	);

	return {
		reconnectReadyBricks,
		deployWorkspaceToReadyBricks
	};
}
