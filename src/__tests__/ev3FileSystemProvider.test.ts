import assert from 'node:assert/strict';
import Module from 'node:module';
import * as path from 'node:path';
import test from 'node:test';

type UriLike = {
	authority: string;
	path: string;
	toString: () => string;
};

class InMemoryRemoteFs {
	private readonly directories = new Set<string>(['/']);
	private readonly files = new Map<string, Uint8Array>();

	public addDirectory(dirPath: string): void {
		this.directories.add(this.norm(dirPath));
	}

	public addFile(filePath: string, data: Uint8Array): void {
		const full = this.norm(filePath);
		this.directories.add(path.posix.dirname(full));
		this.files.set(full, data.slice());
	}

	public async listDirectory(remotePath: string): Promise<{ folders: string[]; files: Array<{ name: string; size: number }> }> {
		const root = this.norm(remotePath);
		if (!this.directories.has(root)) {
			throw new Error(`Path not found: ${root}`);
		}

		const folders = new Set<string>();
		const files: Array<{ name: string; size: number }> = [];
		for (const dir of this.directories) {
			if (dir === root || !dir.startsWith(`${root === '/' ? '' : root}/`)) {
				continue;
			}
			const relative = dir.slice((root === '/' ? '' : root).length + 1);
			if (!relative.includes('/')) {
				folders.add(relative);
			}
		}
		for (const [filePath, data] of this.files.entries()) {
			if (!filePath.startsWith(`${root === '/' ? '' : root}/`)) {
				continue;
			}
			const relative = filePath.slice((root === '/' ? '' : root).length + 1);
			if (!relative.includes('/')) {
				files.push({ name: relative, size: data.length });
			}
		}

		return {
			folders: Array.from(folders),
			files
		};
	}

	public async readFile(remotePath: string): Promise<Uint8Array> {
		const data = this.files.get(this.norm(remotePath));
		if (!data) {
			throw new Error(`Path not found: ${remotePath}`);
		}
		return data.slice();
	}

	public async writeFile(remotePath: string, data: Uint8Array): Promise<void> {
		const full = this.norm(remotePath);
		const parent = path.posix.dirname(full);
		if (!this.directories.has(parent)) {
			throw new Error(`Path not found: ${parent}`);
		}
		this.files.set(full, data.slice());
	}

	public async createDirectory(remotePath: string): Promise<void> {
		const full = this.norm(remotePath);
		const parent = path.posix.dirname(full);
		if (!this.directories.has(parent)) {
			throw new Error(`Path not found: ${parent}`);
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
		throw new Error(`Path not found: ${remotePath}`);
	}

	public hasFile(remotePath: string): boolean {
		return this.files.has(this.norm(remotePath));
	}

	private norm(input: string): string {
		const unified = input.replace(/\\/g, '/');
		return unified.startsWith('/') ? path.posix.normalize(unified) : path.posix.normalize(`/${unified}`);
	}
}

function makeUri(remotePath: string): UriLike {
	return {
		authority: 'active',
		path: remotePath,
		toString: () => `ev3://active${remotePath}`
	};
}

function createVscodeMock() {
	class Disposable {
		public constructor(private readonly disposer: () => void) {}
		public dispose(): void {
			this.disposer();
		}
	}

	class EventEmitter<T> {
		public readonly event = (_listener: (e: T) => unknown) => new Disposable(() => undefined);
		public fire(_event: T): void {}
	}

	class FileSystemError extends Error {
		public readonly code: string;
		public constructor(code: string, message: string) {
			super(message);
			this.name = 'FileSystemError';
			this.code = code;
		}

		public static FileNotFound(uri: { toString: () => string }): FileSystemError {
			return new FileSystemError('FileNotFound', `File not found: ${uri.toString()}`);
		}

		public static FileExists(uri: { toString: () => string }): FileSystemError {
			return new FileSystemError('FileExists', `File exists: ${uri.toString()}`);
		}

		public static NoPermissions(message: string): FileSystemError {
			return new FileSystemError('NoPermissions', message);
		}

		public static Unavailable(message: string): FileSystemError {
			return new FileSystemError('Unavailable', message);
		}
	}

	return {
		Disposable,
		EventEmitter,
		FileSystemError,
		FileType: {
			File: 0,
			Directory: 1
		},
		FileChangeType: {
			Created: 1,
			Changed: 2,
			Deleted: 3
		}
	};
}

async function withMockedProvider<T>(run: (providerModule: { Ev3FileSystemProvider: new (resolver: (brickId: string) => Promise<unknown>) => unknown }) => Promise<T>): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;
	const vscodeMock = createVscodeMock();

	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const providerModule = require('../fs/ev3FileSystemProvider') as {
			Ev3FileSystemProvider: new (resolver: (brickId: string) => Promise<unknown>) => unknown;
		};
		return await run(providerModule);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('Ev3FileSystemProvider supports copy and rename over remote FS service', async () => {
	await withMockedProvider(async ({ Ev3FileSystemProvider }) => {
		const fs = new InMemoryRemoteFs();
		fs.addDirectory('/home');
		fs.addDirectory('/home/root');
		fs.addDirectory('/home/root/lms2012');
		fs.addDirectory('/home/root/lms2012/prjs');
		fs.addFile('/home/root/lms2012/prjs/src.bin', new Uint8Array([1, 2, 3]));

		const provider = new Ev3FileSystemProvider(async () => fs) as unknown as {
			copy: (source: UriLike, destination: UriLike, options: { overwrite: boolean }) => Promise<void>;
			rename: (oldUri: UriLike, newUri: UriLike, options: { overwrite: boolean }) => Promise<void>;
		};

		await provider.copy(
			makeUri('/home/root/lms2012/prjs/src.bin'),
			makeUri('/home/root/lms2012/prjs/copy.bin'),
			{ overwrite: false }
		);
		assert.equal(fs.hasFile('/home/root/lms2012/prjs/src.bin'), true);
		assert.equal(fs.hasFile('/home/root/lms2012/prjs/copy.bin'), true);

		await provider.rename(
			makeUri('/home/root/lms2012/prjs/copy.bin'),
			makeUri('/home/root/lms2012/prjs/renamed.bin'),
			{ overwrite: false }
		);
		assert.equal(fs.hasFile('/home/root/lms2012/prjs/copy.bin'), false);
		assert.equal(fs.hasFile('/home/root/lms2012/prjs/renamed.bin'), true);
	});
});

test('Ev3FileSystemProvider maps offline write to NoPermissions and offline read to Unavailable', async () => {
	await withMockedProvider(async ({ Ev3FileSystemProvider }) => {
		const provider = new Ev3FileSystemProvider(async () => {
			throw new Error('No active EV3 connection for filesystem access. Run "EV3 Cockpit: Connect to EV3 Brick".');
		}) as unknown as {
			writeFile: (
				uri: UriLike,
				content: Uint8Array,
				options: { create: boolean; overwrite: boolean }
			) => Promise<void>;
			readFile: (uri: UriLike) => Promise<Uint8Array>;
		};

		await assert.rejects(
			provider.writeFile(makeUri('/home/root/lms2012/prjs/offline.txt'), new Uint8Array([1]), {
				create: true,
				overwrite: true
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal((error as Error & { code?: string }).code, 'NoPermissions');
				assert.match(error.message, /read-only/i);
				return true;
			}
		);

		await assert.rejects(
			provider.readFile(makeUri('/home/root/lms2012/prjs/offline.txt')),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal((error as Error & { code?: string }).code, 'Unavailable');
				return true;
			}
		);
	});
});
