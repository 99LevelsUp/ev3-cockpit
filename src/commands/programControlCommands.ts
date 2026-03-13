/**
 * Program control commands for running, stopping, restarting, and emergency-stopping
 * EV3 programs on connected bricks.
 *
 * @remarks
 * This module registers four VS Code commands under the `ev3-cockpit.*` namespace:
 * - `runRemoteProgram` — prompts the user for a remote path and launches an executable on the brick.
 * - `stopProgram` — sends a stop signal to the currently running program.
 * - `restartProgram` — stops the current program and re-launches it (or prompts if no candidate).
 * - `emergencyStop` — immediately halts all motors and running programs on the brick.
 *
 * All commands use dependency-injected options ({@link ProgramControlCommandOptions}) to
 * resolve brick contexts, track program state, and normalize paths. This keeps the command
 * layer decoupled from concrete brick session and transport implementations.
 *
 * @see {@link registerProgramControlCommands} for the main entry point.
 *
 * @module programControlCommands
 */

import * as vscode from 'vscode';
import { BrickControlService } from '../device/brickControlService';
import { Logger } from '../diagnostics/logger';
import { runRemoteExecutable } from '../fs/remoteExecutable';
import { RemoteFsService } from '../fs/remoteFsService';
import { presentCommandError, withBrickOperation } from './commandUtils';

/**
 * Identifies why a program was started.
 *
 * @remarks
 * Used by {@link ProgramControlCommandOptions.onProgramStarted} to distinguish
 * between a fresh run initiated by the user and an automatic restart.
 *
 * - `'run-command'` — the user explicitly invoked the "Run Remote Program" command.
 * - `'restart-command'` — the user invoked the "Restart Program" command.
 */
type ProgramStartSource = 'run-command' | 'restart-command';

/**
 * Identifies why the running program was cleared (stopped).
 *
 * @remarks
 * Used by {@link ProgramControlCommandOptions.onProgramCleared} so callers can
 * differentiate between a graceful stop and an emergency stop.
 *
 * - `'stop-program-command'` — normal stop via the "Stop Program" command.
 * - `'emergency-stop-command'` — immediate halt via the "Emergency Stop" command.
 */
type ProgramClearReason = 'stop-program-command' | 'emergency-stop-command';

/**
 * Dependency-injection options for the program control command registrations.
 *
 * @remarks
 * Each method in this interface is a callback supplied by the extension's
 * activation wiring (typically in `extension.ts`). This decouples the command
 * handlers from concrete brick session management, path normalization, and
 * telemetry/logging concerns.
 *
 * The interface groups into three categories:
 * 1. **Context resolution** — {@link resolveFsAccessContext} and
 *    {@link resolveControlAccessContext} map the raw command argument (which may
 *    be a tree-view item, a URI, or `undefined`) into a typed brick context.
 * 2. **Path helpers** — {@link getLastRunProgramPath}, {@link getRestartCandidatePath},
 *    {@link resolveDefaultRunDirectory}, and {@link normalizeRunExecutablePath}
 *    manage the executable path lifecycle.
 * 3. **Callbacks / side-effects** — {@link onProgramStarted}, {@link onProgramCleared},
 *    and {@link onBrickOperation} let the caller track program state and UI busy indicators.
 *
 * @see {@link registerProgramControlCommands}
 */
