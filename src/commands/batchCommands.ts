/**
 * VS Code commands for batch operations across multiple connected bricks.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { BrickRegistry } from '../device/brickRegistry';
import { createFlowLogger } from '../diagnostics/flowLogger';
import { Logger } from '../diagnostics/logger';
import { nextCorrelationId } from '../diagnostics/perfTiming';
import { presentCommandError, toUserFacingErrorMessage } from './commandUtils';

/**
 * Dependency injection options for batch commands.
 */
export interface BatchCommandOptions {
	/** Returns the active logger instance. */
	getLogger(): Logger;
	/** Returns the central brick state registry. */
	getBrickRegistry(): BrickRegistry;
}

/**
 * Disposable registrations returned by {@link registerBatchCommands}.
 *
 * @remarks
 * Each property corresponds to a batch command that operates on
 * multiple READY bricks in sequence with progress tracking.
 */
export interface BatchCommandRegistrations {
	/** Reconnects all selected READY bricks in batch. */
	reconnectReadyBricks: vscode.Disposable;
	/** Previews workspace deploy to multiple bricks. */
	previewWorkspaceDeployToReadyBricks: vscode.Disposable;
	/** Deploys workspace to multiple bricks. */
	deployWorkspaceToReadyBricks: vscode.Disposable;
	/** Deploys workspace and runs an executable on multiple bricks. */
	deployWorkspaceAndRunExecutableToReadyBricks: vscode.Disposable;
}

/** Tracks a failed brick operation within a batch run. */
interface BatchFailedEntry {
	/** Brick ID that failed. */
	brickId: string;
	/** User-facing error message. */
	error: string;
}

/**
 * Registers VS Code commands for batch operations across multiple EV3 bricks.
 *
 * @remarks
 * Batch commands follow a consistent pattern:
 * 1. Select target bricks from the READY list (via args or QuickPick)
 * 2. Execute the task for each brick with progress notification
 * 3. Present results with "Copy report" and "Retry failed" actions
 *
 * @param options - Dependency injection options.
 * @returns Disposable registrations for all four batch commands.
 *
 * @see {@link BatchCommandOptions}
 * @see {@link BatchCommandRegistrations}
 */
