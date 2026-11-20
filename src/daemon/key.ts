/**
 * The user's key: 32 random bytes in a file only the user can read. The daemon and every client
 * read it to prove themselves to each other in the handshake.
 *
 * The file's permissions are checked every time it is read: a key others can read proves nothing.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentUserName, runWindowsTool } from './systemTools';

export const KEY_BYTES = 32;

/** What the key needs from the operating system; replaceable in tests. */
export interface KeyHost {
	readonly platform: NodeJS.Platform;
	readonly uid?: number;
	/** Restricts a Windows file to the current user. */
	restrictToUser(file: string): void;
	/** The accounts other than the current user, SYSTEM and Administrators that can read a Windows file. */
	othersWithAccess(file: string): string[];
}

/** Accounts that may read any user's files on Windows anyway. */
const WINDOWS_TRUSTED = [/NT AUTHORITY\\SYSTEM/i, /BUILTIN\\Administrators/i];

export function systemKeyHost(): KeyHost {
	return {
		platform: process.platform,
		...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
		restrictToUser(file) {
			runWindowsTool('icacls', [file, '/inheritance:r', '/grant:r', `${currentUserName()}:F`]);
		},
		othersWithAccess(file) {
			const me = currentUserName().toLowerCase();
			const listing = runWindowsTool('icacls', [file]);
			const others: string[] = [];
			for (const raw of listing.split(/\r?\n/)) {
				const line = raw.replace(file, '').trim();
				const account = /^(.+?):\(/.exec(line)?.[1]?.trim();
				if (!account) { continue; }
				if (account.toLowerCase() === me) { continue; }
				if (WINDOWS_TRUSTED.some((pattern) => pattern.test(account))) { continue; }
				others.push(account);
			}
			return others;
		},
	};
}

/** Refuses a key file anyone but its user can read. */
function checkPrivate(file: string, host: KeyHost): void {
	if (host.platform === 'win32') {
		const others = host.othersWithAccess(file);
		if (others.length > 0) {
			throw new Error(`The cockpit key ${file} can be read by ${others.join(', ')}; it must be readable by you alone. Delete it and the cockpit makes a new one.`);
		}
		return;
	}
	const stat = fs.statSync(file);
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(`The cockpit key ${file} can be read by others (mode ${(stat.mode & 0o777).toString(8)}); it must be readable by you alone. Delete it and the cockpit makes a new one.`);
	}
	if (host.uid !== undefined && stat.uid !== host.uid) {
		throw new Error(`The cockpit key ${file} belongs to another user.`);
	}
}

/** Reads the key, creating it on first use. */
export function ensureKey(file: string, host: KeyHost = systemKeyHost()): Buffer {
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const key = randomBytes(KEY_BYTES);
		try {
			fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
			if (host.platform === 'win32') { host.restrictToUser(file); }
		} catch (error) {
			// Another process made it first: use theirs.
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
		}
	}
	return readKey(file, host);
}

/** Reads an existing key; refuses one others can read or one of the wrong size. */
export function readKey(file: string, host: KeyHost = systemKeyHost()): Buffer {
	checkPrivate(file, host);
	const key = fs.readFileSync(file);
	if (key.length !== KEY_BYTES) { throw new Error(`The cockpit key ${file} is damaged; delete it and the cockpit makes a new one.`); }
	return key;
}
