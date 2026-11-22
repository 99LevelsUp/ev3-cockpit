/**
 * Starting the native daemon from a client. A client never starts the binary it carries: it copies
 * it into the user's state root, checks the copy's SHA-256, and starts exactly that copy.
 *
 * - The copy goes to `bin/<sha256>/` under the state root, through a unique temporary file renamed
 *   into place. Each such directory holds only the binary. `bin/` and `bin/<sha256>/` must be the
 *   user's alone: on Linux and macOS a plain directory of the user's that nobody else can open, on
 *   Windows a directory whose access list lets in nobody but the user, SYSTEM and the
 *   Administrators. The client gives the directories it creates an owner-only access list.
 * - The copy is hashed, not the source. A copy that verifies is reused; one that does not is
 *   replaced. A binary whose copy does not match the SHA-256 its package recorded is refused.
 * - The installed file is never started, so it is never locked: `npm i -g` and a rebuild work
 *   while a daemon runs. The copy starts with the state root as its working directory.
 * - Clients remove the copies other than their own and the running daemon's, skipping locked ones
 *   and ones used in the last minutes, which another client may be about to start.
 * - Where the binary comes from: a packaged client reads the manifest its package carries beside
 *   the binary; a development client reads the one a build step writes after each `cargo build`
 *   (`npm run daemon:build`). Nothing in the environment changes either location.
 * - On Windows a start that fails (a spawn error, or an exit with a code the daemon never uses) is
 *   read as Smart App Control when the code-integrity policy reports it on or in evaluation. Node
 *   reports such a block only as `spawn UNKNOWN`. A daemon that exited with one of its own codes
 *   ran, so it was not blocked.
 */

import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WireErrorCode } from '../contract/errors';
import type { LaunchSpec } from '../contract/generated';
import { ContractError } from './connection';
import type { NativeChannelFiles } from './locate';

/** The file beside the binary that records its SHA-256, version and build kind. */
export const DAEMON_MANIFEST = 'ev3-cockpitd.manifest.json';

/** The daemon executable's file name. */
export function daemonBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? 'ev3-cockpitd.exe' : 'ev3-cockpitd';
}

/**
 * Why a client could not start or use the daemon. Every client tells them apart the same way and
 * shows them its own way.
 *
 * - `missing_binary`: no daemon to start (nothing carried, the file gone, no install record).
 * - `sha_mismatch`: the binary does not match the SHA-256 its package or build step recorded.
 * - `not_private`: the directory of the verified copies is not the user's alone.
 * - `smart_app_control`: Windows Smart App Control blocked the unsigned binary.
 * - `name_held`: the daemon refused to run (exit code 3), for example because someone else holds
 *   its pipe or socket name; the message carries the end of its log.
 * - `lock_held`: another daemon held the channel's lock (exit code 2) and none became reachable.
 * - `contract_mismatch`: the running daemon speaks another contract and could not be replaced.
 * - `failed`: anything else, with the exit code and the end of the log.
 */
export type StartFailure =
	| 'missing_binary' | 'sha_mismatch' | 'not_private' | 'smart_app_control' | 'name_held' | 'lock_held'
	| 'contract_mismatch' | 'failed';

/** A start failure. Its contract code is `daemon_unavailable`, so code-based handling keeps working. */
export class DaemonStartError extends ContractError {
	readonly failure: StartFailure;

	constructor(failure: StartFailure, message: string) {
		super(WireErrorCode.DaemonUnavailable, message);
		this.name = 'DaemonStartError';
		this.failure = failure;
	}
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A launch record as JSON reads it, or undefined when it is not one. */
export function readLaunchSpec(value: unknown): LaunchSpec | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) { return undefined; }
	const { binary, sha256, version, buildKind } = value as Record<string, unknown>;
	if (typeof binary !== 'string' || !path.isAbsolute(binary)) { return undefined; }
	if (typeof sha256 !== 'string' || !SHA256.test(sha256)) { return undefined; }
	if (typeof version !== 'string' || version.length === 0) { return undefined; }
	if (buildKind !== 'release' && buildKind !== 'development') { return undefined; }
	return { binary, sha256, version, buildKind };
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

