import type { MockFsSeedNode, MockFsSeedDir, MockFsSeedFile } from '../mockTypes';

// ---------------------------------------------------------------------------
// Internal node types
// ---------------------------------------------------------------------------

interface FsDir {
	kind: 'dir';
	name: string;
	children: Map<string, FsNode>;
}

interface FsFile {
	kind: 'file';
	name: string;
	content: Uint8Array;
}

type FsNode = FsDir | FsFile;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
	let p = path.replace(/\\/g, '/');
	if (!p.startsWith('/')) { p = '/' + p; }
	while (p.length > 1 && p.endsWith('/')) { p = p.slice(0, -1); }
	return p;
}

function splitPath(path: string): string[] {
	return normalizePath(path).split('/').filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// MockFsTree — in-memory filesystem
// ---------------------------------------------------------------------------

export interface FsEntry {
	name: string;
	isDir: boolean;
	size: number;
}

export class MockFsTree {
	private readonly root: FsDir;

	public constructor() {
		this.root = { kind: 'dir', name: '', children: new Map() };
	}

	/** List directory entries. Returns null if path doesn't exist or is a file. */
	public listDir(path: string): FsEntry[] | null {
		const dir = this.resolveDir(path);
		if (!dir) { return null; }

		const entries: FsEntry[] = [];
		for (const node of dir.children.values()) {
			entries.push({
				name: node.name,
				isDir: node.kind === 'dir',
				size: node.kind === 'file' ? node.content.length : 0
			});
		}
		return entries;
	}

	/** Read file content. Returns null if file doesn't exist. */
	public readFile(path: string): Uint8Array | null {
		const node = this.resolveNode(path);
		if (!node || node.kind !== 'file') { return null; }
		return node.content;
	}

	/** Write file. Creates parent directories as needed. Overwrites if exists. */
	public writeFile(path: string, content: Uint8Array): void {
		const parts = splitPath(path);
		if (parts.length === 0) { throw new Error('Cannot write to root'); }

		const fileName = parts[parts.length - 1];
		const dirParts = parts.slice(0, -1);
		const dir = this.ensureDir(dirParts);

		dir.children.set(fileName, { kind: 'file', name: fileName, content });
	}

	/** Create directory (including parents). */
	public mkdir(path: string): void {
		this.ensureDir(splitPath(path));
	}

	/** Delete a file or empty directory. Returns true if deleted. */
	public deleteFile(path: string): boolean {
		const parts = splitPath(path);
		if (parts.length === 0) { return false; }

		const name = parts[parts.length - 1];
		const parentParts = parts.slice(0, -1);
		const parent = this.resolveDirByParts(parentParts);
		if (!parent) { return false; }

		return parent.children.delete(name);
	}

	/** Check if a path exists. */
	public exists(path: string): boolean {
		return this.resolveNode(path) !== null;
	}

	/** Load from seed nodes. */
	public loadSeed(nodes: MockFsSeedNode[]): void {
		for (const node of nodes) {
			this.loadSeedNode(this.root, node);
		}
	}

	/** Reset to empty filesystem. */
	public clear(): void {
		this.root.children.clear();
	}

	// -- Private helpers -----------------------------------------------------

	private loadSeedNode(parent: FsDir, seed: MockFsSeedNode): void {
		if (seed.type === 'dir') {
			const dir: FsDir = { kind: 'dir', name: seed.name, children: new Map() };
			parent.children.set(seed.name, dir);
			for (const child of (seed as MockFsSeedDir).children) {
				this.loadSeedNode(dir, child);
			}
		} else {
			const file = seed as MockFsSeedFile;
			let content: Uint8Array;
			if (file.base64) {
				content = new Uint8Array(Buffer.from(file.base64, 'base64'));
			} else if (file.text) {
				content = new Uint8Array(Buffer.from(file.text, 'utf8'));
			} else {
				content = new Uint8Array(0);
			}
			parent.children.set(seed.name, { kind: 'file', name: seed.name, content });
		}
	}

	private resolveNode(path: string): FsNode | null {
		const parts = splitPath(path);
		let current: FsNode = this.root;
		for (const part of parts) {
			if (current.kind !== 'dir') { return null; }
			const child = current.children.get(part);
			if (!child) { return null; }
			current = child;
		}
		return current;
	}

	private resolveDir(path: string): FsDir | null {
		const node = this.resolveNode(path);
		if (!node || node.kind !== 'dir') { return null; }
		return node;
	}

	private resolveDirByParts(parts: string[]): FsDir | null {
		let current: FsNode = this.root;
		for (const part of parts) {
			if (current.kind !== 'dir') { return null; }
			const child = current.children.get(part);
			if (!child) { return null; }
			current = child;
		}
		return current.kind === 'dir' ? current : null;
	}

	private ensureDir(parts: string[]): FsDir {
		let current = this.root;
		for (const part of parts) {
			let child = current.children.get(part);
			if (!child) {
				child = { kind: 'dir', name: part, children: new Map() };
				current.children.set(part, child);
			} else if (child.kind !== 'dir') {
				throw new Error(`Path component "${part}" exists but is a file`);
			}
			current = child as FsDir;
		}
		return current;
	}
}
