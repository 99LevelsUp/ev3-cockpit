import { spawnSync } from 'child_process';

/**
 * Why the tests that start a cockpit daemon are skipped in this process, or false. The daemon never
 * runs elevated (as administrator or root), by design; a CI runner may run every step elevated, as
 * GitHub's Windows runners do.
 */
export const daemonRefusesThisProcess: string | false = elevated()
	? 'this process runs elevated (administrator or root), and the cockpit daemon refuses to run so; run these tests as a standard user'
	: false;

function elevated(): boolean {
	if (process.platform === 'win32') {
		// `net session` needs an elevated token; it fails with access denied without one.
		return spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
	}
	return process.getuid?.() === 0 || process.geteuid?.() === 0;
}
