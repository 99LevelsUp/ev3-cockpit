/**
 * Scans workspace and remote brick for deployable files and builds file indexes.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { RemoteFileSnapshot } from '../fs/deployIncremental';
import { createGlobMatcher } from '../fs/globMatch';
import { RemoteFsService } from '../fs/remoteFsService';
import { LocalScannedFile, ProjectScanResult, RemoteFileIndexResult } from './deployTypes';

/**
 * Recursively indexes all files and directories on the remote EV3 brick
 * starting from a given root path using breadth-first traversal.
 *
 * @remarks
 * Builds a complete map of `remotePath → { sizeBytes, md5 }` snapshots
 * and a sorted list of directories. Used by the deploy pipeline for
 * incremental diff comparisons and stale-entry cleanup planning.
 *
 * If any directory listing fails, the walk aborts gracefully and returns
 * `available: false` with the partial data collected so far. The `truncated`
 * flag is sticky — once any listing reports truncation, the overall result
 * is marked truncated.
 *
 * @param fsService - Remote filesystem service for the target brick.
 * @param rootPath - POSIX-style absolute root path to start indexing from.
 * @returns A {@link RemoteFileIndexResult} with the file map, directory list,
 *   availability flag, and optional error message.
 *
 * @example
 * ```ts
 * const index = await collectRemoteFileIndexRecursive(fsService, '/home/root/lms2012/prjs/MyProject/');
 * if (index.available) {
 *   console.log(`${index.files.size} remote files indexed`);
 * }
 * ```
 *
 * @see {@link RemoteFileIndexResult}
 * @see {@link collectLocalFilesRecursive}
 */
export async function collectRemoteFileIndexRecursive(
	fsService: RemoteFsService,
	rootPath: string
): Promise<RemoteFileIndexResult> {
	const files = new Map<string, RemoteFileSnapshot>();
	const directories = new Set<string>();
	// BFS queue seeded with the root path
	const queue: string[] = [rootPath];
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift() ?? rootPath;
		directories.add(current);
		let listing;
		try {
			listing = await fsService.listDirectory(current);
		} catch (error) {
			// Abort gracefully on any directory listing failure, returning partial data
			const message = error instanceof Error ? error.message : String(error);
			return {
				available: false,
				truncated,
				files,
				directories: [...directories],
				message
			};
		}

		// Sticky truncation: once any listing is truncated, the whole index is
		truncated = truncated || listing.truncated;
		// Enqueue child directories for BFS traversal
		for (const folder of listing.folders) {
			queue.push(path.posix.join(current, folder));
		}
		// Index each file by its full remote path
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

/**
 * Recursively scans a local workspace directory, applying a five-stage
 * filtering pipeline to select files eligible for deploy.
 *
 * @remarks
 * Filtering stages (applied in order):
 * 1. **Exclude directories** — directory names matched case-insensitively
 * 2. **Exclude extensions** — file extensions matched case-insensitively
 * 3. **Include globs** — file must match at least one include glob (if any)
 * 4. **Exclude globs** — file must NOT match any exclude glob
 * 5. **Max file size** — files larger than `maxFileBytes` are skipped
 *
 * Each skipped entry is recorded in the appropriate skip-reason array for
 * diagnostic logging. Results are sorted alphabetically for deterministic output.
 *
 * @param root - VS Code URI of the local workspace directory to scan.
 * @param options - Filtering options:
 *   - `excludeDirectories` — directory names to skip (e.g. `['node_modules', '.git']`)
 *   - `excludeExtensions` — file extensions to skip (e.g. `['.map', '.d.ts']`)
 *   - `includeGlobs` — glob patterns files must match (empty = match all)
 *   - `excludeGlobs` — glob patterns that exclude matching files
 *   - `maxFileBytes` — maximum file size in bytes
 * @returns A {@link ProjectScanResult} with accepted files and skip-reason arrays.
 *
 * @example
 * ```ts
 * const scan = await collectLocalFilesRecursive(workspaceUri, {
 *   excludeDirectories: ['node_modules'],
 *   excludeExtensions: ['.map'],
 *   includeGlobs: ['**\/*'],
 *   excludeGlobs: [],
 *   maxFileBytes: 1_000_000
 * });
 * console.log(`${scan.files.length} files eligible for deploy`);
 * ```
 *
 * @see {@link ProjectScanResult}
 * @see {@link collectRemoteFileIndexRecursive}
 */
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
	// Pre-compute lookup sets and compiled matchers for efficient filtering
	const excludedDirNames = new Set(options.excludeDirectories.map((entry) => entry.toLowerCase()));
	const excludedExtensions = new Set(options.excludeExtensions.map((entry) => entry.toLowerCase()));
	const includeMatcher = createGlobMatcher(options.includeGlobs);
	const excludeMatcher = createGlobMatcher(options.excludeGlobs);

	/** Recursive inner walk that applies the five-stage filter pipeline. */
	const walk = async (dir: vscode.Uri, relativeDir: string): Promise<void> => {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(dir, name);
			const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
			if (type === vscode.FileType.Directory) {
				// Stage 1: Exclude directories by name
				if (excludedDirNames.has(name.toLowerCase())) {
					skippedDirectories.push(relativePath);
					continue;
				}
				await walk(child, relativePath);
			} else if (type === vscode.FileType.File) {
				// Stage 2: Exclude by file extension
				const extension = path.extname(name).toLowerCase();
				if (excludedExtensions.has(extension)) {
					skippedByExtension.push(relativePath);
					continue;
				}
				// Stage 3: Include glob filter (must match at least one)
				if (!includeMatcher(relativePath)) {
					skippedByIncludeGlob.push(relativePath);
					continue;
				}
				// Stage 4: Exclude glob filter (must not match any)
				if (excludeMatcher(relativePath)) {
					skippedByExcludeGlob.push(relativePath);
					continue;
				}

				// Stage 5: Maximum file size check
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
	// Sort all output arrays for deterministic, reproducible results
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
