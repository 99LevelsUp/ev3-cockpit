/**
 * The cockpit's access mode (step-5 plan, U4, KD2; IMPLEMENTATION_PLAN 4.9.2).
 *
 * Owner decision 11.11.2026: in safe mode, the default, a consumer writes, deletes and runs only
 * in the user areas — the brick's projects folder and the SD card — and reads everywhere; the
 * shell needs full mode. The cockpit enforces it in its API, so no consumer (ev3-explorer's
 * `ev3://` included) can route around it.
 */

import { AccessDeniedError } from '../errors/CockpitError';

export type AccessMode = 'safe' | 'full';
export type AccessOperation = 'read' | 'write' | 'delete' | 'run' | 'shell';

/** Where safe mode lets a consumer change things. */
export const USER_AREAS: readonly string[] = ['/home/root/lms2012/prjs', '/media/card'];

/** The VM's working folder: the brick resolves a relative path from here (`../prjs/…`). */
const VM_FOLDER = '/home/root/lms2012/sys';

/** A brick path made absolute, `.` and `..` resolved, without a trailing slash. */
export function normaliseBrickPath(path: string): string {
	const full = path.startsWith('/') ? path : `${VM_FOLDER}/${path}`;
	const parts: string[] = [];
	for (const part of full.split('/')) {
		if (part === '..') { parts.pop(); } else if (part !== '' && part !== '.') { parts.push(part); }
	}
	return `/${parts.join('/')}`;
}

/** Whether `mode` allows `operation` on `path` (no path for the shell). */
export function isAllowed(mode: AccessMode, operation: AccessOperation, path?: string): boolean {
	if (mode === 'full') { return true; }
	if (operation === 'read') { return true; }
	if (operation === 'shell' || path === undefined) { return false; }
	const target = normaliseBrickPath(path);
	return USER_AREAS.some((area) => target.startsWith(`${area}/`));
}

/** Throw a typed error when `mode` does not allow it. */
export function assertAllowed(mode: AccessMode, operation: AccessOperation, path?: string): void {
	if (isAllowed(mode, operation, path)) { return; }
	const what = operation === 'shell' ? 'running a shell command' : `${operation} of ${path ?? '(no path)'}`;
	throw new AccessDeniedError(
		`The cockpit is in safe mode, which does not allow ${what}: safe mode changes only `
		+ `${USER_AREAS.join(' and ')}, and the shell needs full mode (setting ev3-cockpit.accessMode).`);
}