/** The manifest in `dir` as a launch, the binary beside it; `hint` says how to get a good one. */
function manifestLaunch(dir: string, hint: string): LaunchSpec {
	const file = path.join(dir, DAEMON_MANIFEST);
	let manifest: unknown;
	try {
		manifest = readJson(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new DaemonStartError('missing_binary', code === 'ENOENT'
			? `The cockpit daemon's manifest ${file} is missing. ${hint}`
			: `The cockpit daemon's manifest ${file} cannot be read (${code ?? String(error)}). ${hint}`);
	}
	const name = (manifest as { binary?: unknown } | null)?.binary;
	// The binary is named by its file name alone: a manifest never points out of its directory.
	const launch = typeof name === 'string' && name.length > 0 && path.basename(name) === name && name !== '.' && name !== '..'
		? readLaunchSpec({ ...(manifest as object), binary: path.join(dir, name) })
		: undefined;
	if (!launch) { throw new DaemonStartError('missing_binary', `The cockpit daemon's manifest ${file} is not valid. ${hint}`); }
	if (!fs.existsSync(launch.binary)) {
		throw new DaemonStartError('missing_binary', `The cockpit daemon ${launch.binary} is missing. ${hint}`);
	}
	return launch;
}

/**
 * The daemon a packaged client carries: the binary in `dir` (the package's own directory, which the
 * caller derives from where its code lies) and the manifest the package carries beside it.
 */
export function packagedDaemon(dir: string): LaunchSpec {
	return manifestLaunch(dir, 'Reinstall EVƎ Cockpit.');
}

/** The Cargo profiles a development build may come from. */
export type CargoProfile = 'debug' | 'release';

/**
 * The daemon a development client runs: `daemon/target/<profile>/` of the repository, with the
 * manifest `npm run daemon:build` writes after each build. Without a profile, the build whose
 * manifest was written last.
 */
export function developmentDaemon(repoRoot: string, profile?: CargoProfile): LaunchSpec {
	const hint = 'Build it with npm run daemon:build.';
	const profiles: readonly CargoProfile[] = profile ? [profile] : ['debug', 'release'];
	const dirs = profiles.map((p) => path.join(repoRoot, 'daemon', 'target', p));
	const written = (dir: string): number => {
		try { return fs.statSync(path.join(dir, DAEMON_MANIFEST)).mtimeMs; } catch { return -1; }
	};
	const newest = dirs.reduce((best, dir) => (written(dir) > written(best) ? dir : best), dirs[0]);
	if (written(newest) < 0) {
		throw new DaemonStartError('missing_binary', `No development build of the cockpit daemon in ${path.join(repoRoot, 'daemon', 'target')}. ${hint}`);
	}
	return manifestLaunch(newest, hint);
}

/** What a directory looks like to the checks; the parts of `fs.Stats` they read. */
export interface DirStat {
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	readonly uid: number;
	readonly mode: number;
}

/** How a started daemon ended before it answered, if it did. */
export type SpawnOutcome =
	| { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null }
	| { readonly kind: 'error'; readonly error: NodeJS.ErrnoException };

export interface SpawnedDaemon {
	readonly pid: number | undefined;
	/** How the process ended, or undefined while it runs. */
	outcome(): SpawnOutcome | undefined;
}

/** What starting the daemon needs from the operating system; replaceable in tests. */
export interface LaunchHost {
	readonly platform: NodeJS.Platform;
	/** The user's id on Linux and macOS. */
	readonly uid?: number;
	lstat(target: string): DirStat;
	/** Windows: gives a directory a protected access list with the user alone. */
	restrictToUser(dir: string): void;
	/** Windows: who besides the user, SYSTEM and the Administrators the directory's access list lets in. */
	othersWithAccess(dir: string): string[];
	/** Starts the daemon detached, so it outlives this client. */
	spawn(file: string, args: readonly string[], cwd: string): SpawnedDaemon;
	/** Windows: `VerifiedAndReputablePolicyState` (0 off, 1 on, 2 evaluation), or undefined when unreadable. */
	smartAppControlPolicy(): number | undefined;
}

/** A Windows system tool by its full path, never found through the current directory. */
function systemTool(name: string): string {
	return path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', `${name}.exe`);
}

function runTool(name: string, args: readonly string[]): string {
	const run = spawnSync(systemTool(name), args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
	if (run.error) { throw run.error; }
	if (run.status !== 0) { throw new Error(`${name} failed: ${(run.stderr || run.stdout || '').trim()}`); }
	return run.stdout;
}

let userSid: string | undefined;

/** The current user's SID, read once from `whoami`. */
function currentUserSid(): string {
	if (userSid) { return userSid; }
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(runTool('whoami', ['/user', '/fo', 'csv', '/nh']).trim())?.[1];
	if (!sid) { throw new Error('The current user\'s SID could not be read from whoami.'); }
	userSid = sid;
	return sid;
}

/** SDDL names of the accounts that may reach any user's files anyway. */
const TRUSTED_SDDL = new Set(['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544']);

/** The SIDs other than `me`, SYSTEM and the Administrators that the allow entries of a DACL in SDDL name. */
export function othersInSddl(sddl: string, me: string): string[] {
	const dacl = /D:[A-Z]*((?:\([^)]*\))*)/.exec(sddl)?.[1] ?? '';
	const others: string[] = [];
	for (const [, ace] of dacl.matchAll(/\(([^)]*)\)/g)) {
		const fields = ace.split(';');
		const type = fields[0];
		const sid = fields[5] ?? '';
		if (type !== 'A' && type !== 'OA') { continue; }
		if (sid === me || TRUSTED_SDDL.has(sid)) { continue; }
		others.push(sid);
	}
	return others;
}

