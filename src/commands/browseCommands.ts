import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFeatureConfig } from '../config/featureConfig';
import { BrickRegistry } from '../device/brickRegistry';
import { Logger } from '../diagnostics/logger';
import { buildRemoteChildPath, buildRemotePathFromLocal, isValidRemoteEntryName } from '../fs/browserActions';
import { isLikelyBinaryPath } from '../fs/fileKind';
import { isRemoteExecutablePath, runRemoteExecutable } from '../fs/remoteExecutable';
import { RemoteFsService } from '../fs/remoteFsService';
import {
	BrickTreeProvider,
	isBrickDirectoryNode,
	isBrickFileNode,
	isBrickRootNode
} from '../ui/brickTreeProvider';

type ProgramStartSource = 'remote-fs-run';

interface BrowseCommandOptions {
	getLogger(): Logger;
	getBrickRegistry(): BrickRegistry;
	getTreeProvider(): BrickTreeProvider;
	resolveFsAccessContext(arg: unknown): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string };
	resolveBrickIdFromCommandArg(arg: unknown): string;
	markProgramStarted(path: string, source: ProgramStartSource, brickId: string): void;
}

interface BrowseCommandRegistrations {
	browseRemoteFs: vscode.Disposable;
	refreshBricksView: vscode.Disposable;
	uploadToBrickFolder: vscode.Disposable;
	deleteRemoteEntryFromTree: vscode.Disposable;
	runRemoteExecutableFromTree: vscode.Disposable;
}

