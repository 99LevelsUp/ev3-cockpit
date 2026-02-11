import * as vscode from 'vscode';
import { BrickRegistry } from '../device/brickRegistry';
import { Logger } from '../diagnostics/logger';
import { toErrorMessage } from './commandUtils';

export interface BatchCommandOptions {
	getLogger(): Logger;
	getBrickRegistry(): BrickRegistry;
}

export interface BatchCommandRegistrations {
	reconnectReadyBricks: vscode.Disposable;
	previewWorkspaceDeployToReadyBricks: vscode.Disposable;
	deployWorkspaceToReadyBricks: vscode.Disposable;
	deployWorkspaceAndRunExecutableToReadyBricks: vscode.Disposable;
}

interface BatchFailedEntry {
	brickId: string;
	error: string;
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
	): Promise<{ completed: number; failed: number; cancelled: boolean; failedEntries: BatchFailedEntry[] }> => {
		let completed = 0;
		let failed = 0;
		let cancelled = false;
		const failedEntries: BatchFailedEntry[] = [];

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
					} catch (error) {
						failed += 1;
						failedEntries.push({
							brickId,
							error: toErrorMessage(error)
						});
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
			cancelled,
			failedEntries
		};
	};

	const buildBatchReport = (
		actionLabel: string,
		selectedBrickIds: string[],
		result: { completed: number; failed: number; cancelled: boolean; failedEntries: BatchFailedEntry[] }
	): string => {
		const lines = [
			`EV3 Cockpit batch report`,
			`action: ${actionLabel}`,
			`timestamp: ${new Date().toISOString()}`,
			`targets: ${selectedBrickIds.join(', ')}`,
			`result: ok=${result.completed}, failed=${result.failed}, cancelled=${result.cancelled}`
		];
		if (result.failedEntries.length > 0) {
			lines.push('failed entries:');
			for (const entry of result.failedEntries) {
				lines.push(`- ${entry.brickId}: ${entry.error}`);
			}
		}
		return lines.join('\n');
	};

	const presentBatchResult = async (
		actionLabel: string,
		successSummary: string,
		result: { completed: number; failed: number; cancelled: boolean; failedEntries: BatchFailedEntry[] },
		selectedBrickIds: string[],
		retryCommandId: string
	): Promise<void> => {
		const actions: string[] = ['Copy report'];
		if (result.failedEntries.length > 0) {
			actions.unshift('Retry failed');
		}
		const choice = await vscode.window.showInformationMessage(successSummary, ...actions);
		if (choice === 'Copy report') {
			const report = buildBatchReport(actionLabel, selectedBrickIds, result);
			await vscode.env.clipboard.writeText(report);
			vscode.window.showInformationMessage('Batch report copied to clipboard.');
			return;
		}
		if (choice === 'Retry failed') {
			const failedBrickIds = result.failedEntries.map((entry) => entry.brickId);
			await vscode.commands.executeCommand(retryCommandId, failedBrickIds);
		}
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
					error: toErrorMessage(error)
				});
				throw error;
			}
		});

		const suffix = result.cancelled ? ' (cancelled)' : '';
		await presentBatchResult(
			'reconnect-ready-bricks',
			`Batch reconnect finished: ok=${result.completed}, failed=${result.failed}${suffix}.`,
			result,
			selectedBrickIds,
			'ev3-cockpit.reconnectReadyBricks'
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
							error: toErrorMessage(error)
						});
						throw error;
					}
				}
			);

			const suffix = result.cancelled ? ' (cancelled)' : '';
			await presentBatchResult(
				'deploy-workspace-ready-bricks',
				`Batch workspace deploy finished: ok=${result.completed}, failed=${result.failed}${suffix}.`,
				result,
				selectedBrickIds,
				'ev3-cockpit.deployWorkspaceToReadyBricks'
			);
		}
	);

	const previewWorkspaceDeployToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.previewWorkspaceDeployToReadyBricks',
		async (arg?: unknown) => {
			const logger = options.getLogger();
			const selectedBrickIds = await selectReadyBrickIds(arg, 'Preview Workspace Deploy To Ready Bricks');
			if (selectedBrickIds.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace preview.');
				return;
			}

			const result = await runBatchWithProgress(
				selectedBrickIds,
				'Batch preview workspace deploy to bricks',
				async (brickId) => {
					try {
						await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToBrick', brickId);
					} catch (error) {
						logger.warn('Batch workspace deploy preview failed for brick', {
							brickId,
							error: toErrorMessage(error)
						});
						throw error;
					}
				}
			);

			const suffix = result.cancelled ? ' (cancelled)' : '';
			await presentBatchResult(
				'preview-workspace-ready-bricks',
				`Batch workspace deploy preview finished: ok=${result.completed}, failed=${result.failed}${suffix}.`,
				result,
				selectedBrickIds,
				'ev3-cockpit.previewWorkspaceDeployToReadyBricks'
			);
		}
	);

	const deployWorkspaceAndRunExecutableToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks',
		async (arg?: unknown) => {
			const logger = options.getLogger();
			const selectedBrickIds = await selectReadyBrickIds(arg, 'Deploy Workspace + Run To Ready Bricks');
			if (selectedBrickIds.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace deploy+run.');
				return;
			}

			const result = await runBatchWithProgress(
				selectedBrickIds,
				'Batch deploy workspace + run to bricks',
				async (brickId) => {
					try {
						await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick', brickId);
					} catch (error) {
						logger.warn('Batch workspace deploy+run failed for brick', {
							brickId,
							error: toErrorMessage(error)
						});
						throw error;
					}
				}
			);

			const suffix = result.cancelled ? ' (cancelled)' : '';
			await presentBatchResult(
				'deploy-workspace-run-ready-bricks',
				`Batch workspace deploy+run finished: ok=${result.completed}, failed=${result.failed}${suffix}.`,
				result,
				selectedBrickIds,
				'ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks'
			);
		}
	);

	return {
		reconnectReadyBricks,
		previewWorkspaceDeployToReadyBricks,
		deployWorkspaceToReadyBricks,
		deployWorkspaceAndRunExecutableToReadyBricks
	};
}
