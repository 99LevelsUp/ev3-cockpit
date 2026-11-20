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
import { randomBytes } from 'node:crypto';
import { processAlive } from './systemTools';

export interface LockHolder {
	readonly pid: number;
	/** The holder's channel; absent for the user's own daemon. */
	readonly channel?: string;
	readonly at: number;
}

/** A takeover guard older than this was left by a daemon that died while taking a lock over. */
const TAKEOVER_GUARD_STALE_MS = 10_000;

/** Errors of a file system that has no hard links (some network and FAT-like volumes). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV']);

/** An unreadable lock younger than this may still be being written (see `placeLock`). */
const LOCK_BEING_WRITTEN_MS = 2000;

/**
 * Puts the lock in place, failing with EEXIST when one is there. Linked from the file written aside
 * where the file system allows it; elsewhere created exclusively and written, which leaves a moment
 * in which the lock is empty: a takeover leaves an unreadable lock alone while it is that new.
 */
function placeLock(temp: string, file: string, me: LockHolder): void {
	try {
		fs.linkSync(temp, file);
		return;
	} catch (error) {
		if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
	}
	const fd = fs.openSync(file, 'wx', 0o600);
	try { fs.writeSync(fd, JSON.stringify(me)); } finally { fs.closeSync(fd); }
}

export class HardwareLock {
	private held = false;

	constructor(private readonly file: string, private readonly channel: string | undefined) {}

	get isHeld(): boolean { return this.held; }

	/** Who holds the lock now, if a live process does. */
	holder(): LockHolder | undefined {
		try {
			const holder = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LockHolder;
			return typeof holder.pid === 'number' && processAlive(holder.pid) ? holder : undefined;
		} catch {
			return undefined;
		}
	}

	/** Takes the lock when nobody alive holds it. True when this process holds it now. */
	tryTake(): boolean {
		if (this.held) { return true; }
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const me: LockHolder = { pid: process.pid, ...(this.channel ? { channel: this.channel } : {}), at: Date.now() };
		// The lock appears with its holder already in it: written aside, then linked into place, which
		// fails when a lock is there. Nobody ever reads a lock that is still being written.
		const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(me), { mode: 0o600 });
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					placeLock(temp, this.file, me);
					this.held = true;
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
				}
				if (!this.takeOverStale()) { return false; }
			}
			return false;
		} finally {
			try { fs.rmSync(temp, { force: true }); } catch { /* removed with its folder */ }
		}
	}

	/**
	 * Removes a lock its holder left behind when it died. One daemon at a time decides that, under a
	 * guard file of its own, so none removes a lock another daemon has just taken. True when the lock
	 * is gone and taking it may be tried again.
	 */
	private takeOverStale(): boolean {
		const guard = `${this.file}.takeover`;
		let fd: number;
		try {
			fd = fs.openSync(guard, 'wx', 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
			// A guard older than a takeover can take was left by a daemon that died holding it.
			try {
				if (Date.now() - fs.statSync(guard).mtimeMs > TAKEOVER_GUARD_STALE_MS) { fs.rmSync(guard, { force: true }); }
			} catch { /* gone already */ }
			return false;
		}
		try {
			let holder: Partial<LockHolder> | undefined;
			try {
				holder = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LockHolder>;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return true; }
				// One that does not parse is damaged, unless it is new: on a file system without hard links
				// a lock is created first and written after.
				if (Date.now() - fs.statSync(this.file).mtimeMs < LOCK_BEING_WRITTEN_MS) { return false; }
			}
			if (holder && typeof holder.pid === 'number' && processAlive(holder.pid)) { return false; }
			fs.rmSync(this.file, { force: true });
			return true;
		} finally {
			fs.closeSync(fd);
			try { fs.rmSync(guard, { force: true }); } catch { /* gone already */ }
		}
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