export function registerBrowseCommands(options: BrowseCommandOptions): BrowseCommandRegistrations {
	const browseRemoteFs = vscode.commands.registerCommand('ev3-cockpit.browseRemoteFs', async (arg?: unknown) => {
		const logger = options.getLogger();
		const brickRegistry = options.getBrickRegistry();
		const fsContext = options.resolveFsAccessContext(arg);
		if ('error' in fsContext) {
			vscode.window.showErrorMessage(fsContext.error);
			return;
		}
		const { brickId, authority, fsService } = fsContext;
		const rootSnapshot = brickRegistry.getSnapshot(brickId);

		const handleBinaryFile = async (uri: vscode.Uri, remotePath: string): Promise<void> => {
			const items: Array<
				vscode.QuickPickItem & {
					action: 'preview' | 'download' | 'run';
				}
			> = [
				{
					label: 'Open Preview',
					description: 'Open in editor preview (binary/text detection handled by VS Code).',
					action: 'preview'
				},
				{
					label: 'Download to Local...',
					description: 'Save a local copy of this remote EV3 file.',
					action: 'download'
				}
			];
			if (isRemoteExecutablePath(remotePath)) {
				items.push({
					label: 'Run on EV3',
					description: 'Run this file on EV3 using the registered executable handler.',
					action: 'run'
				});
			}

			const action = await vscode.window.showQuickPick(items, {
				title: `Binary file: ${path.posix.basename(remotePath)}`,
				placeHolder: 'Choose action'
			});
			if (!action) {
				return;
			}

			if (action.action === 'preview') {
				await vscode.commands.executeCommand('vscode.open', uri);
				return;
			}

			if (action.action === 'run') {
				try {
					const executable = await runRemoteExecutable(fsService, remotePath);
					options.markProgramStarted(remotePath, 'remote-fs-run', brickId);
					logger.info('Remote FS run program completed', {
						path: remotePath,
						type: executable.typeId
					});
					vscode.window.showInformationMessage(`Program started: ev3://${authority}${remotePath}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Remote FS run program failed', {
						path: remotePath,
						message
					});
					vscode.window.showErrorMessage(`Cannot run ${uri.toString()}. Detail: ${message}`);
				}
				return;
			}

			const defaultFileName = path.posix.basename(remotePath) || 'ev3-binary.bin';
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
			const target = await vscode.window.showSaveDialog({
				saveLabel: 'Download EV3 File',
				defaultUri:
					workspaceRoot !== undefined
						? vscode.Uri.joinPath(workspaceRoot, defaultFileName)
						: vscode.Uri.file(path.join(process.cwd(), defaultFileName))
			});
			if (!target) {
				return;
			}

			const bytes = await vscode.workspace.fs.readFile(uri);
			await vscode.workspace.fs.writeFile(target, bytes);
			vscode.window.showInformationMessage(`Downloaded ${uri.toString()} to ${target.fsPath}.`);
		};

		const featureConfig = readFeatureConfig();
		let currentPath = rootSnapshot?.rootPath ?? featureConfig.fs.defaultRoots[0] ?? '/';
		if (!currentPath.startsWith('/')) {
			currentPath = `/${currentPath}`;
		}
		if (!currentPath.endsWith('/')) {
			currentPath = `${currentPath}/`;
		}

		let browsing = true;
		while (browsing) {
			let listing;
			try {
				listing = await fsService.listDirectory(currentPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn('Remote FS browse listing failed', {
					path: currentPath,
					message
				});
				vscode.window.showErrorMessage(`EV3 browse failed for ${currentPath}: ${message}`);
				break;
			}
			type FsQuickPick = vscode.QuickPickItem & {
				action: 'up' | 'dir' | 'file' | 'upload' | 'mkdir' | 'delete';
				targetPath: string;
			};

			const picks: FsQuickPick[] = [];
			picks.push({
				label: '$(upload) Upload File Here...',
				description: currentPath,
				action: 'upload',
				targetPath: currentPath
			});
			picks.push({
				label: '$(new-folder) Create Folder...',
				description: currentPath,
				action: 'mkdir',
				targetPath: currentPath
			});
			picks.push({
				label: '$(trash) Delete Entry...',
				description: currentPath,
				action: 'delete',
				targetPath: currentPath
			});

			if (currentPath !== '/') {
				const trimmed = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath;
				const parent = path.posix.dirname(trimmed);
				picks.push({
					label: '$(arrow-up) ..',
					description: parent,
					action: 'up',
					targetPath: parent === '/' ? '/' : `${parent}/`
				});
			}

			for (const folder of [...listing.folders].sort((a, b) => a.localeCompare(b))) {
				const targetPath = path.posix.join(currentPath, folder);
				picks.push({
					label: `$(folder) ${folder}/`,
					description: targetPath,
					action: 'dir',
					targetPath: `${targetPath}/`
				});
			}

			for (const file of [...listing.files].sort((a, b) => a.name.localeCompare(b.name))) {
				const targetPath = path.posix.join(currentPath, file.name);
				picks.push({
					label: `$(file) ${file.name}`,
					description: `${file.size} B`,
					detail: targetPath,
					action: 'file',
					targetPath
				});
			}

			const selected = await vscode.window.showQuickPick(picks, {
				title: `ev3://${authority}${currentPath}`,
				placeHolder: 'Select folder to enter or file to open'
			});
			if (!selected) {
				browsing = false;
				continue;
			}

			if (selected.action === 'up' || selected.action === 'dir') {
				currentPath = selected.targetPath;
				continue;
			}

			if (selected.action === 'upload') {
				const locals = await vscode.window.showOpenDialog({
					canSelectMany: true,
					canSelectFolders: false,
					canSelectFiles: true,
					openLabel: 'Upload to EV3'
				});
				if (!locals || locals.length === 0) {
					continue;
				}

				let uploaded = 0;
				for (const local of locals) {
					const remotePath = buildRemotePathFromLocal(currentPath, local.fsPath);
					try {
						const bytes = await vscode.workspace.fs.readFile(local);
						await fsService.writeFile(remotePath, bytes);
						uploaded += 1;
					} catch (error) {
						logger.warn('Remote FS upload failed', {
							localPath: local.fsPath,
							remotePath,
							message: error instanceof Error ? error.message : String(error)
						});
					}
				}

				if (uploaded > 0) {
					vscode.window.showInformationMessage(`Uploaded ${uploaded} file(s) to ev3://${authority}${currentPath}`);
					options.getTreeProvider().refreshDirectory(brickId, currentPath);
				}
				continue;
			}

			if (selected.action === 'mkdir') {
				const folderName = await vscode.window.showInputBox({
					title: `Create folder in ev3://${authority}${currentPath}`,
					placeHolder: 'Folder name',
					validateInput: (value) =>
						isValidRemoteEntryName(value) ? undefined : 'Use non-empty name without "/" or "\\".'
				});
				if (!folderName) {
					continue;
				}

				const remotePath = buildRemoteChildPath(currentPath, folderName);
				try {
					await fsService.createDirectory(remotePath);
					vscode.window.showInformationMessage(`Folder created: ev3://${authority}${remotePath}`);
					options.getTreeProvider().refreshDirectory(brickId, currentPath);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Remote FS mkdir failed', {
						path: remotePath,
						message
					});
					vscode.window.showErrorMessage(`Cannot create folder ${remotePath}. Detail: ${message}`);
				}
				continue;
			}

			if (selected.action === 'delete') {
				type DeletePick = vscode.QuickPickItem & {
					targetPath: string;
					isDirectory: boolean;
				};

				const deleteTargets: DeletePick[] = [
					...listing.folders
						.sort((a, b) => a.localeCompare(b))
						.map((folder) => ({
							label: `$(folder) ${folder}/`,
							targetPath: buildRemoteChildPath(currentPath, folder),
							isDirectory: true
						})),
					...listing.files
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((file) => ({
							label: `$(file) ${file.name}`,
							targetPath: buildRemoteChildPath(currentPath, file.name),
							isDirectory: false
						}))
				];

				if (deleteTargets.length === 0) {
					vscode.window.showInformationMessage(`Nothing to delete in ev3://${authority}${currentPath}`);
					continue;
				}

				const toDelete = await vscode.window.showQuickPick(deleteTargets, {
					title: `Delete entry in ev3://${authority}${currentPath}`,
					placeHolder: 'Select file or folder to delete'
				});
				if (!toDelete) {
					continue;
				}

				const confirm = await vscode.window.showWarningMessage(
					`Delete ev3://${authority}${toDelete.targetPath}?`,
					{ modal: true },
					'Delete'
				);
				if (confirm !== 'Delete') {
					continue;
				}

				const targetUri = vscode.Uri.parse(`ev3://${authority}${toDelete.targetPath}`);
				try {
					await vscode.workspace.fs.delete(targetUri, { recursive: toDelete.isDirectory, useTrash: false });
					vscode.window.showInformationMessage(`Deleted ev3://${authority}${toDelete.targetPath}`);
					options.getTreeProvider().refreshDirectory(brickId, currentPath);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Remote FS delete failed', {
						path: toDelete.targetPath,
						message
					});
					vscode.window.showErrorMessage(`Cannot delete ${targetUri.toString()}. Detail: ${message}`);
				}
				continue;
			}

			const uri = vscode.Uri.parse(`ev3://${authority}${selected.targetPath}`);
			try {
				if (isLikelyBinaryPath(selected.targetPath)) {
					await handleBinaryFile(uri, selected.targetPath);
					continue;
				}

				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, {
					preview: false
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/binary/i.test(message)) {
					await handleBinaryFile(uri, selected.targetPath);
					continue;
				}

				logger.warn('Remote FS open failed', {
					path: selected.targetPath,
					message
				});
				vscode.window.showErrorMessage(`Cannot open ${uri.toString()}. Detail: ${message}`);
			}
		}
	});

	const refreshBricksView = vscode.commands.registerCommand('ev3-cockpit.refreshBricksView', async () => {
		options.getTreeProvider().refresh();
	});

	const uploadToBrickFolder = vscode.commands.registerCommand(
		'ev3-cockpit.uploadToBrickFolder',
		async (node?: unknown) => {
			const logger = options.getLogger();
			const brickRegistry = options.getBrickRegistry();
			const treeProvider = options.getTreeProvider();
			const brickId = options.resolveBrickIdFromCommandArg(node);
			const fsContext = options.resolveFsAccessContext(brickId);
			if ('error' in fsContext) {
				vscode.window.showErrorMessage(fsContext.error);
				return;
			}

			let targetPath = '/';
			if (isBrickRootNode(node)) {
				targetPath = node.rootPath;
			} else if (isBrickDirectoryNode(node)) {
				targetPath = node.remotePath;
			} else {
				const snapshot = brickRegistry.getSnapshot(fsContext.brickId);
				targetPath = snapshot?.rootPath ?? '/home/root/lms2012/prjs/';
			}

			const localFiles = await vscode.window.showOpenDialog({
				canSelectMany: true,
				canSelectFolders: false,
				canSelectFiles: true,
				openLabel: 'Upload to EV3'
			});
			if (!localFiles || localFiles.length === 0) {
				return;
			}

			let uploaded = 0;
			for (const localUri of localFiles) {
				const remotePath = buildRemotePathFromLocal(targetPath, localUri.fsPath);
				try {
					const bytes = await vscode.workspace.fs.readFile(localUri);
					await fsContext.fsService.writeFile(remotePath, bytes);
					uploaded += 1;
				} catch (error) {
					logger.warn('Tree upload failed', {
						brickId: fsContext.brickId,
						localPath: localUri.fsPath,
						remotePath,
						message: error instanceof Error ? error.message : String(error)
					});
				}
			}

			if (uploaded > 0) {
				vscode.window.showInformationMessage(
					`Uploaded ${uploaded} file(s) to ev3://${fsContext.authority}${targetPath}`
				);
				treeProvider.refreshDirectory(fsContext.brickId, targetPath);
			}
		}
	);

	const deleteRemoteEntryFromTree = vscode.commands.registerCommand(
		'ev3-cockpit.deleteRemoteEntryFromTree',
		async (node?: unknown) => {
			const treeProvider = options.getTreeProvider();
			if (!isBrickDirectoryNode(node) && !isBrickFileNode(node)) {
				vscode.window.showErrorMessage('Select a remote file or folder in EV3 Cockpit Bricks view.');
				return;
			}

			const fsContext = options.resolveFsAccessContext(node.brickId);
			if ('error' in fsContext) {
				vscode.window.showErrorMessage(fsContext.error);
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Delete ev3://${fsContext.authority}${node.remotePath}?`,
				{ modal: true },
				'Delete'
			);
			if (confirm !== 'Delete') {
				return;
			}

			const targetUri = vscode.Uri.parse(`ev3://${fsContext.authority}${node.remotePath}`);
			try {
				await vscode.workspace.fs.delete(targetUri, {
					recursive: isBrickDirectoryNode(node),
					useTrash: false
				});
				treeProvider.refreshDirectory(node.brickId, path.posix.dirname(node.remotePath));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Cannot delete ${targetUri.toString()}. Detail: ${message}`);
			}
		}
	);

	const runRemoteExecutableFromTree = vscode.commands.registerCommand(
		'ev3-cockpit.runRemoteExecutableFromTree',
		async (node?: unknown) => {
			const logger = options.getLogger();
			if (!isBrickFileNode(node) || !isRemoteExecutablePath(node.remotePath)) {
				vscode.window.showErrorMessage('Select an executable file in EV3 Cockpit Bricks view.');
				return;
			}

			const fsContext = options.resolveFsAccessContext(node.brickId);
			if ('error' in fsContext) {
				vscode.window.showErrorMessage(fsContext.error);
				return;
			}

			try {
				const executable = await runRemoteExecutable(fsContext.fsService, node.remotePath);
				options.markProgramStarted(node.remotePath, 'remote-fs-run', fsContext.brickId);
				logger.info('Tree run executable completed', {
					path: node.remotePath,
					type: executable.typeId,
					brickId: fsContext.brickId
				});
				vscode.window.showInformationMessage(`Program started: ev3://${fsContext.authority}${node.remotePath}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Run failed: ${message}`);
			}
		}
	);

	return {
		browseRemoteFs,
		refreshBricksView,
		uploadToBrickFolder,
		deleteRemoteEntryFromTree,
		runRemoteExecutableFromTree
	};
}
