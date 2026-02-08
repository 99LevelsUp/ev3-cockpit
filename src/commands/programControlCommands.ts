import * as vscode from 'vscode';
import { BrickControlService } from '../device/brickControlService';
import { Logger } from '../diagnostics/logger';
import { runRemoteExecutable } from '../fs/remoteExecutable';
import { RemoteFsService } from '../fs/remoteFsService';

type ProgramStartSource = 'run-command' | 'restart-command';
type ProgramClearReason = 'stop-program-command' | 'emergency-stop-command';

interface ProgramControlCommandOptions {
	getActiveFsService(): RemoteFsService | undefined;
	getActiveControlService(): BrickControlService | undefined;
	getLastRunProgramPath(): string | undefined;
	getRestartCandidatePath(): string | undefined;
	getLogger(): Logger;
	normalizeRunExecutablePath(input: string): string;
	onProgramStarted(path: string, source: ProgramStartSource): void;
	onProgramCleared(reason: ProgramClearReason): void;
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
	const runRemoteProgram = vscode.commands.registerCommand('ev3-cockpit.runRemoteProgram', async () => {
		const fsService = options.getActiveFsService();
		if (!fsService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		const input = await vscode.window.showInputBox({
			title: 'Run EV3 Executable',
			prompt: 'Remote path or ev3://active/... URI',
			value: options.getLastRunProgramPath() ?? '/home/root/lms2012/prjs/',
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
			const executable = await runRemoteExecutable(fsService, runPath);
			options.onProgramStarted(runPath, 'run-command');
			options.getLogger().info('Run program command completed', {
				path: runPath,
				type: executable.typeId
			});
			vscode.window.showInformationMessage(`Program started: ev3://active${runPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().warn('Run program command failed', {
				message
			});
			vscode.window.showErrorMessage(`Run program failed: ${message}`);
		}
	});

	const stopProgram = vscode.commands.registerCommand('ev3-cockpit.stopProgram', async () => {
		const controlService = options.getActiveControlService();
		if (!controlService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		try {
			await controlService.stopProgram();
			options.onProgramCleared('stop-program-command');
			vscode.window.showInformationMessage('Program stop command sent to EV3.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().error('Program stop failed', { message });
			vscode.window.showErrorMessage(`Program stop failed: ${message}`);
		}
	});

	const restartProgram = vscode.commands.registerCommand('ev3-cockpit.restartProgram', async () => {
		const fsService = options.getActiveFsService();
		const controlService = options.getActiveControlService();
		if (!fsService || !controlService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		let runPath = options.getRestartCandidatePath();
		if (!runPath) {
			const input = await vscode.window.showInputBox({
				title: 'Restart EV3 Executable',
				prompt: 'Remote path or ev3://active/... URI',
				value: '/home/root/lms2012/prjs/',
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
			await controlService.stopProgram();
			const executable = await runRemoteExecutable(fsService, runPath);
			options.onProgramStarted(runPath, 'restart-command');
			options.getLogger().info('Restart program command completed', {
				path: runPath,
				type: executable.typeId
			});
			vscode.window.showInformationMessage(`Program restarted: ev3://active${runPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().error('Restart program failed', { message });
			vscode.window.showErrorMessage(`Restart program failed: ${message}`);
		}
	});

	const emergencyStop = vscode.commands.registerCommand('ev3-cockpit.emergencyStop', async () => {
		const controlService = options.getActiveControlService();
		if (!controlService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		try {
			await controlService.emergencyStopAll();
			options.onProgramCleared('emergency-stop-command');
			vscode.window.showInformationMessage('Emergency stop command sent to EV3.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.getLogger().error('Emergency stop failed', { message });
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
