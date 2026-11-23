/**
 * Stages the npm packages; it never publishes.
 *
 *   node scripts/package-npm.mts                                 compile and bundle, then stage the
 *                                                                client and cockpit packages into dist/npm/
 *   node scripts/package-npm.mts --skip-build                    stage from what out/ already holds
 *   node scripts/package-npm.mts --platform <target> [--daemon-dir <dir>]
 *                                                                stage that platform's package
 *   node scripts/package-npm.mts --out <dir>                     somewhere else than dist/npm/
 *
 * - `dist/npm/client/` is `@ev3-cockpit/client`: the contract and the client library, compiled from
 *   src/contract and src/client (`npm run compile`) with their types, and only the files the
 *   library's entry reaches. It is what add-ons import, so it carries no native module; the staging
 *   fails if its code requires one.
 * - `dist/npm/cockpit/` is `ev3-cockpit`: the `ev3` launcher (the bundle `out/ev3.js`), the udev
 *   rules the daemon's messages name, and the platform packages as optional dependencies at exactly
 *   its version. The launcher starts the native `ev3` of the platform package npm installed.
 * - `dist/npm/<target>/` is `@ev3-cockpit/<target>`: the native `ev3` and the daemon built for that
 *   platform, with the daemon's manifest, and `os` and `cpu` so npm installs only the one for the
 *   computer it lands on (the pattern esbuild ships its binaries with). `ev3` finds the daemon
 *   beside itself. The binaries come from `--daemon-dir`, by default where `package-vsix.mts` takes
 *   the daemon from, and are checked like a VSIX's: the manifest records the daemon's SHA-256, the
 *   package's version and a release build, and on Linux both are executable. A Linux platform
 *   package is packed (`npm pack`) on Linux, where the mode survives.
 *
 * All take their version from the root package.json, the one the pre-commit hook bumps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundle } from './bundle.mts';
import { TARGETS, DAEMON_MANIFEST, NATIVE_MODULES, UDEV_RULES, cliBinary, daemonBinary, daemonProblems, requiredModules } from './packaging.mts';

export { requiredModules };

const REPO = path.resolve(import.meta.dirname, '..');
export const CLIENT_NAME = '@ev3-cockpit/client';
export const COCKPIT_NAME = 'ev3-cockpit';
/** The bundle the cockpit package carries: the launcher of the native `ev3`. */
export const COCKPIT_BUNDLES: readonly string[] = ['ev3'];

/** The root package.json, as far as the staging reads it. */
export interface RootManifest {
	readonly version: string;
	readonly license: string;
	readonly repository: unknown;
	readonly engines: { readonly node: string };
	readonly dependencies?: Readonly<Record<string, string>>;
}

/** The npm package carrying a platform's `ev3` and daemon (what `platformPackage` of src/npm/ev3.ts resolves). */
export function platformPackageName(target: string): string {
	return `@ev3-cockpit/${target}`;
}

function filesUnder(dir: string, suffix: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { return filesUnder(full, suffix); }
		return entry.name.endsWith(suffix) ? [full] : [];
	});
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
}

/** What the packages share with the root package. */
function common(root: RootManifest): Record<string, unknown> {
	return {
		version: root.version,
		license: root.license,
		repository: root.repository,
		engines: { node: root.engines.node },
	};
}

/**
 * The compiled files the client library's entry reaches, as paths relative to the compiled tree
 * without their extension (`client/index`, `contract/errors`, …): what its code requires and what
 * its types import, followed from `client/index`.
 */
function clientClosure(compiled: string): string[] {
	const found = new Set<string>();
	const queue = ['client/index'];
	const specifiers = /(?:require\(|from |import\()\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;
	for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
		if (found.has(rel)) { continue; }
		const js = path.join(compiled, `${rel}.js`);
		if (!fs.existsSync(js)) { throw new Error(`${js} is missing; compile first (npm run compile).`); }
		found.add(rel);
		for (const ext of ['.js', '.d.ts']) {
			const file = path.join(compiled, `${rel}${ext}`);
			if (!fs.existsSync(file)) { continue; }
			const source = fs.readFileSync(file, 'utf8');
			for (let match = specifiers.exec(source); match; match = specifiers.exec(source)) {
				const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]));
				queue.push(fs.existsSync(path.join(compiled, `${target}.js`)) ? target : `${target}/index`);
			}
		}
	}
	return [...found].sort();
}

