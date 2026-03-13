/**
 * Type definitions for the deploy pipeline (plans, results, options).
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { Logger } from '../diagnostics/logger';
import { RemoteFileSnapshot } from '../fs/deployIncremental';
import { RemoteFsService } from '../fs/remoteFsService';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';

/**
 * A mapped file entry representing a local file prepared for deployment to the EV3 brick.
 *
 * @remarks
 * Each entry captures both the local source location and the computed remote
 * destination path, along with metadata used during transfer (size, executable flag).
 * Produced by mapping a {@link LocalScannedFile} against the deploy target's root path.
 */
export interface LocalProjectFileEntry {
	/** Absolute URI of the file on the local filesystem. */
	localUri: vscode.Uri;

	/** Path relative to the project root (e.g. `"src/main.rbf"`). */
	relativePath: string;

	/** Fully-qualified remote path on the EV3 brick (e.g. `"/home/robot/project/src/main.rbf"`). */
	remotePath: string;

	/** Size of the local file in bytes, used for transfer progress and size-limit checks. */
	sizeBytes: number;

	/** Whether the file should be marked as executable on the EV3 brick after transfer. */
	isExecutable: boolean;
}

/**
 * A local file discovered during a project directory scan.
 *
 * @remarks
 * Represents a raw scan result before any remote-path mapping is applied.
 * Files that pass all include/exclude filters and size limits appear as
 * {@link LocalScannedFile} entries in the {@link ProjectScanResult.files} array.
 */
export interface LocalScannedFile {
	/** Absolute URI of the discovered file on the local filesystem. */
	localUri: vscode.Uri;

	/** Path relative to the scanned project root directory. */
	relativePath: string;

	/** Size of the file in bytes, as reported by the local filesystem. */
	sizeBytes: number;
}

/**
 * Result of scanning a local project directory for deployable files.
 *
 * @remarks
 * In addition to the matched files, the result tracks every file and directory
 * that was skipped and the reason it was excluded. This information is surfaced
 * in the deploy-preview UI so the user can diagnose unexpected omissions.
 *
 * @see {@link LocalScannedFile}
 */
export interface ProjectScanResult {
	/** Files that passed all filters and are eligible for deployment. */
	files: LocalScannedFile[];

	/** Relative paths of directories skipped entirely (e.g. `node_modules`, `.git`). */
	skippedDirectories: string[];

	/** Relative paths of files skipped because their extension is not in the allowed set. */
	skippedByExtension: string[];

	/** Relative paths of files skipped because they did not match any include glob pattern. */
	skippedByIncludeGlob: string[];

	/** Relative paths of files skipped because they matched an exclude glob pattern. */
	skippedByExcludeGlob: string[];

	/** Files skipped because they exceeded the configured maximum file-size limit. */
	skippedBySize: Array<{ relativePath: string; sizeBytes: number }>;
}

/**
 * Result of indexing the remote file tree on the EV3 brick.
 *
 * @remarks
 * Used by incremental deploy to determine which files already exist on the
 * brick and whether they match the local versions. When {@link available} is
 * `false`, the index could not be retrieved (e.g. the brick is offline) and
 * a full deploy should be performed instead.
 *
 * @see {@link RemoteFileSnapshot}
 */
export interface RemoteFileIndexResult {
	/** Whether the remote index was successfully retrieved from the brick. */
	available: boolean;

	/**
	 * Whether the file listing was truncated due to a response-size or
	 * entry-count limit imposed by the EV3 protocol.
	 */
	truncated: boolean;

	/**
	 * Map of remote relative paths to their {@link RemoteFileSnapshot} metadata.
	 * Used for diffing against local files during incremental deploy.
	 */
	files: Map<string, RemoteFileSnapshot>;

	/** Remote directories present under the deploy root on the brick. */
	directories: string[];

	/** Optional human-readable status or error message from the indexing operation. */
	message?: string;
}

/**
 * Resolved target brick context for a deploy operation.
 *
 * @remarks
 * Encapsulates all the information needed to address a specific brick and
 * its remote filesystem during deployment: the brick identity, the URI
 * authority for the `ev3://` filesystem scheme, an optional custom deploy
 * root, and the {@link RemoteFsService} instance used for file operations.
 */
export interface DeployTargetContext {
	/** Unique brick identifier (e.g. `"usb-00:16:53:xx:xx:xx"`). */
	brickId: string;

	/**
	 * Authority segment used in `ev3://` URIs to address this brick.
	 * May be a brick ID or the virtual alias `"active"`.
	 */
	authority: string;

	/**
	 * Optional remote root directory for deployment.
	 * When omitted, the default deploy root from configuration is used.
	 */
	rootPath?: string;

	/** Remote filesystem service bound to the target brick. */
	fsService: RemoteFsService;
}

/**
 * Dependency-injection options supplied when registering deploy commands.
 *
 * @remarks
 * Provides the deploy command handlers with access to logging, brick resolution,
 * command-client lookup, and lifecycle hooks without coupling them to the
 * extension's top-level wiring. Each method is a callback supplied by the
 * extension activation routine.
 *
 * @see {@link DeployTargetContext}
 * @see {@link Ev3CommandClient}
 */
export interface DeployCommandOptions {
	/**
	 * Returns the shared {@link Logger} instance for deploy diagnostics.
	 *
	 * @returns The extension's logger.
	 */
	getLogger(): Logger;

