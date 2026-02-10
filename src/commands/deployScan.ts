import * as path from 'node:path';
import * as vscode from 'vscode';
import { RemoteFileSnapshot } from '../fs/deployIncremental';
import { createGlobMatcher } from '../fs/globMatch';
import { RemoteFsService } from '../fs/remoteFsService';
import { LocalScannedFile, ProjectScanResult, RemoteFileIndexResult } from './deployTypes';

export async function collectRemoteFileIndexRecursive(
	fsService: RemoteFsService,
	rootPath: string
): Promise<RemoteFileIndexResult> {
	const files = new Map<string, RemoteFileSnapshot>();
	const directories = new Set<string>();
	const queue: string[] = [rootPath];
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift() ?? rootPath;
		directories.add(current);
		let listing;
		try {
			listing = await fsService.listDirectory(current);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				available: false,
				truncated,
				files,
				directories: [...directories],
				message
			};
		}

		truncated = truncated || listing.truncated;
		for (const folder of listing.folders) {
			queue.push(path.posix.join(current, folder));
		}
		for (const file of listing.files) {
			const filePath = path.posix.join(current, file.name);
			files.set(filePath, {
				sizeBytes: file.size,
				md5: file.md5
			});
		}
	}

	return {
		available: true,
		truncated,
		files,
		directories: [...directories].sort((a, b) => a.localeCompare(b))
	};
}

export async function collectLocalFilesRecursive(
	root: vscode.Uri,
	options: {
		excludeDirectories: string[];
		excludeExtensions: string[];
		includeGlobs: string[];
		excludeGlobs: string[];
		maxFileBytes: number;
	}
): Promise<ProjectScanResult> {
	const files: LocalScannedFile[] = [];
	const skippedDirectories: string[] = [];
	const skippedByExtension: string[] = [];
	const skippedByIncludeGlob: string[] = [];
	const skippedByExcludeGlob: string[] = [];
	const skippedBySize: Array<{ relativePath: string; sizeBytes: number }> = [];
	const excludedDirNames = new Set(options.excludeDirectories.map((entry) => entry.toLowerCase()));
	const excludedExtensions = new Set(options.excludeExtensions.map((entry) => entry.toLowerCase()));
	const includeMatcher = createGlobMatcher(options.includeGlobs);
	const excludeMatcher = createGlobMatcher(options.excludeGlobs);

	const walk = async (dir: vscode.Uri, relativeDir: string): Promise<void> => {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(dir, name);
			const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
			if (type === vscode.FileType.Directory) {
				if (excludedDirNames.has(name.toLowerCase())) {
					skippedDirectories.push(relativePath);
					continue;
				}
				await walk(child, relativePath);
			} else if (type === vscode.FileType.File) {
				const extension = path.extname(name).toLowerCase();
				if (excludedExtensions.has(extension)) {
					skippedByExtension.push(relativePath);
					continue;
				}
				if (!includeMatcher(relativePath)) {
					skippedByIncludeGlob.push(relativePath);
					continue;
				}
				if (excludeMatcher(relativePath)) {
					skippedByExcludeGlob.push(relativePath);
					continue;
				}

				const stat = await vscode.workspace.fs.stat(child);
				if (stat.size > options.maxFileBytes) {
					skippedBySize.push({
						relativePath,
						sizeBytes: stat.size
					});
					continue;
				}

				files.push({
					localUri: child,
					relativePath,
					sizeBytes: stat.size
				});
			}
		}
	};

	await walk(root, '');
	files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	skippedDirectories.sort((a, b) => a.localeCompare(b));
	skippedByExtension.sort((a, b) => a.localeCompare(b));
	skippedByIncludeGlob.sort((a, b) => a.localeCompare(b));
	skippedByExcludeGlob.sort((a, b) => a.localeCompare(b));
	skippedBySize.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return {
		files,
		skippedDirectories,
		skippedByExtension,
		skippedByIncludeGlob,
		skippedByExcludeGlob,
		skippedBySize
	};
}