/**
 * `@ev3-cockpit/client`: the contract and the library with their types, as `npm run compile` built
 * them from src/contract and src/client (into `compiled`, out/ by default), and only what the
 * library's entry reaches.
 */
export function stageClient(out: string, root: RootManifest, compiled = path.join(REPO, 'out')): string {
	const dir = path.join(out, 'client');
	fs.rmSync(dir, { recursive: true, force: true });
	for (const rel of clientClosure(compiled)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		for (const ext of ['.js', '.d.ts']) {
			const from = path.join(compiled, `${rel}${ext}`);
			if (!fs.existsSync(from)) { throw new Error(`${from} is missing; compile first (npm run compile).`); }
			// The compiler's source map comment points into src/, which the package does not carry.
			const text = fs.readFileSync(from, 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
			fs.writeFileSync(path.join(dir, `${rel}${ext}`), text);
		}
	}

	const needed = new Set(filesUnder(dir, '.js').flatMap((file) => requiredModules(fs.readFileSync(file, 'utf8'))));
	const natives = [...needed].filter((name) => NATIVE_MODULES.includes(name));
	if (natives.length) { throw new Error(`${CLIENT_NAME} must not require a native module, and requires ${natives.join(', ')}.`); }
	const dependencies = Object.fromEntries([...needed].sort().map((name) => {
		const version = root.dependencies?.[name];
		if (!version) { throw new Error(`${CLIENT_NAME} requires ${name}, which the root package.json does not depend on.`); }
		return [name, version];
	}));

	fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(dir, 'LICENSE'));
	writeManifest(dir, {
		name: CLIENT_NAME,
		description: 'The EVƎ Cockpit contract and client library: talk to the cockpit daemon from Node.',
		...common(root),
		main: 'client/index.js',
		types: 'client/index.d.ts',
		dependencies,
	});
	return dir;
}

/** `ev3-cockpit`: the launcher, the udev rules, and the platform packages as optional dependencies. */
export function stageCockpit(out: string, root: RootManifest, { bundles }: { readonly bundles: string }): string {
	const dir = path.join(out, 'cockpit');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });

	for (const name of COCKPIT_BUNDLES) {
		const from = path.join(bundles, `${name}.js`);
		if (!fs.existsSync(from)) { throw new Error(`${from} is missing; build first (npm run bundle).`); }
		const to = path.join(dir, 'bin', `${name}.js`);
		fs.copyFileSync(from, to);
		fs.chmodSync(to, 0o755);
		// Everything is inlined; anything required would be missing once installed.
		const stray = requiredModules(fs.readFileSync(to, 'utf8'));
		if (stray.length) { throw new Error(`bin/${name}.js requires ${stray.join(', ')}, which ${COCKPIT_NAME} does not ship.`); }
	}

	for (const rule of UDEV_RULES) {
		fs.mkdirSync(path.dirname(path.join(dir, rule)), { recursive: true });
		fs.copyFileSync(path.join(REPO, rule), path.join(dir, rule));
	}

	fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(dir, 'LICENSE'));
	writeManifest(dir, {
		name: COCKPIT_NAME,
		description: 'The EVƎ Cockpit ev3 command, its MCP server (ev3 mcp) and the cockpit daemon, for EV3 bricks.',
		...common(root),
		bin: { ev3: 'bin/ev3.js' },
		// npm installs the one whose os and cpu match; exactly this version, the binaries built with it.
		optionalDependencies: Object.fromEntries(Object.keys(TARGETS).map((target) => [platformPackageName(target), root.version])),
	});
	return dir;
}

/**
 * `@ev3-cockpit/<target>`: the native `ev3` and the daemon from `daemonDir`, with the daemon's
 * manifest, checked before they are staged. `checkMode` says whether the file system shows Unix
 * permissions (not on Windows).
 */
