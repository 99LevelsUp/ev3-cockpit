/**
 * The per-user hardware lock (KTD17). Every daemon that uses real transports takes it before it
 * starts them; the holder owns the hardware. A daemon without it opens only what is lent to it, or
 * nothing until the holder ends.
 *
 * The lock is a file created exclusively, with the holder's pid in it. A holder that died leaves the
 * file behind; the next daemon finds its pid gone and takes the lock over.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LockHolder {
	readonly pid: number;
	/** The holder's channel; absent for the user's own daemon. */
	readonly channel?: string;
	readonly at: number;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process is there, it just is not ours to signal.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export class HardwareLock {
	private held = false;

	constructor(private readonly file: string, private readonly channel: string | undefined) {}

	get isHeld(): boolean { return this.held; }

	/** Who holds the lock now, if a live process does. */
	holder(): LockHolder | undefined {
		try {
			const holder = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LockHolder;
			return typeof holder.pid === 'number' && alive(holder.pid) ? holder : undefined;
		} catch {
			return undefined;
		}
	}

	/** Takes the lock when nobody alive holds it. True when this process holds it now. */
	tryTake(): boolean {
		if (this.held) { return true; }
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = fs.openSync(this.file, 'wx', 0o600);
				const me: LockHolder = { pid: process.pid, ...(this.channel ? { channel: this.channel } : {}), at: Date.now() };
				fs.writeSync(fd, JSON.stringify(me));
				fs.closeSync(fd);
				this.held = true;
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
				if (this.holder()) { return false; }
				// Left by a daemon that died: take it over.
				try { fs.rmSync(this.file, { force: true }); } catch { /* another daemon got there first */ }
			}
		}
		return false;
	}

	release(): void {
		if (!this.held) { return; }
		this.held = false;
		try {
			const holder = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LockHolder;
			if (holder.pid === process.pid) { fs.rmSync(this.file, { force: true }); }
		} catch { /* gone already */ }
	}
}
