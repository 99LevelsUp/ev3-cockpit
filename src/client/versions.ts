/**
 * Which side is newer, and what to tell the user about it.
 *
 * A client built in this repository (the VS Code extension, the `ev3` command, the cockpit's MCP
 * server) compares package versions: the newest wins, so a newer client asks the daemon to step
 * aside once it is idle. An add-on carries no daemon and compares only the contract version.
 */

import type { ClientKind } from '../contract/models';

/** Compares dotted versions numerically: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) { return d; }
	}
	return 0;
}

export function isRepoClient(kind: ClientKind): boolean {
	return kind === 'vscode' || kind === 'cli' || kind === 'mcp';
}

export interface VersionNotice {
	readonly current: string;
	readonly newer: string;
	readonly newerIs: 'client' | 'daemon';
	readonly text: string;
}

/** What a repository client should say, or nothing when the versions match. */
export function versionNotice(clientVersion: string, daemonVersion: string): VersionNotice | undefined {
	const d = compareVersions(clientVersion, daemonVersion);
	if (d === 0) { return undefined; }
	if (d > 0) {
		return {
			current: daemonVersion, newer: clientVersion, newerIs: 'client',
			text: `A new version of the EVƎ Cockpit daemon is available (${clientVersion}; ${daemonVersion} runs now). It takes over once no brick is in use, or now with "ev3 daemon restart".`,
		};
	}
	return {
		current: clientVersion, newer: daemonVersion, newerIs: 'daemon',
		text: `A newer EVƎ Cockpit (${daemonVersion}) runs than this client (${clientVersion}); update this client.`,
	};
}

/** What an add-on should say when the daemon's contract cannot serve it. */
export function contractNotice(needed: number, offered: number): string | undefined {
	return offered < needed
		? `This add-on needs the cockpit contract ${needed}, and the running cockpit offers ${offered}: update EVƎ Cockpit.`
		: undefined;
}