export function stagePlatform(out: string, root: RootManifest, target: string,
	{ daemonDir, checkMode = process.platform !== 'win32' }: { readonly daemonDir: string; readonly checkMode?: boolean }): string {
	if (!TARGETS[target]) { throw new Error(`Unknown target ${target}; known: ${Object.keys(TARGETS).join(', ')}.`); }
	const binary = daemonBinary(target);
	const cli = cliBinary(target);
	for (const file of [binary, DAEMON_MANIFEST, cli]) {
		if (!fs.existsSync(path.join(daemonDir, file))) {
			throw new Error(`${path.join(daemonDir, file)} is missing; build the daemon and ev3 for ${target} with EV3_COCKPIT_RELEASE_BUILD=1 and write the daemon's manifest (npm run daemon:build:release).`);
		}
	}
	const dir = path.join(out, target);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	for (const file of [binary, DAEMON_MANIFEST, cli]) { fs.copyFileSync(path.join(daemonDir, file), path.join(dir, file)); }
	const { os, cpu } = TARGETS[target];
	if (os !== 'win32') {
		fs.chmodSync(path.join(dir, binary), 0o755);
		fs.chmodSync(path.join(dir, cli), 0o755);
	}
	const problems = daemonProblems(target, {
		data: fs.readFileSync(path.join(dir, binary)),
		...(checkMode ? { mode: fs.statSync(path.join(dir, binary)).mode } : {}),
	}, fs.readFileSync(path.join(dir, DAEMON_MANIFEST), 'utf8'), root.version);
	if (checkMode && os !== 'win32' && (fs.statSync(path.join(dir, cli)).mode & 0o111) !== 0o111) {
		problems.push(`${cli} is not executable; a Linux package is built on Linux, where the build keeps the mode.`);
	}
	if (problems.length) { throw new Error(`${platformPackageName(target)} is wrong.\n  ${problems.join('\n  ')}`); }

	fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(dir, 'LICENSE'));
	writeManifest(dir, {
		name: platformPackageName(target),
		description: `The EVƎ Cockpit ev3 command and daemon for ${target}; installed by ev3-cockpit on that platform.`,
		...common(root),
		os: [os],
		cpu: [cpu],
		files: [cli, binary, DAEMON_MANIFEST],
	});
	return dir;
}

/** Stages the client and cockpit packages into `out`. */
export function stageNpm({ out, bundles }: { readonly out: string; readonly bundles: string }): { client: string; cockpit: string; version: string } {
	const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as RootManifest;
	const client = stageClient(out, root);
	const cockpit = stageCockpit(out, root, { bundles });
	return { client, cockpit, version: root.version };
}

/** Whether this file is the script node was started with, rather than a module another one loads. */
function startedDirectly(): boolean {
	const entry = process.argv[1];
	try {
		return entry !== undefined && fs.realpathSync.native(entry) === fs.realpathSync.native(import.meta.filename);
	} catch {
		return false;
	}
}

if (startedDirectly()) {
	try {
		const args = process.argv.slice(2);
		const option = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
		const outOption = option('--out');
		const out = outOption ? path.resolve(outOption) : path.join(REPO, 'dist', 'npm');
		const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as RootManifest;
		const platform = option('--platform');
		if (platform) {
			if (!TARGETS[platform]) { throw new Error(`Unknown target ${platform}; known: ${Object.keys(TARGETS).join(', ')}.`); }
			const host = `${process.platform}-${process.arch}`;
			const targetDir = path.resolve(REPO, 'daemon', process.env.CARGO_TARGET_DIR || 'target');
			const daemonDir = path.resolve(option('--daemon-dir')
				?? (platform === host ? path.join(targetDir, 'release') : path.join(targetDir, TARGETS[platform].triple, 'release')));
			const dir = stagePlatform(out, root, platform, { daemonDir });
			console.log(`Staged ${platformPackageName(platform)} ${root.version} in ${dir}; nothing is published.`);
		} else {
			const bundles = path.join(REPO, 'out');
			if (!args.includes('--skip-build')) {
				const tsc = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', REPO], { cwd: REPO, stdio: 'inherit' });
				if (tsc.status !== 0) { throw new Error('npm run compile failed.'); }
				bundle({ names: COCKPIT_BUNDLES, outDir: bundles });
			}
			const staged = stageNpm({ out, bundles });
			console.log(`Staged ${CLIENT_NAME} and ${COCKPIT_NAME} ${staged.version} in ${out}; nothing is published.`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
