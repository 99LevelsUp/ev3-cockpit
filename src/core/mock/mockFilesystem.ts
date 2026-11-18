import { MockFileEntry } from './mockConfig';

/** One entry as the mock reports it, mirroring what a brick listing distinguishes. */
export interface MockEntry {
	readonly name: string;
	readonly kind: 'file' | 'directory';
	readonly bytes?: number;
}

/**
 * In-memory file tree for mock filesystem testing. One instance per mock brick.
 *
 * Directories are tracked explicitly rather than inferred from file paths, because the
 * operations that matter are the ones that distinguish them: an empty directory has to be
 * listable and removable, and `delete` has to refuse a populated one exactly as the brick
 * does. A flat path set cannot represent an empty directory at all.
 */
export class MockFilesystem {
	private readonly files = new Map<string, string>();
	private readonly directories = new Set<string>();

	constructor(entries?: MockFileEntry[]) {
		if (entries) {
			for (const e of entries) {
				this.files.set(e.path, e.content);
				// Seeded files imply their ancestors, the way a real tree does.
				this.addAncestors(e.path);
			}
		}
	}

	/**
	 * Direct children of a directory.
	 *
	 * Returns bare names, as the brick does. An earlier version returned full paths, which
	 * taught a consumer developing against the mock a shape hardware never produces.
	 */
	list(directory: string): MockEntry[] {
		const prefix = directory.endsWith('/') ? directory : directory + '/';
		const seen = new Map<string, MockEntry>();

		for (const [path, content] of this.files) {
			if (!path.startsWith(prefix)) { continue; }
			const relative = path.slice(prefix.length);
			if (relative.length === 0) { continue; }
			const slash = relative.indexOf('/');
			if (slash === -1) {
				seen.set(relative, {
					name: relative,
					kind: 'file',
					bytes: Buffer.byteLength(content, 'utf8'),
				});
			} else {
				const child = relative.slice(0, slash);
				if (!seen.has(child)) { seen.set(child, { name: child, kind: 'directory' }); }
			}
		}

		for (const dir of this.directories) {
			if (!dir.startsWith(prefix)) { continue; }
			const relative = dir.slice(prefix.length);
			if (relative.length === 0 || relative.includes('/')) { continue; }
			if (!seen.has(relative)) { seen.set(relative, { name: relative, kind: 'directory' }); }
		}

		return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	read(path: string): string | undefined {
		return this.files.get(path);
	}

	write(path: string, content: string): void {
		this.files.set(path, content);
		this.addAncestors(path);
	}

	exists(path: string): boolean {
		return this.files.has(path) || this.directories.has(this.trimSlash(path));
	}

	makeDirectory(path: string): void {
		const dir = this.trimSlash(path);
		this.directories.add(dir);
		this.addAncestors(dir);
	}

	/**
	 * Removes a file, or an **empty** directory.
	 *
	 * Refuses a populated directory, because the brick does: its `DELETE_FILE` is POSIX
	 * `remove()`, which fails with ENOTEMPTY. A consumer that only ever ran against a mock
	 * that swallowed this would ship the wrong error handling.
	 */
	delete(path: string): boolean {
		if (this.files.delete(path)) { return true; }

		const dir = this.trimSlash(path);
		if (!this.directories.has(dir)) { return false; }
		if (this.list(dir).length > 0) { return false; }
		return this.directories.delete(dir);
	}

	/** Removes a path and everything beneath it, matching `opFILE/REMOVE`. */
	removeTree(path: string): void {
		const dir = this.trimSlash(path);
		const prefix = dir + '/';
		this.files.delete(dir);
		for (const p of [...this.files.keys()]) {
			if (p.startsWith(prefix)) { this.files.delete(p); }
		}
		this.directories.delete(dir);
		for (const d of [...this.directories]) {
			if (d.startsWith(prefix)) { this.directories.delete(d); }
		}
	}

	private addAncestors(path: string): void {
		const parts = this.trimSlash(path).split('/');
		// Stop before the last part: that is the entry itself, not an ancestor.
		for (let i = 1; i < parts.length; i++) {
			const ancestor = parts.slice(0, i).join('/');
			if (ancestor.length > 0) { this.directories.add(ancestor); }
		}
	}

	private trimSlash(path: string): string {
		return path.endsWith('/') ? path.slice(0, -1) : path;
	}
}
