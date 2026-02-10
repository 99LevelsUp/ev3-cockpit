import * as vscode from 'vscode';
import { Logger } from '../diagnostics/logger';
import { RemoteFileSnapshot } from '../fs/deployIncremental';
import { RemoteFsService } from '../fs/remoteFsService';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';

export interface LocalProjectFileEntry {
	localUri: vscode.Uri;
	relativePath: string;
	remotePath: string;
	sizeBytes: number;
	isExecutable: boolean;
}

export interface LocalScannedFile {
	localUri: vscode.Uri;
	relativePath: string;
	sizeBytes: number;
}

export interface ProjectScanResult {
	files: LocalScannedFile[];
	skippedDirectories: string[];
	skippedByExtension: string[];
	skippedByIncludeGlob: string[];
	skippedByExcludeGlob: string[];
	skippedBySize: Array<{ relativePath: string; sizeBytes: number }>;
}

export interface RemoteFileIndexResult {
	available: boolean;
	truncated: boolean;
	files: Map<string, RemoteFileSnapshot>;
	directories: string[];
	message?: string;
}

export interface DeployTargetContext {
	brickId: string;
	authority: string;
	rootPath?: string;
	fsService: RemoteFsService;
}

export interface DeployCommandOptions {
	getLogger(): Logger;
	resolveCommandClient(brickId: string): Ev3CommandClient | undefined;
	resolveDeployTargetFromArg(arg: unknown): DeployTargetContext | { error: string };
	resolveFsAccessContext(
		arg: unknown
	): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string };
	markProgramStarted(path: string, source: 'deploy-and-run-single' | 'deploy-project-run', brickId: string): void;
	onBrickOperation(brickId: string, operation: string): void;
}

export interface DeployCommandRegistrations {
	deployAndRunExecutable: vscode.Disposable;
	previewProjectDeploy: vscode.Disposable;
	deployProject: vscode.Disposable;
	previewProjectDeployToBrick: vscode.Disposable;
	deployProjectToBrick: vscode.Disposable;
	deployProjectAndRunExecutableToBrick: vscode.Disposable;
	deployWorkspace: vscode.Disposable;
	previewWorkspaceDeploy: vscode.Disposable;
	previewWorkspaceDeployToBrick: vscode.Disposable;
	deployWorkspaceToBrick: vscode.Disposable;
	deployWorkspaceAndRunExecutableToBrick: vscode.Disposable;
	deployProjectAndRunExecutable: vscode.Disposable;
	deployWorkspaceAndRunExecutable: vscode.Disposable;
	applyDeployProfile: vscode.Disposable;
	applyDeployProfileToBrick: vscode.Disposable;
}

export interface ProjectDeployRequest {
	runAfterDeploy: boolean;
	previewOnly: boolean;
	projectUri?: vscode.Uri;
	target?: DeployTargetContext;
}