export interface ProgramControlCommandOptions {
	/**
	 * Resolves a filesystem-access context from the raw VS Code command argument.
	 *
	 * @remarks
	 * The argument may originate from a tree-view context menu, a command palette
	 * invocation (no argument), or a programmatic call. On success, the returned
	 * object carries the brick's unique ID, its `ev3://` authority, and a ready-to-use
	 * {@link RemoteFsService}. On failure, an `{ error }` string is returned that
	 * can be shown directly to the user.
	 *
	 * @param arg - The raw command argument forwarded by VS Code.
	 * @returns A resolved FS context or a user-facing error message.
	 */
	resolveFsAccessContext(arg: unknown): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string };

	/**
	 * Resolves a control-access context from the raw VS Code command argument.
	 *
	 * @remarks
	 * Similar to {@link resolveFsAccessContext}, but provides a
	 * {@link BrickControlService} for motor/program control operations instead
	 * of filesystem access.
	 *
	 * @param arg - The raw command argument forwarded by VS Code.
	 * @returns A resolved control context or a user-facing error message.
	 */
	resolveControlAccessContext(arg: unknown): { brickId: string; authority: string; controlService: BrickControlService } | { error: string };

	/**
	 * Retrieves the most recently executed program path for a brick.
	 *
	 * @remarks
	 * Used to pre-populate the "Run Remote Program" input box so the user
	 * can quickly re-run the same executable.
	 *
	 * @param brickId - The unique identifier of the target brick.
	 * @returns The absolute remote path of the last run, or `undefined` if no history exists.
	 */
	getLastRunProgramPath(brickId: string): string | undefined;

	/**
	 * Retrieves the candidate program path for a restart operation.
	 *
	 * @remarks
	 * Returns the path of the currently (or most recently) running program
	 * that qualifies for restart. If no candidate is available, `undefined`
	 * is returned and the restart command will fall back to prompting the user.
	 *
	 * @param brickId - The unique identifier of the target brick.
	 * @returns The restart-eligible remote path, or `undefined`.
	 */
	getRestartCandidatePath(brickId: string): string | undefined;

	/**
	 * Provides the default directory shown in the run/restart input box.
	 *
	 * @remarks
	 * Typically returns the brick's configured deploy directory (e.g. `/home/robot/`).
	 *
	 * @param brickId - The unique identifier of the target brick.
	 * @returns An absolute remote directory path.
	 */
	resolveDefaultRunDirectory(brickId: string): string;

	/**
	 * Returns the extension's {@link Logger} instance for structured diagnostics.
	 *
	 * @returns The active logger.
	 */
	getLogger(): Logger;

	/**
	 * Validates and normalizes user-supplied executable paths.
	 *
	 * @remarks
	 * Handles both raw remote paths (e.g. `/home/robot/app`) and full
	 * `ev3://` URIs by stripping the scheme/authority and normalizing
	 * separators. Throws if the input is malformed.
	 *
	 * @param input - The raw user input string.
	 * @returns A normalized absolute remote path.
	 * @throws {Error} If the input cannot be parsed into a valid remote path.
	 */
	normalizeRunExecutablePath(input: string): string;

	/**
	 * Callback invoked after a program has been successfully started on the brick.
	 *
	 * @remarks
	 * Allows the caller to update tracked program state (e.g. "last run path",
	 * UI indicators) in response to a successful launch.
	 *
	 * @param path - The normalized remote path of the started executable.
	 * @param source - Whether this was a fresh run or a restart.
	 * @param brickId - The unique identifier of the target brick.
	 */
	onProgramStarted(path: string, source: ProgramStartSource, brickId: string): void;

	/**
	 * Callback invoked after a running program has been stopped or emergency-halted.
	 *
	 * @remarks
	 * Allows the caller to clear tracked program state and update UI indicators.
	 *
	 * @param reason - Why the program was cleared.
	 * @param brickId - The unique identifier of the target brick.
	 */
	onProgramCleared(reason: ProgramClearReason, brickId: string): void;

	/**
	 * Callback invoked when a brick operation begins, used for UI busy indicators.
	 *
	 * @remarks
	 * Typically drives a spinner or status-bar indicator while an async
	 * operation is in flight.
	 *
	 * @param brickId - The unique identifier of the target brick.
	 * @param operation - A human-readable label for the operation (e.g. `"Run program"`).
	 */
	onBrickOperation(brickId: string, operation: string): void;
}

/**
 * The set of {@link vscode.Disposable} command registrations returned by
 * {@link registerProgramControlCommands}.
 *
 * @remarks
 * Each property corresponds to one VS Code command. The caller (typically
 * `extension.ts`) should push these disposables into the extension context's
 * subscriptions array so they are automatically disposed when the extension
 * deactivates.
 *
 * @example
 * ```ts
 * const registrations = registerProgramControlCommands(options);
 * context.subscriptions.push(
 *   registrations.runRemoteProgram,
 *   registrations.stopProgram,
 *   registrations.restartProgram,
 *   registrations.emergencyStop,
 * );
 * ```
 */