class ProcessDaemon implements SpawnedDaemon {
	private ended: SpawnOutcome | undefined;
	constructor(private readonly child: ChildProcess) {
		child.once('exit', (code, signal) => { this.ended ??= { kind: 'exit', code, signal }; });
		child.once('error', (error) => { this.ended ??= { kind: 'error', error }; });
		child.unref();
	}
	get pid(): number | undefined { return this.child.pid; }
	outcome(): SpawnOutcome | undefined { return this.ended; }
}

export function systemLaunchHost(): LaunchHost {
	return {
		platform: process.platform,
		...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
		lstat: (target) => fs.lstatSync(target),
		restrictToUser(dir) {
			runTool('icacls', [dir, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, '/q']);
		},
		othersWithAccess(dir) {
			// icacls prints account names in the system's language; its saved form is SDDL, with SIDs.
			const saved = path.join(os.tmpdir(), `ev3-cockpit-acl-${randomBytes(6).toString('hex')}.txt`);
			try {
				runTool('icacls', [dir, '/save', saved, '/q']);
				return othersInSddl(fs.readFileSync(saved, 'utf16le'), currentUserSid());
			} finally {
				fs.rmSync(saved, { force: true });
			}
		},
		spawn: (file, args, cwd) => new ProcessDaemon(spawn(file, [...args], {
			cwd, detached: true, stdio: 'ignore', windowsHide: true,
		})),
		smartAppControlPolicy() {
			try {
				const out = runTool('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState']);
				const value = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)?.[1];
				return value === undefined ? undefined : Number.parseInt(value, 16);
			} catch {
				return undefined;
			}
		},
	};
}

function notPrivate(dir: string, why: string): DaemonStartError {
	return new DaemonStartError('not_private',
		`The folder of the cockpit daemon's verified copies ${dir} ${why}; the daemon was not started from it.`);
}

