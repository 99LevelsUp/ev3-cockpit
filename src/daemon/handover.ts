/**
 * One daemon handing its work to a newer one (KTD7).
 *
 * Versions compare directionally: only a newer client registers a replacement, so an older client
 * never stops a newer daemon. A registered replacement waits until the daemon is idle — no write
 * lease, nothing lent, no brick connected — and happens once; `ev3 daemon restart` asks for it now.
 *
 * The daemon handing over tells new clients to wait, ends what runs under a lease with
 * `outcome_unknown`, saves its holders, `full` and each Bluetooth brick's close time, releases its
 * devices, writes the handover marker, closes its listener and starts the successor. The successor
 * takes the state over, serves at once, reconnects the bricks that were held, and removes the
 * marker. A client that finds no listener while the marker is fresh waits for the successor.
 */

import * as fs from 'node:fs';
import { compareVersions } from '../client/versions';
import type { LaunchSpec } from '../contract/models';
import type { SettingValues } from '../core/settings/spec';
import type { HolderSnapshot } from './holders';
import type { DaemonPaths } from './paths';
import { readJson, writeJson } from './stateStore';

/** A handover state older than this is from a handover that never finished, and is ignored. */
export const HANDOVER_STATE_MS = 60_000;
/** How often an idle check runs while a replacement waits. */
export const IDLE_CHECK_MS = 1000;

/** What a daemon handing over leaves for its successor. */
export interface HandoverState {
	readonly at: number;
	readonly from: string;
	readonly holders: HolderSnapshot;
	/** Settings that live only as long as a daemon, such as `full`. */
	readonly unstored: SettingValues;
	/** When each Bluetooth brick's connection was closed, by MAC. */
	readonly btCloseTimes: Readonly<Record<string, number>>;
}

export function writeHandoverState(paths: DaemonPaths, state: HandoverState): void {
	writeJson(paths.handoverState, state);
}

/** The state a predecessor left, read once: the file is removed, and a stale one is ignored. */
export function takeHandoverState(paths: DaemonPaths, now = Date.now()): HandoverState | undefined {
	const state = readJson<HandoverState | undefined>(paths.handoverState, undefined);
	try { fs.rmSync(paths.handoverState, { force: true }); } catch { /* gone already */ }
	if (!state || typeof state.at !== 'number' || now - state.at > HANDOVER_STATE_MS) { return undefined; }
	return state;
}

export function writeHandoverMarker(paths: DaemonPaths, successorVersion: string, now = Date.now()): void {
	writeJson(paths.handoverMarker, { successorVersion, at: now });
}

export function removeHandoverMarker(paths: DaemonPaths): void {
	try { fs.rmSync(paths.handoverMarker, { force: true }); } catch { /* gone already */ }
}

/** How this very daemon was started, for a restart that is given no newer launch. */
export function ownLaunch(installRoot: string, version: string): LaunchSpec {
	return {
		runtime: process.execPath,
		entry: process.argv[1] ?? '',
		installRoot,
		version,
		...(process.versions.electron ? { electronRunAsNode: true } : {}),
	};
}

export interface ReplacementDeps {
	readonly version: string;
	/** True when nothing would be cut off by a replacement now. */
	readonly idle: () => boolean;
	/** Hands over to the launch. Called at most once. */
	readonly handOver: (launch: LaunchSpec, why: string) => void;
	readonly log: (message: string) => void;
}

export interface Replacement {
	/** A newer client asks to replace the daemon once it is idle. */
	register(launch: LaunchSpec): { readonly accepted: boolean; readonly reason?: string };
	/** `ev3 daemon restart`: now, with a newer launch if one is given, else this daemon's own. */
	restart(own: LaunchSpec, launch?: LaunchSpec): LaunchSpec;
	/** The replacement waiting for idle, if any. */
	readonly pending: LaunchSpec | undefined;
	dispose(): void;
}

export function createReplacement(deps: ReplacementDeps): Replacement {
	let pending: LaunchSpec | undefined;
	let done = false;
	let timer: NodeJS.Timeout | undefined;

	const fire = (launch: LaunchSpec, why: string): void => {
		if (done) { return; }
		done = true;
		if (timer) { clearInterval(timer); timer = undefined; }
		deps.handOver(launch, why);
	};
	const check = (): void => {
		if (pending && deps.idle()) { fire(pending, 'a newer client asked, and the daemon is idle'); }
	};

	return {
		get pending() { return pending; },
		register(launch) {
			if (compareVersions(launch.version, deps.version) <= 0) {
				return { accepted: false, reason: `Version ${launch.version} is not newer than this daemon's ${deps.version}.` };
			}
			if (done) { return { accepted: false, reason: 'The daemon is already being replaced.' }; }
			// The newest of several waiting replacements wins.
			if (!pending || compareVersions(launch.version, pending.version) > 0) { pending = launch; }
			deps.log(`Replacement by ${launch.version} registered; it happens once the daemon is idle`);
			if (!timer) {
				timer = setInterval(check, IDLE_CHECK_MS);
				timer.unref?.();
			}
			check();
			return { accepted: true };
		},
		restart(own, launch) {
			// Never a downgrade: a launch older than this daemon is ignored for its own.
			const target = launch && compareVersions(launch.version, deps.version) >= 0 ? launch : own;
			fire(target, 'restart');
			return target;
		},
		dispose() {
			if (timer) { clearInterval(timer); timer = undefined; }
		},
	};
}