export interface ProgramControlCommandRegistrations {
	/** Disposable for the `ev3-cockpit.runRemoteProgram` command. */
	runRemoteProgram: vscode.Disposable;

	/** Disposable for the `ev3-cockpit.stopProgram` command. */
	stopProgram: vscode.Disposable;

	/** Disposable for the `ev3-cockpit.restartProgram` command. */
	restartProgram: vscode.Disposable;

	/**
	 * Disposable for the `ev3-cockpit.emergencyStop` command.
	 *
	 * @remarks
	 * Emergency stop halts **all** motors and running programs on the brick,
	 * not just the most recently started one.
	 */
	emergencyStop: vscode.Disposable;
}

/**
 * Registers the four program-control VS Code commands and returns their disposables.
 *
 * @remarks
 * This is the only public entry point for this module. It creates command handlers
 * for run, stop, restart, and emergency-stop, each following a consistent pattern:
 *
 * 1. Resolve the appropriate brick context (FS and/or control) from the command argument.
 * 2. Prompt the user for a remote executable path if needed.
 * 3. Execute the operation wrapped in {@link withBrickOperation} for busy-indicator tracking.
 * 4. Show a success notification or present a formatted error via {@link presentCommandError}.
 *
 * **Command identifiers registered:**
 * | Command ID                          | Description                                   |
 * |-------------------------------------|-----------------------------------------------|
 * | `ev3-cockpit.runRemoteProgram`      | Prompt for path, then launch an EV3 executable |
 * | `ev3-cockpit.stopProgram`           | Gracefully stop the running program            |
 * | `ev3-cockpit.restartProgram`        | Stop then re-launch (with optional re-prompt)  |
 * | `ev3-cockpit.emergencyStop`         | Immediately halt all motors and programs       |
 *
 * @param options - Dependency-injected callbacks and resolvers.
 * @returns An object of {@link vscode.Disposable} registrations to be added to the
 *   extension context's subscriptions.
 *
 * @example
 * ```ts
 * const regs = registerProgramControlCommands({
 *   resolveFsAccessContext: (arg) => registry.resolveFsContext(arg),
 *   resolveControlAccessContext: (arg) => registry.resolveControlContext(arg),
 *   // ...remaining options
 * });
 * context.subscriptions.push(
 *   regs.runRemoteProgram, regs.stopProgram,
 *   regs.restartProgram, regs.emergencyStop,
 * );
 * ```
 *
 * @see {@link ProgramControlCommandOptions}
 * @see {@link ProgramControlCommandRegistrations}
 */
