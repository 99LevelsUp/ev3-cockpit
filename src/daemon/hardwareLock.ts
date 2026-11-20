/**
 * The per-user hardware lock (KTD17). Every daemon that uses real transports takes it before it
 * starts them; the holder owns the hardware. A daemon without it opens only what is lent to it, or
 * nothing until the holder ends.
 *
 * The lock is a set of claims, one file per daemon next to the lock path (`hardware.lock.<pid>`). A
 * daemon writes its own claim, then looks at all of them: it holds the hardware when no other claim
 * belongs to a live process, and otherwise withdraws its claim. Of two daemons claiming at once the
 * second to look always sees the first, so two never both hold it; both may withdraw, and the one
 * waiting tries again on its timer. Nobody takes another daemon's file over, so there is no
 * takeover to race: a claim is removed by its owner, or by anyone once its process is gone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { processAlive } from './systemTools';

export interface LockHolder {
	readonly pid: number;
	/** The holder's channel; absent for the user's own daemon. */
	readonly channel?: string;
	readonly at: number;
}

interface Claim {
	readonly file: string;
	readonly pid: number;
}

export class HardwareLock {
	private held = false;
	private readonly mine: string;

	constructor(private readonly file: string, private readonly channel: string | undefined) {
		this.mine = `${file}.${process.pid}`;
	}

	get isHeld(): boolean { return this.held; }

	/**
	 * Every claim there is; the pid is in the file name, so a claim still being written counts. A folder
	 * that cannot be listed throws: claims nobody can see must not read as no claims.
	 */
	private claims(): Claim[] {
		const dir = path.dirname(this.file);
		const prefix = `${path.basename(this.file)}.`;
		return fs.readdirSync(dir)
			.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
			.map((name) => ({ file: path.join(dir, name), pid: Number(name.slice(prefix.length)) }));
	}

	/** Who holds the lock now, if a live process does. */
	holder(): LockHolder | undefined {
		let claims: Claim[];
		try { claims = this.claims(); } catch { return undefined; }
		for (const claim of claims) {
			if (claim.pid !== process.pid && !processAlive(claim.pid)) { continue; }
			if (claim.pid === process.pid && !this.held) { continue; }
			try {
				return { ...(JSON.parse(fs.readFileSync(claim.file, 'utf8')) as LockHolder), pid: claim.pid };
			} catch {
				return { pid: claim.pid, at: 0 };
			}
		}
		return undefined;
	}

	/** Takes the lock when nobody alive holds or claims it. True when this process holds it now. */
	tryTake(): boolean {
		if (this.held) { return true; }
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const me: LockHolder = { pid: process.pid, ...(this.channel ? { channel: this.channel } : {}), at: Date.now() };
		fs.writeFileSync(this.mine, JSON.stringify(me), { mode: 0o600 });
		let claims: Claim[];
		try {
			claims = this.claims();
		} catch (error) {
			this.withdraw();
			throw error;
		}
		let contested = false;
		for (const claim of claims) {
			if (claim.pid === process.pid) { continue; }
			if (processAlive(claim.pid)) {
				contested = true;
			} else {
				// Left by a daemon that died; only it could have written this file.
				try { fs.rmSync(claim.file, { force: true }); } catch { /* removed by another daemon */ }
			}
		}
		if (contested) {
			this.withdraw();
			return false;
		}
		this.held = true;
		return true;
	}

	release(): void {
		if (!this.held) { return; }
		this.held = false;
		this.withdraw();
	}

	private withdraw(): void {
		try { fs.rmSync(this.mine, { force: true }); } catch { /* gone already */ }
	}
}
