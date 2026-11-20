/**
 * The operating system's own tools, by absolute path.
 *
 * On Windows a program started by its bare name is looked for in the current directory first, so
 * a file named `icacls.exe` in a project folder would run instead of the system's. Every tool the
 * cockpit starts is therefore named by its full path under the Windows system folder.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/** The absolute path of a Windows system tool such as `icacls` or `whoami`. */
export function windowsSystemTool(name: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = env.SystemRoot || env.windir || 'C:\\Windows';
	return path.win32.join(root, 'System32', `${name}.exe`);
}

/** Runs a Windows system tool and returns what it printed; throws when it fails. */
export function runWindowsTool(name: string, args: readonly string[]): string {
	const run = spawnSync(windowsSystemTool(name), args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
	if (run.error) { throw run.error; }
	if (run.status !== 0) { throw new Error(`${name} failed: ${(run.stderr || run.stdout || '').trim()}`); }
	return run.stdout;
}

let cachedSid: string | undefined;

/** The current user's SID, read once from `whoami`. */
export function currentUserSid(): string {
	if (cachedSid) { return cachedSid; }
	const out = runWindowsTool('whoami', ['/user', '/fo', 'csv', '/nh']).trim();
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(out)?.[1];
	if (!sid) { throw new Error(`Could not read the user SID from whoami: ${out}`); }
	cachedSid = sid;
	return sid;
}

/** The current user as `DOMAIN\name`, for granting it access to a file. */
export function currentUserName(): string {
	return runWindowsTool('whoami', []).trim();
}

/** True when this process runs elevated (high integrity) on Windows. */
export function isElevated(): boolean {
	const groups = runWindowsTool('whoami', ['/groups', '/fo', 'csv', '/nh']);
	// The mandatory label of an elevated token is S-1-16-12288 (high) or higher.
	return /S-1-16-(12288|16384|20480|28672)/.test(groups);
}
