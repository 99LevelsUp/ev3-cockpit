import { MockFileEntry } from './mockConfig';

/**
 * In-memory file tree for mock filesystem API testing.
 * Each mock brick gets its own MockFilesystem instance.
 */
export class MockFilesystem {
	private readonly files = new Map<string, string>();

	constructor(entries?: MockFileEntry[]) {
		if (entries) {
			for (const e of entries) {
				this.files.set(e.path, e.content);
			}
		}
	}

	list(directory: string): string[] {
		const prefix = directory.endsWith('/') ? directory : directory + '/';
		const result: string[] = [];
		for (const path of this.files.keys()) {
			if (path.startsWith(prefix)) {
				const relative = path.slice(prefix.length);
				// Only direct children (no nested slashes)
				if (!relative.includes('/')) {
					result.push(path);
				}
			}
		}
		return result.sort();
	}

	read(path: string): string | undefined {
		return this.files.get(path);
	}

	write(path: string, content: string): void {
		this.files.set(path, content);
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	delete(path: string): boolean {
		return this.files.delete(path);
	}
}