export function registerBatchCommands(options: BatchCommandOptions): BatchCommandRegistrations {
	// Resolves brick IDs from a command arg (array, string, or undefined)
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

	// Shows a multi-select QuickPick of READY bricks (or filters by provided IDs)
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

	// Executes a task for each brick with VS Code progress notification and cancellation
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
							error: toUserFacingErrorMessage(error)
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

	// Builds a clipboard-friendly batch report with timestamps and failure details
	const buildBatchReport = (
		actionLabel: string,
		selectedBrickIds: string[],
		result: { completed: number; failed: number; cancelled: boolean; failedEntries: BatchFailedEntry[] }
	): string => {
	const lines = [
			`EVƎ Cockpit batch report`,
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

	// Shows the batch result with "Copy report" and "Retry failed" action buttons
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

	// --- Command: reconnectReadyBricks ---
	const reconnectReadyBricks = vscode.commands.registerCommand('ev3-cockpit.reconnectReadyBricks', async (arg?: unknown) => {
		const logger = options.getLogger();
		const selectedBrickIds = await selectReadyBrickIds(arg, 'Reconnect Ready Bricks');
		if (selectedBrickIds.length === 0) {
			vscode.window.showInformationMessage('No ready bricks available for batch reconnect.');
			return;
		}
		const flowLogger = createFlowLogger(logger, 'batch.reconnect-ready-bricks', {
			correlationId: nextCorrelationId(),
			targetCount: selectedBrickIds.length,
			targetBrickIds: selectedBrickIds
		});
		flowLogger.started();

		const result = await runBatchWithProgress(selectedBrickIds, 'Batch reconnect bricks', async (brickId) => {
			try {
				await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', brickId);
			} catch (error) {
				presentCommandError({
					logger,
					operation: 'Batch reconnect brick',
					level: 'warn',
					context: {
						brickId
					},
					error
				});
				throw error;
			}
		});
		flowLogger.completed({
			completed: result.completed,
			failed: result.failed,
			cancelled: result.cancelled
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

	// --- Command: deployWorkspaceToReadyBricks ---
	const deployWorkspaceToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceToReadyBricks',
		async (arg?: unknown) => {
			const logger = options.getLogger();
			const selectedBrickIds = await selectReadyBrickIds(arg, 'Deploy Workspace To Ready Bricks');
			if (selectedBrickIds.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace deploy.');
				return;
			}
			const flowLogger = createFlowLogger(logger, 'batch.deploy-workspace-ready-bricks', {
				correlationId: nextCorrelationId(),
				targetCount: selectedBrickIds.length,
				targetBrickIds: selectedBrickIds
			});
			flowLogger.started();

			const result = await runBatchWithProgress(
				selectedBrickIds,
				'Batch deploy workspace to bricks',
				async (brickId) => {
					try {
						await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickId);
					} catch (error) {
						presentCommandError({
							logger,
							operation: 'Batch workspace deploy',
							level: 'warn',
							context: {
								brickId
							},
							error
						});
						throw error;
					}
				}
			);
			flowLogger.completed({
				completed: result.completed,
				failed: result.failed,
				cancelled: result.cancelled
			});

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

	// --- Command: previewWorkspaceDeployToReadyBricks ---
	const previewWorkspaceDeployToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.previewWorkspaceDeployToReadyBricks',
		async (arg?: unknown) => {
			const logger = options.getLogger();
			const selectedBrickIds = await selectReadyBrickIds(arg, 'Preview Workspace Deploy To Ready Bricks');
			if (selectedBrickIds.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace preview.');
				return;
			}
			const flowLogger = createFlowLogger(logger, 'batch.preview-workspace-ready-bricks', {
				correlationId: nextCorrelationId(),
				targetCount: selectedBrickIds.length,
				targetBrickIds: selectedBrickIds
			});
			flowLogger.started();

			const result = await runBatchWithProgress(
				selectedBrickIds,
				'Batch preview workspace deploy to bricks',
				async (brickId) => {
					try {
						await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToBrick', brickId);
					} catch (error) {
						presentCommandError({
							logger,
							operation: 'Batch workspace deploy preview',
							level: 'warn',
							context: {
								brickId
							},
							error
						});
						throw error;
					}
				}
			);
			flowLogger.completed({
				completed: result.completed,
				failed: result.failed,
				cancelled: result.cancelled
			});

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

	// --- Command: deployWorkspaceAndRunExecutableToReadyBricks ---
	const deployWorkspaceAndRunExecutableToReadyBricks = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceAndRunExecutableToReadyBricks',
		async (arg?: unknown) => {
			const logger = options.getLogger();
			const selectedBrickIds = await selectReadyBrickIds(arg, 'Deploy Workspace + Run To Ready Bricks');
			if (selectedBrickIds.length === 0) {
				vscode.window.showInformationMessage('No ready bricks available for batch workspace deploy+run.');
				return;
			}
			const flowLogger = createFlowLogger(logger, 'batch.deploy-workspace-run-ready-bricks', {
				correlationId: nextCorrelationId(),
				targetCount: selectedBrickIds.length,
				targetBrickIds: selectedBrickIds
			});
			flowLogger.started();

			const result = await runBatchWithProgress(
				selectedBrickIds,
				'Batch deploy workspace + run to bricks',
				async (brickId) => {
					try {
						await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick', brickId);
					} catch (error) {
						presentCommandError({
							logger,
							operation: 'Batch workspace deploy and run',
							level: 'warn',
							context: {
								brickId
							},
							error
						});
						throw error;
					}
				}
			);
			flowLogger.completed({
				completed: result.completed,
				failed: result.failed,
				cancelled: result.cancelled
			});

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
