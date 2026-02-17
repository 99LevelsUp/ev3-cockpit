import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const LOCK_PATH = path.join(os.tmpdir(), 'ev3-cockpit-vscode-launch.lock');
const LOCK_STALE_AFTER_MS = 5 * 60_000;
const LOCK_RETRY_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquireLock(): Promise<fs.FileHandle | null> {
	try {
		return await fs.open(LOCK_PATH, 'wx');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return null;
		}
		throw error;
	}
}

async function removeStaleLockIfNeeded(): Promise<void> {
	try {
		const stat = await fs.stat(LOCK_PATH);
		if (Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS) {
			await fs.rm(LOCK_PATH, { force: true });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
}

export async function acquireVsCodeLaunchLock(timeoutMs = 180_000): Promise<() => Promise<void>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const handle = await tryAcquireLock();
		if (handle) {
			await handle.writeFile(`${process.pid}:${Date.now()}\n`, 'utf8');
			let released = false;
			return async () => {
				if (released) {
					return;
				}
				released = true;
				try {
					await handle.close();
				} finally {
					try {
						await fs.rm(LOCK_PATH, { force: true });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
							throw error;
						}
					}
				}
			};
		}
		await removeStaleLockIfNeeded();
		await delay(LOCK_RETRY_DELAY_MS + Math.floor(Math.random() * 100));
	}
	throw new Error(`Timed out waiting for VS Code launch lock after ${timeoutMs}ms.`);
}