	/**
	 * Resolves the low-level EV3 command client for a given brick.
	 *
	 * @param brickId - Unique identifier of the target brick.
	 * @returns The {@link Ev3CommandClient} for the brick, or `undefined` if
	 *          no active session exists.
	 */
	resolveCommandClient(brickId: string): Ev3CommandClient | undefined;

	/**
	 * Resolves a {@link DeployTargetContext} from a command argument.
	 *
	 * @remarks
	 * The argument typically originates from a tree-view item or command palette
	 * selection. Returns an error object when the argument cannot be mapped to a
	 * valid deploy target.
	 *
	 * @param arg - Raw command argument passed by VS Code.
	 * @returns A resolved {@link DeployTargetContext} or an `{ error }` descriptor.
	 */
	resolveDeployTargetFromArg(arg: unknown): DeployTargetContext | { error: string };

	/**
	 * Resolves a filesystem-access context from a command argument.
	 *
	 * @remarks
	 * Similar to {@link resolveDeployTargetFromArg} but returns a lighter context
	 * suitable for read-only filesystem operations (e.g. previewing remote files).
	 *
	 * @param arg - Raw command argument passed by VS Code.
	 * @returns A context with brick identity and {@link RemoteFsService}, or an
	 *          `{ error }` descriptor.
	 */
	resolveFsAccessContext(
		arg: unknown
	): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string };

	/**
	 * Records that a program has been started on the brick after deployment.
	 *
	 * @param path - Remote path of the executed program file.
	 * @param source - Which deploy-and-run command initiated the execution.
	 * @param brickId - Unique identifier of the brick running the program.
	 */
	markProgramStarted(path: string, source: 'deploy-and-run-single' | 'deploy-project-run', brickId: string): void;

	/**
	 * Lifecycle hook invoked when a brick operation (deploy, run, etc.) begins.
	 *
	 * @param brickId - Unique identifier of the brick.
	 * @param operation - Human-readable name of the operation (e.g. `"deploy"`, `"run"`).
	 */
	onBrickOperation(brickId: string, operation: string): void;
}

/**
 * Disposable registrations for all deploy-related VS Code commands.
 *
 * @remarks
 * Returned by the deploy-command registration function so the extension can
 * dispose of every command subscription on deactivation. Each property
 * corresponds to a single `vscode.commands.registerCommand` call.
 *
 * Commands suffixed with `ToBrick` target a specific brick (passed as an
 * argument), while their unsuffixed counterparts target the currently
 * active brick. `preview*` variants perform a dry-run without transferring files.
 */
export interface DeployCommandRegistrations {
	/** Deploy a single executable file to the active brick and run it. */
	deployAndRunExecutable: vscode.Disposable;

	/** Preview (dry-run) a project deploy to the active brick. */
	previewProjectDeploy: vscode.Disposable;

	/** Deploy the current project to the active brick. */
	deployProject: vscode.Disposable;

	/** Preview (dry-run) a project deploy to a specific brick. */
	previewProjectDeployToBrick: vscode.Disposable;

	/** Deploy the current project to a specific brick. */
	deployProjectToBrick: vscode.Disposable;

	/** Deploy the current project to a specific brick and run its executable. */
	deployProjectAndRunExecutableToBrick: vscode.Disposable;

	/** Deploy the entire workspace to the active brick. */
	deployWorkspace: vscode.Disposable;

	/** Preview (dry-run) a workspace deploy to the active brick. */
	previewWorkspaceDeploy: vscode.Disposable;

	/** Preview (dry-run) a workspace deploy to a specific brick. */
	previewWorkspaceDeployToBrick: vscode.Disposable;

	/** Deploy the entire workspace to a specific brick. */
	deployWorkspaceToBrick: vscode.Disposable;

	/** Deploy the entire workspace to a specific brick and run its executable. */
	deployWorkspaceAndRunExecutableToBrick: vscode.Disposable;

	/** Deploy the current project to the active brick and run its executable. */
	deployProjectAndRunExecutable: vscode.Disposable;

	/** Deploy the entire workspace to the active brick and run its executable. */
	deployWorkspaceAndRunExecutable: vscode.Disposable;

	/** Apply a saved deploy profile to the active brick. */
	applyDeployProfile: vscode.Disposable;

	/** Apply a saved deploy profile to a specific brick. */
	applyDeployProfileToBrick: vscode.Disposable;
}

/**
 * Request options for a project deploy operation.
 *
 * @remarks
 * Passed to the deploy orchestrator to control the scope and behaviour of a
 * single deploy invocation. Optional fields allow the caller to pre-select the
 * project or target brick; when omitted, the orchestrator prompts the user or
 * uses defaults.
 *
 * @see {@link DeployTargetContext}
 */
export interface ProjectDeployRequest {
	/** When `true`, the project's executable is launched on the brick after a successful deploy. */
	runAfterDeploy: boolean;

	/** When `true`, performs a dry-run: computes the file diff but does not transfer any files. */
	previewOnly: boolean;

	/**
	 * Optional URI of the project folder to deploy.
	 * When omitted, the orchestrator selects the active workspace folder.
	 */
	projectUri?: vscode.Uri;

	/**
	 * Optional pre-resolved deploy target.
	 * When omitted, the orchestrator resolves the target from the active brick.
	 */
	target?: DeployTargetContext;
}
