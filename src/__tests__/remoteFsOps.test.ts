import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { copyRemotePath, deleteRemotePath, getRemotePathKind, renameRemotePath, RemoteFsLike, RemoteFsPathError } from '../fs/remoteFsOps';

class InMemoryRemoteFs implements RemoteFsLike {
	private readonly directories = new Set<string>(['/']);
	private readonly files = new Map<string, Uint8Array>();

	public addDirectory(dirPath: string): void {
		this.directories.add(this.norm(dirPath));
	}

	public addFile(filePath: string, data: Uint8Array): void {
		const full = this.norm(filePath);
		const parent = path.posix.dirname(full);
		this.directories.add(parent);
		this.files.set(full, data.slice());
	}

	public async listDirectory(remotePath: string): Promise<{ folders: string[]; files: Array<{ name: string }> }> {
		const root = this.norm(remotePath);
		if (!this.directories.has(root)) {
			throw new Error(`directory not found: ${root}`);
		}

		const folders = new Set<string>();
		const files: Array<{ name: string }> = [];

		for (const dir of this.directories) {
			if (dir === root || !dir.startsWith(`${root === '/' ? '' : root}/`)) {
				continue;
			}
			const relative = dir.slice((root === '/' ? '' : root).length + 1);
			if (!relative.includes('/')) {
				folders.add(relative);
			}
		}

		for (const filePath of this.files.keys()) {
			if (!filePath.startsWith(`${root === '/' ? '' : root}/`)) {
				continue;
			}
			const relative = filePath.slice((root === '/' ? '' : root).length + 1);
			if (!relative.includes('/')) {
				files.push({ name: relative });
			}
		}

		return {
			folders: Array.from(folders),
			files
		};
	}

	public async readFile(remotePath: string): Promise<Uint8Array> {
		const full = this.norm(remotePath);
		const data = this.files.get(full);
		if (!data) {
			throw new Error(`file not found: ${full}`);
		}
		return data.slice();
	}

	public async writeFile(remotePath: string, contents: Uint8Array): Promise<void> {
		const full = this.norm(remotePath);
		const parent = path.posix.dirname(full);
		if (!this.directories.has(parent)) {
			throw new Error(`parent not found: ${parent}`);
		}
		this.files.set(full, contents.slice());
	}

	public async createDirectory(remotePath: string): Promise<void> {
		const full = this.norm(remotePath);
		const parent = path.posix.dirname(full);
		if (!this.directories.has(parent)) {
			throw new Error(`parent not found: ${parent}`);
		}
		this.directories.add(full);
	}

	public async deleteFile(remotePath: string): Promise<void> {
		const full = this.norm(remotePath);
		if (this.files.delete(full)) {
			return;
		}
		if (this.directories.has(full)) {
			this.directories.delete(full);
			return;
		}
		throw new Error(`path not found: ${full}`);
	}

	public hasFile(remotePath: string): boolean {
		return this.files.has(this.norm(remotePath));
	}

	public hasDirectory(remotePath: string): boolean {
		return this.directories.has(this.norm(remotePath));
	}

	private norm(p: string): string {
		const unified = p.replace(/\\/g, '/');
		return unified.startsWith('/') ? unified : `/${unified}`;
	}
}

test('remoteFsOps copy file copies data and requires overwrite for existing destination', async () => {
	const fs = new InMemoryRemoteFs();
	fs.addDirectory('/home');
	fs.addDirectory('/home/root');
	fs.addDirectory('/home/root/lms2012');
	fs.addDirectory('/home/root/lms2012/prjs');
	fs.addFile('/home/root/lms2012/prjs/a.txt', new Uint8Array([1, 2, 3]));
	fs.addFile('/home/root/lms2012/prjs/b.txt', new Uint8Array([9]));

	await assert.rejects(
		copyRemotePath(fs, '/home/root/lms2012/prjs/a.txt', '/home/root/lms2012/prjs/b.txt', { overwrite: false }),
		(error: unknown) => error instanceof RemoteFsPathError && error.code === 'ALREADY_EXISTS'
	);

	await copyRemotePath(fs, '/home/root/lms2012/prjs/a.txt', '/home/root/lms2012/prjs/b.txt', { overwrite: true });
	const copied = await fs.readFile('/home/root/lms2012/prjs/b.txt');
	assert.deepEqual(Array.from(copied), [1, 2, 3]);
});