export function registerProgramControlCommands(
	options: ProgramControlCommandOptions
): ProgramControlCommandRegistrations {
	// --- Run Remote Program ---
	const runRemoteProgram = vscode.commands.registerCommand('ev3-cockpit.runRemoteProgram', async (arg?: unknown) => {
		// Resolve the FS context from the command argument (tree-view item, URI, or undefined)
		const fsContext = options.resolveFsAccessContext(arg);
		if ('error' in fsContext) {
			vscode.window.showErrorMessage(fsContext.error);
			return;
		}

		// Prompt the user for a remote executable path, pre-populated with the last run
		// path (if available) or the brick's default run directory as a fallback.
		const input = await vscode.window.showInputBox({
			title: 'Run EV3 Executable',
			prompt: `Remote path or ev3://${fsContext.authority}/... URI`,
			value: options.getLastRunProgramPath(fsContext.brickId) ?? options.resolveDefaultRunDirectory(fsContext.brickId),
			// Live validation: normalizeRunExecutablePath throws on malformed paths,
			// which is surfaced as inline validation feedback in the input box.
			validateInput: (value) => {
				try {
					options.normalizeRunExecutablePath(value);
					return undefined;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			}
		});
		// User cancelled the input box
		if (!input) {
			return;
		}

		try {
			// Normalize the user-supplied path (strips ev3:// scheme, fixes separators)
			// then launch the executable inside a tracked brick operation for busy indicators.
			const runPath = options.normalizeRunExecutablePath(input);
			const executable = await withBrickOperation(fsContext.brickId, 'Run program', options.onBrickOperation, async () => {
				const exec = await runRemoteExecutable(fsContext.fsService, runPath);
				// Notify the caller so it can track program state (e.g. "last run path")
				options.onProgramStarted(runPath, 'run-command', fsContext.brickId);
				return exec;
			});
			options.getLogger().info('Run program command completed', {
				brickId: fsContext.brickId,
				path: runPath,
				type: executable.typeId
			});
			vscode.window.showInformationMessage(`Program started: ev3://${fsContext.authority}${runPath}`);
		} catch (error) {
			const message = presentCommandError({
				logger: options.getLogger(),
				operation: 'Run program',
				level: 'warn',
				context: {
					brickId: fsContext.brickId
				},
				error
			});
			vscode.window.showErrorMessage(message);
		}
	});

	// --- Stop Program ---
	const stopProgram = vscode.commands.registerCommand('ev3-cockpit.stopProgram', async (arg?: unknown) => {
		// Stop only needs control access (no filesystem operations)
		const controlContext = options.resolveControlAccessContext(arg);
		if ('error' in controlContext) {
			vscode.window.showErrorMessage(controlContext.error);
			return;
		}

		try {
			await withBrickOperation(controlContext.brickId, 'Stop program', options.onBrickOperation, async () => {
				await controlContext.controlService.stopProgram();
				options.onProgramCleared('stop-program-command', controlContext.brickId);
			});
			vscode.window.showInformationMessage(`Program stop command sent: ev3://${controlContext.authority}`);
		} catch (error) {
			vscode.window.showErrorMessage(
				presentCommandError({
					logger: options.getLogger(),
					operation: 'Program stop',
					context: {
						brickId: controlContext.brickId
					},
					error
				})
			);
		}
	});

	// --- Restart Program ---
	// Restart requires both FS context (to re-launch the executable) and
	// control context (to stop the currently running program first).
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

		// Try to reuse the path of the currently/last running program.
		// If unavailable, fall back to prompting the user for a path.
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
			// Atomic stop-then-start: first stop the current program, then
			// immediately launch the new one within the same brick operation
			// to keep the UI busy indicator active throughout.
			const executable = await withBrickOperation(fsContext.brickId, 'Restart program', options.onBrickOperation, async () => {
				await controlContext.controlService.stopProgram();
				const exec = await runRemoteExecutable(fsContext.fsService, runPath);
				options.onProgramStarted(runPath, 'restart-command', fsContext.brickId);
				return exec;
			});
			options.getLogger().info('Restart program command completed', {
				brickId: fsContext.brickId,
				path: runPath,
				type: executable.typeId
			});
			vscode.window.showInformationMessage(`Program restarted: ev3://${fsContext.authority}${runPath}`);
		} catch (error) {
			vscode.window.showErrorMessage(
				presentCommandError({
					logger: options.getLogger(),
					operation: 'Restart program',
					context: {
						brickId: fsContext.brickId
					},
					error
				})
			);
		}
	});

	// --- Emergency Stop ---
	// Unlike stopProgram, emergency stop halts ALL motors and programs on the
	// brick — a safety mechanism when the robot is behaving unexpectedly.
	const emergencyStop = vscode.commands.registerCommand('ev3-cockpit.emergencyStop', async (arg?: unknown) => {
		const controlContext = options.resolveControlAccessContext(arg);
		if ('error' in controlContext) {
			vscode.window.showErrorMessage(controlContext.error);
			return;
		}

		try {
			await withBrickOperation(controlContext.brickId, 'Emergency stop', options.onBrickOperation, async () => {
				await controlContext.controlService.emergencyStopAll();
				options.onProgramCleared('emergency-stop-command', controlContext.brickId);
			});
			vscode.window.showInformationMessage(`Emergency stop sent: ev3://${controlContext.authority}`);
		} catch (error) {
			vscode.window.showErrorMessage(
				presentCommandError({
					logger: options.getLogger(),
					operation: 'Emergency stop',
					context: {
						brickId: controlContext.brickId
					},
					error
				})
			);
		}
	});

	return {
		runRemoteProgram,
		stopProgram,
		restartProgram,
		emergencyStop
	};
}
