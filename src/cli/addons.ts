/**
 * Add-ons: `ev3 <name> …` runs an installed program called `ev3-<name>`.
 *
 * The cockpit finds it itself, walking PATH, so nothing about the lookup is left to a shell:
 * - only absolute PATH entries count; the current folder and relative entries never do, on any OS;
 * - the name must match `^[a-z][a-z0-9-]*$`, so it cannot climb folders or carry shell syntax;
 * - on Windows only `.exe` files and the `.cmd` shims npm installs count. A shim is read for the
 *   Node script it starts, and that script is run with the Node running this command, never
 *   through `cmd.exe`;
 * - the program is started by its absolute path, with no shell, and its arguments are passed on
 *   as they are.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UsageError } from './output';

export const ADDON_NAME = /^[a-z][a-z0-9-]*$/;

/** How to start an add-on. */
export interface AddonLaunch {
	/** An absolute path. */
	readonly command: string;
	readonly args: readonly string[];
	/** The file found on PATH. */
	readonly found: string;
}

export interface FindOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	/** The Node that runs a shim's script. */
	readonly execPath?: string;
}

/** PATH, whatever case Windows spells its name in. */
function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (platform !== 'win32') { return env.PATH ?? ''; }
	const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
	return key ? env[key] ?? '' : '';
}

function isFile(file: string): boolean {
	try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isExecutable(file: string): boolean {
	try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * The Node script an npm `.cmd` shim starts. npm's shims end with a line that runs
 * `"%dp0%\…\script.js" %*` (older ones `"%~dp0\…"`); the last such script is the one.
 */
export function shimScript(shimFile: string, text: string): string | undefined {
	const pattern = /"%~?dp0%?\\([^"%]+?\.[cm]?js)"\s+%\*/gi;
	let last: string | undefined;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) { last = match[1]; }
	if (!last) { return undefined; }
	const script = path.resolve(path.dirname(shimFile), last.replace(/\\/g, path.sep));
	return isFile(script) ? script : undefined;
}

/** Checks an add-on's name; a name that could escape its folder or reach a shell is refused. */
export function checkAddonName(name: string): void {
	if (!ADDON_NAME.test(name)) {
		throw new UsageError(`${JSON.stringify(name)} is not a command, and not a name an add-on can have (lowercase letters, digits and dashes).`);
	}
}

/** Finds `ev3-<name>` on PATH; undefined when no folder on PATH has it. */
export function findAddon(name: string, options: FindOptions): AddonLaunch | undefined {
	checkAddonName(name);
	const platform = options.platform ?? process.platform;
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const file = `ev3-${name}`;
	for (const raw of pathValue(options.env, platform).split(platform === 'win32' ? ';' : ':')) {
		const dir = raw.trim().replace(/^"(.*)"$/, '$1');
		if (dir === '' || !pathApi.isAbsolute(dir)) { continue; }
		if (platform === 'win32') {
			const exe = pathApi.join(dir, `${file}.exe`);
			if (isFile(exe)) { return { command: exe, args: [], found: exe }; }
			const shim = pathApi.join(dir, `${file}.cmd`);
			if (isFile(shim)) {
				const script = shimScript(shim, fs.readFileSync(shim, 'utf8'));
				if (!script) { continue; }
				return { command: options.execPath ?? process.execPath, args: [script], found: shim };
			}
		} else {
			const candidate = pathApi.join(dir, file);
			if (isFile(candidate) && isExecutable(candidate)) { return { command: candidate, args: [], found: candidate }; }
		}
	}
	return undefined;
}

/** Runs an add-on in this terminal and resolves its exit code. */
export function runAddon(launch: AddonLaunch, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(launch.command, [...launch.args, ...args], { stdio: 'inherit', shell: false, env });
		child.once('error', (error) => {
			process.stderr.write(`ev3: ${launch.found} could not start: ${error.message}\n`);
			resolve(1);
		});
		child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}