test('remoteFsOps rename file moves content and deletes source', async () => {
	const fs = new InMemoryRemoteFs();
	fs.addDirectory('/home');
	fs.addDirectory('/home/root');
	fs.addDirectory('/home/root/lms2012');
	fs.addDirectory('/home/root/lms2012/prjs');
	fs.addFile('/home/root/lms2012/prjs/src.txt', new Uint8Array([5, 6]));

	await renameRemotePath(fs, '/home/root/lms2012/prjs/src.txt', '/home/root/lms2012/prjs/dst.txt', { overwrite: false });
	assert.equal(fs.hasFile('/home/root/lms2012/prjs/src.txt'), false);
	assert.equal(fs.hasFile('/home/root/lms2012/prjs/dst.txt'), true);
});

test('remoteFsOps copy directory recursively and prevents copy into itself', async () => {
	const fs = new InMemoryRemoteFs();
	fs.addDirectory('/home');
	fs.addDirectory('/home/root');
	fs.addDirectory('/home/root/lms2012');
	fs.addDirectory('/home/root/lms2012/prjs');
	fs.addDirectory('/home/root/lms2012/prjs/dir1');
	fs.addDirectory('/home/root/lms2012/prjs/dir1/sub');
	fs.addFile('/home/root/lms2012/prjs/dir1/sub/file.bin', new Uint8Array([7]));

	await copyRemotePath(fs, '/home/root/lms2012/prjs/dir1', '/home/root/lms2012/prjs/dir2', { overwrite: false });
	assert.equal(fs.hasDirectory('/home/root/lms2012/prjs/dir2'), true);
	assert.equal(fs.hasDirectory('/home/root/lms2012/prjs/dir2/sub'), true);
	assert.equal(fs.hasFile('/home/root/lms2012/prjs/dir2/sub/file.bin'), true);

	await assert.rejects(
		copyRemotePath(fs, '/home/root/lms2012/prjs/dir1', '/home/root/lms2012/prjs/dir1/sub/nested', { overwrite: true }),
		(error: unknown) => error instanceof RemoteFsPathError && error.code === 'INVALID_OPERATION'
	);
});

test('remoteFsOps delete path handles recursive and non-recursive directory deletion', async () => {
	const fs = new InMemoryRemoteFs();
	fs.addDirectory('/home');
	fs.addDirectory('/home/root');
	fs.addDirectory('/home/root/lms2012');
	fs.addDirectory('/home/root/lms2012/prjs');
	fs.addDirectory('/home/root/lms2012/prjs/d');
	fs.addFile('/home/root/lms2012/prjs/d/f.txt', new Uint8Array([1]));

	await assert.rejects(
		deleteRemotePath(fs, '/home/root/lms2012/prjs/d', { recursive: false }),
		(error: unknown) => error instanceof RemoteFsPathError && error.code === 'NOT_EMPTY'
	);

	await deleteRemotePath(fs, '/home/root/lms2012/prjs/d', { recursive: true });
	assert.equal(fs.hasDirectory('/home/root/lms2012/prjs/d'), false);
	assert.equal(fs.hasFile('/home/root/lms2012/prjs/d/f.txt'), false);
});

test('remoteFsOps getRemotePathKind resolves file directory and missing', async () => {
	const fs = new InMemoryRemoteFs();
	fs.addDirectory('/home');
	fs.addFile('/home/readme.txt', new Uint8Array([1]));

	assert.equal(await getRemotePathKind(fs, '/home'), 'directory');
	assert.equal(await getRemotePathKind(fs, '/home/readme.txt'), 'file');
	assert.equal(await getRemotePathKind(fs, '/home/missing.txt'), 'missing');
});

test('remoteFsOps getRemotePathKind resolves safe-root directory without parent listing', async () => {
	const fs: RemoteFsLike = {
		async listDirectory(remotePath: string): Promise<{ folders: string[]; files: Array<{ name: string }> }> {
			if (remotePath === '/home/root/lms2012/prjs' || remotePath === '/home/root/lms2012/prjs/') {
				return {
					folders: [],
					files: []
				};
			}
			if (remotePath === '/home/root/lms2012') {
				throw new Error('Path "/home/root/lms2012" is outside safe roots.');
			}
			throw new Error(`directory not found: ${remotePath}`);
		},
		async readFile(): Promise<Uint8Array> {
			throw new Error('not implemented');
		},
		async writeFile(): Promise<void> {
			throw new Error('not implemented');
		},
		async createDirectory(): Promise<void> {
			throw new Error('not implemented');
		},
		async deleteFile(): Promise<void> {
			throw new Error('not implemented');
		}
	};

	assert.equal(await getRemotePathKind(fs, '/home/root/lms2012/prjs/'), 'directory');
});
