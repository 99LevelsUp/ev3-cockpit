import * as vscode from 'vscode';
import { BrickControlService } from '../device/brickControlService';
import { Logger } from '../diagnostics/logger';
import { runRemoteExecutable } from '../fs/remoteExecutable';
import { RemoteFsService } from '../fs/remoteFsService';

type ProgramStartSource = 'run-command' | 'restart-command';
type ProgramClearReason = 'stop-program-command' | 'emergency-stop-command';

interface ProgramControlCommandOptions {
	resolveFsAccessContext(arg: unknown): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string };
	resolveControlAccessContext(arg: unknown): { brickId: string; authority: string; controlService: BrickControlService } | { error: string };
	getLastRunProgramPath(brickId: string): string | undefined;
	getRestartCandidatePath(brickId: string): string | undefined;
	resolveDefaultRunDirectory(brickId: string): string;
	getLogger(): Logger;
	normalizeRunExecutablePath(input: string): string;
	onProgramStarted(path: string, source: ProgramStartSource, brickId: string): void;
	onProgramCleared(reason: ProgramClearReason, brickId: string): void;
}

interface ProgramControlCommandRegistrations {
	runRemoteProgram: vscode.Disposable;
	stopProgram: vscode.Disposable;
	restartProgram: vscode.Disposable;
	emergencyStop: vscode.Disposable;
}

export function registerProgramControlCommands(
	options: ProgramControlCommandOptions
): ProgramControlCommandRegistrations {
	const runRemoteProgram = vscode.commands.registerCommand('ev3-cockpit.runRemoteProgram', async (arg?: unknown) => {
		const fsContext = options.resolveFsAccessContext(arg);
		if ('error' in fsContext) {
			vscode.window.showErrorMessage(fsContext.error);
			return;
		}

		const input = await vscode.window.showInputBox({
			title: 'Run EV3 Executable',
			prompt: `Remote path or ev3://${fsContext.authority}/... URI`,
			value: options.getLastRunProgramPath(fsContext.brickId) ?? options.resolveDefaultRunDirectory(fsContext.brickId),
			validateInput: (value) => {
				try {
					options.normalizeRunExecutablePath(value);
					return undefined;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			}
		});
		if (!input) {
			return;
		}

		try {
			const runPath = options.normalizeRunExecutablePath(input);
			const executable = await runRemoteExecutable(fsContext.fsService, runPath);
			options.onProgramStarted(runPath, 'run-command', fsContext.brickId);
			options.getLogger().info('Run program command completed', {
				brickId: fsContext.brickId,
				path: runPath,
				type: executable.typeId
			});
			vscode.window.showInformationMessage(`Program started: ev3://${fsContext.authority}${runPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().warn('Run program command failed', {
				brickId: fsContext.brickId,
				message
			});
			vscode.window.showErrorMessage(`Run program failed: ${message}`);
		}
	});

	const stopProgram = vscode.commands.registerCommand('ev3-cockpit.stopProgram', async (arg?: unknown) => {
		const controlContext = options.resolveControlAccessContext(arg);
		if ('error' in controlContext) {
			vscode.window.showErrorMessage(controlContext.error);
			return;
		}

		try {
			await controlContext.controlService.stopProgram();
			options.onProgramCleared('stop-program-command', controlContext.brickId);
			vscode.window.showInformationMessage(`Program stop command sent: ev3://${controlContext.authority}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().error('Program stop failed', {
				brickId: controlContext.brickId,
				message
			});
			vscode.window.showErrorMessage(`Program stop failed: ${message}`);
		}
	});

	const restartProgram = vscode.commands.registerCommand('ev3-cockpit.restartProgram', async (arg?: unknown) => {
		const fsContext = options.resolveFsAccessContext(arg);
		if ('error' in fsContext) {
			vscode.window.showErrorMessage(fsContext.error);
			return;
		}
		const controlContext = options.resolveControlAccessContext(arg);
		if ('error' in controlContext) {
			vscode.window.showErrorMessage(controlContext.error);
			return;
		}

		let runPath = options.getRestartCandidatePath(fsContext.brickId);
		if (!runPath) {
			const input = await vscode.window.showInputBox({
				title: 'Restart EV3 Executable',
				prompt: `Remote path or ev3://${fsContext.authority}/... URI`,
				value: options.resolveDefaultRunDirectory(fsContext.brickId),
				validateInput: (value) => {
					try {
						options.normalizeRunExecutablePath(value);
						return undefined;
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
				}
			});
			if (!input) {
				return;
			}
			runPath = options.normalizeRunExecutablePath(input);
		}

		try {
			await controlContext.controlService.stopProgram();
			const executable = await runRemoteExecutable(fsContext.fsService, runPath);
			options.onProgramStarted(runPath, 'restart-command', fsContext.brickId);
			options.getLogger().info('Restart program command completed', {
				brickId: fsContext.brickId,
				path: runPath,
				type: executable.typeId
			});
			vscode.window.showInformationMessage(`Program restarted: ev3://${fsContext.authority}${runPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().error('Restart program failed', {
				brickId: fsContext.brickId,
				message
			});
			vscode.window.showErrorMessage(`Restart program failed: ${message}`);
		}
	});

	const emergencyStop = vscode.commands.registerCommand('ev3-cockpit.emergencyStop', async (arg?: unknown) => {
		const controlContext = options.resolveControlAccessContext(arg);
		if ('error' in controlContext) {
			vscode.window.showErrorMessage(controlContext.error);
			return;
		}

		try {
			await controlContext.controlService.emergencyStopAll();
			options.onProgramCleared('emergency-stop-command', controlContext.brickId);
			vscode.window.showInformationMessage(`Emergency stop sent: ev3://${controlContext.authority}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().error('Emergency stop failed', {
				brickId: controlContext.brickId,
				message
			});
			vscode.window.showErrorMessage(`Emergency stop failed: ${message}`);
		}
	});

	return {
		runRemoteProgram,
		stopProgram,
		restartProgram,
		emergencyStop
	};
}