/** Refuses a copy directory anyone but the user could put a file in. */
export function checkPrivateDir(dir: string, host: LaunchHost): void {
	let stat: DirStat;
	try {
		stat = host.lstat(dir);
	} catch (error) {
		throw notPrivate(dir, `cannot be checked (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) { throw notPrivate(dir, 'is not a plain folder'); }
	if (host.platform === 'win32') {
		let others: string[];
		try {
			others = host.othersWithAccess(dir);
		} catch (error) {
			throw notPrivate(dir, `cannot be checked (${error instanceof Error ? error.message : String(error)})`);
		}
		if (others.length > 0) { throw notPrivate(dir, `can be reached by others (${others.join(', ')})`); }
		return;
	}
	if (host.uid !== undefined && stat.uid !== host.uid) { throw notPrivate(dir, 'belongs to another user'); }
	if ((stat.mode & 0o077) !== 0) { throw notPrivate(dir, `can be opened by other users (mode ${(stat.mode & 0o777).toString(8)})`); }
}

/**
 * Makes `dir` as a private directory unless it exists, then checks it. A new directory is made
 * private under a temporary name and renamed into place, so another client never sees it half done.
 */
export function ensurePrivateDir(dir: string, host: LaunchHost): void {
	if (!fs.existsSync(dir)) {
		const fresh = path.join(path.dirname(dir), `.new-${randomBytes(6).toString('hex')}`);
		fs.mkdirSync(fresh, { mode: 0o700 });
		try {
			if (host.platform === 'win32') { host.restrictToUser(fresh); } else { fs.chmodSync(fresh, 0o700); }
			fs.renameSync(fresh, dir);
		} catch {
			// Another client made it meanwhile; its directory is checked below like any other.
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	}
	checkPrivateDir(dir, host);
}

/** The SHA-256 of a file, lowercase hex, or undefined when it is not there. */
export async function hashFile(file: string): Promise<string | undefined> {
	try {
		const hash = createHash('sha256');
		for await (const chunk of fs.createReadStream(file)) { hash.update(chunk as Buffer); }
		return hash.digest('hex');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw error;
	}
}

/** Windows refuses to replace a file that runs or is open without sharing. */
const REPLACE_REFUSED = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

/**
 * The verified copy of `launch.binary` under `stateRoot`: reused when it hashes to
 * `launch.sha256`, else copied again. Refuses a binary whose copy does not match.
 */
export async function verifiedCopy(launch: LaunchSpec, stateRoot: string, host: LaunchHost): Promise<string> {
	if (!SHA256.test(launch.sha256)) {
		throw new DaemonStartError('sha_mismatch', `The SHA-256 recorded for the cockpit daemon ${launch.binary} is not valid; it was not started.`);
	}
	fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const bin = path.join(stateRoot, 'bin');
	const dir = path.join(bin, launch.sha256);
	const target = path.join(dir, daemonBinaryName(host.platform));
	for (let attempt = 0; attempt < 3; attempt++) {
		// In every round: another client's clean-up may have removed the folder meanwhile.
		ensurePrivateDir(bin, host);
		ensurePrivateDir(dir, host);
		if (await hashFile(target) === launch.sha256) {
			markInUse(dir);
			return target;
		}
		if (!fs.existsSync(launch.binary)) {
			throw new DaemonStartError('missing_binary', `The cockpit daemon ${launch.binary} is missing.`);
		}
		const temp = path.join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
		try {
			await fs.promises.copyFile(launch.binary, temp, fs.constants.COPYFILE_EXCL);
			if (host.platform !== 'win32') { await fs.promises.chmod(temp, 0o700); }
			const copied = await hashFile(temp);
			// Gone before it was hashed: removed by another client's clean-up, not a mismatch. Copy again.
			if (copied === undefined) { continue; }
			if (copied !== launch.sha256) {
				const hint = launch.buildKind === 'development'
					? 'Rebuild it with npm run daemon:build, which writes its manifest again.'
					: 'Reinstall EVƎ Cockpit.';
				throw new DaemonStartError('sha_mismatch',
					`The cockpit daemon ${launch.binary} does not match the SHA-256 its package recorded: it is ${copied}, the package says ${launch.sha256}. It was not started. ${hint}`);
			}
			await fs.promises.rename(temp, target);
		} catch (error) {
			if (error instanceof DaemonStartError) { throw error; }
			// The folder went meanwhile, or another client placed the copy, or it runs: the next round checks.
			const code = (error as NodeJS.ErrnoException).code ?? '';
			if (code !== 'ENOENT' && !REPLACE_REFUSED.has(code)) { throw error; }
		} finally {
			await fs.promises.rm(temp, { force: true });
		}
	}
	throw new DaemonStartError('failed', `The verified copy of the cockpit daemon could not be placed in ${dir}.`);
}

/** A copy folder touched this recently may be about to start: clean-up leaves it. */
export const RECENT_COPY_MS = 10 * 60_000;

/** Marks a verified copy as just used, so no other client's clean-up removes it before it starts. */
function markInUse(dir: string): void {
	try {
		const now = new Date();
		fs.utimesSync(dir, now, now);
	} catch { /* only a guard for the clean-up */ }
}

/**
 * Removes the verified copies other than `keep` (SHA-256 values). A locked one stays, and so does
 * one used in the last minutes: another client may be copying it or about to start it.
 */
export function removeOldCopies(stateRoot: string, keep: readonly string[]): void {
	const bin = path.join(stateRoot, 'bin');
	let entries: string[];
	try {
		entries = fs.readdirSync(bin);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!SHA256.test(entry) || keep.includes(entry)) { continue; }
		const dir = path.join(bin, entry);
		try {
			if (Date.now() - fs.statSync(dir).mtimeMs < RECENT_COPY_MS) { continue; }
			for (const file of fs.readdirSync(dir)) { fs.unlinkSync(path.join(dir, file)); }
			fs.rmdirSync(dir);
		} catch {
			// Locked: a daemon still runs from it. The next client tries again.
		}
	}
}

/** Where a channel's install record is: the add-on launch record. */
export function nativeInstallFile(files: Pick<NativeChannelFiles, 'dir'>): string {
	return path.join(files.dir, 'install.json');
}

/** Records the installed cockpit's daemon, so an add-on can start it; written whole or not at all. */
export function recordNativeInstall(files: Pick<NativeChannelFiles, 'dir'>, launch: LaunchSpec): void {
	const file = nativeInstallFile(files);
	const text = `${JSON.stringify({ binary: launch.binary, sha256: launch.sha256, version: launch.version, buildKind: launch.buildKind }, null, 2)}\n`;
	try {
		if (fs.readFileSync(file, 'utf8') === text) { return; }
	} catch { /* not there yet */ }
	fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

/** The installed cockpit's daemon, as its VS Code extension or `ev3` command recorded it. */
export function installedNativeLaunch(files: Pick<NativeChannelFiles, 'dir'>): LaunchSpec | undefined {
	try {
		const launch = readLaunchSpec(readJson(nativeInstallFile(files)));
		return launch && fs.existsSync(launch.binary) ? launch : undefined;
	} catch {
		return undefined;
	}
}

/** The Windows error a code-integrity policy raises when it blocks an executable. */
const ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION = 4551;

function isIntegrityViolation(outcome: SpawnOutcome): boolean {
	if (outcome.kind === 'exit') { return outcome.code === ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION; }
	const { errno, message } = outcome.error;
	return errno === ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION || errno === -ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION
		|| /\b4551\b/.test(message ?? '');
}

function endedHow(outcome: SpawnOutcome): string {
	if (outcome.kind === 'error') { return `it could not be started (${outcome.error.code ?? outcome.error.message})`; }
	return outcome.signal ? `it ended on ${outcome.signal}` : `it exited with code ${String(outcome.code)}`;
}

function logTail(file: string, lines = 12): string {
	try {
		const text = fs.readFileSync(file, 'utf8').trimEnd();
		return text ? `\nIts log ${file} ends:\n${text.split('\n').slice(-lines).join('\n')}` : '';
	} catch {
		return '';
	}
}

/** The daemon's exit codes that mean it ran and decided to stop. */
const LOCK_HELD = 2;
const REFUSED = 3;

/**
 * Every exit code the daemon documents: 0 a clean end, 1 a failure, 2 the lock held, 3 a refusal
 * to run, 64 a command line it did not understand. A process that exited with one of them ran.
 */
const DAEMON_EXIT_CODES: readonly number[] = [0, 1, LOCK_HELD, REFUSED, 64];

/**
 * Why a started daemon ended before it answered.
 *
 * - Error 4551, the code-integrity violation itself, as an error or an exit code: Smart App
 *   Control, whatever the policy says.
 * - One of the daemon's own exit codes: it ran, so it was not blocked; read by the code and the end
 *   of its log, never as Smart App Control.
 * - On Windows anything else (a spawn error with any code, or an exit with a code the daemon never
 *   uses) is Smart App Control when the policy reads on or in evaluation.
 */
export function classifyStartFailure(outcome: SpawnOutcome, binary: string, host: LaunchHost, logFile: string): DaemonStartError {
	const blocked = (): DaemonStartError => new DaemonStartError('smart_app_control',
		`Windows Smart App Control blocked the EVƎ Cockpit daemon (${binary}). Smart App Control lets only signed or well-known apps run, and the cockpit's daemon is not signed yet, so the cockpit cannot run on this computer while Smart App Control is on.`);
	if (host.platform === 'win32' && isIntegrityViolation(outcome)) { return blocked(); }
	if (outcome.kind === 'exit' && outcome.code === LOCK_HELD) {
		return new DaemonStartError('lock_held', `Another cockpit daemon holds this channel's lock while it starts or ends; ${binary} stopped.`);
	}
	if (outcome.kind === 'exit' && outcome.code === REFUSED) {
		return new DaemonStartError('name_held',
			`The cockpit daemon refused to run: its pipe or socket name may be held by someone else, or it was started with administrator or root rights.${logTail(logFile)}`);
	}
	const ran = outcome.kind === 'exit' && outcome.code !== null && DAEMON_EXIT_CODES.includes(outcome.code);
	if (host.platform === 'win32' && !ran) {
		const policy = host.smartAppControlPolicy();
		if (policy === 1 || policy === 2) { return blocked(); }
	}
	return new DaemonStartError('failed', `The cockpit daemon could not start: ${endedHow(outcome)}.${logTail(logFile)}`);
}
