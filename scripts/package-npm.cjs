/**
 * Stages the two npm packages (KTD16); it never publishes.
 *
 *   node scripts/package-npm.cjs                           compile and bundle, then stage into dist/npm/
 *   node scripts/package-npm.cjs --skip-build              stage from what out/ already holds
 *   node scripts/package-npm.cjs --allow-missing-helpers   stage without a Bluetooth helper, saying so
 *   node scripts/package-npm.cjs --out <dir>               somewhere else than dist/npm/
 *
 * - `dist/npm/client/` is `@ev3-cockpit/client`: the contract and the client library, compiled from
 *   src/contract and src/client (`npm run compile`) with their types, and only the files the
 *   library's entry reaches. It is what add-ons import, so it carries no native module; the staging
 *   fails if its code requires one.
 * - `dist/npm/cockpit/` is `ev3-cockpit`: the daemon, the `ev3` command and the MCP server as the
 *   bundles `out/daemon.js`, `out/cli.js` and `out/mcp.js`, the native modules as optional
 *   dependencies, and the Bluetooth helpers and udev rules at the paths the daemon finds them from its
 *   installation folder (`createRuntime`).
 *
 * Both take their version from the root package.json, the one the pre-commit hook bumps (R31).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { spawnSync } = require('child_process');
const { bundle } = require('./bundle.cjs');
const { NATIVE_MODULES } = require('./packaging.cjs');

const REPO = path.resolve(__dirname, '..');
const CLIENT_NAME = '@ev3-cockpit/client';
const COCKPIT_NAME = 'ev3-cockpit';
/** The bundles the cockpit package carries, all in its out/ folder. */
const COCKPIT_BUNDLES = ['daemon', 'cli', 'mcp'];
/**
 * The Bluetooth helpers the daemon starts from `native/bin` in its installation: the Windows pairing
 * helper (`npm run build:helper`, needs .NET) and the macOS helper (`npm run build:helper:macos`, on
 * a Mac). One package serves every platform, so it carries both.
 */
const HELPERS = ['bt-pairing-helper.exe', 'ev3-bt-helper'];

/**
 * The packages a piece of bundled or compiled code requires, by package name, leaving out Node's own
 * modules and relative files. A `require("…")` inside a string is code another library generates
 * (ajv in the MCP bundle), not a call, and does not count.
 */
function requiredModules(source) {
	const found = new Set();
	const call = /(?<![\w$.'"`])(?:__)?require\(\s*["']([^"']+)["']\s*\)/g;
	for (let match = call.exec(source); match; match = call.exec(source)) {
		const id = match[1];
		if (id.startsWith('.') || id.startsWith('node:') || builtinModules.includes(id.split('/')[0])) { continue; }
		const parts = id.split('/');
		found.add(id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
	}
	return [...found].sort();
}

function filesUnder(dir, suffix) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { return filesUnder(full, suffix); }
		return entry.name.endsWith(suffix) ? [full] : [];
	});
}

function writeManifest(dir, manifest) {
	fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
}

/** What both packages share with the root package. */
function common(root) {
	return {
		version: root.version,
		license: root.license,
		repository: root.repository,
		engines: { node: root.engines.node },
	};
}

/** `@ev3-cockpit/client`: the contract and the library, compiled with their types. */
/**
 * The compiled files the client library's entry reaches, as paths relative to the compiled tree
 * without their extension (`client/index`, `contract/errors`, `daemon/paths`, …): what its code
 * requires and what its types import, followed from `client/index`.
 */
function clientClosure(compiled) {
	const found = new Set();
	const queue = ['client/index'];
	const specifiers = /(?:require\(|from |import\()\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;
	while (queue.length) {
		const rel = queue.pop();
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
function stageClient(out, root, compiled = path.join(REPO, 'out')) {
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

/**
 * `ev3-cockpit`: the three bundles, the helpers and the udev rules. Returns the helpers it went
 * without, which only `allowMissingHelpers` permits.
 */
function stageCockpit(out, root, { bundles, nativeBin, allowMissingHelpers = false }) {
	const dir = path.join(out, 'cockpit');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'out'), { recursive: true });

	for (const name of COCKPIT_BUNDLES) {
		const from = path.join(bundles, `${name}.js`);
		if (!fs.existsSync(from)) { throw new Error(`${from} is missing; build first (npm run bundle).`); }
		const to = path.join(dir, 'out', `${name}.js`);
		fs.copyFileSync(from, to);
		fs.chmodSync(to, 0o755);
		// Everything but the native modules is inlined; anything else would be missing once installed.
		const stray = requiredModules(fs.readFileSync(to, 'utf8')).filter((module) => !NATIVE_MODULES.includes(module));
		if (stray.length) { throw new Error(`out/${name}.js requires ${stray.join(', ')}, which ${COCKPIT_NAME} does not ship.`); }
	}

	fs.mkdirSync(path.join(dir, 'native', 'bin'), { recursive: true });
	if (fs.existsSync(nativeBin)) {
		for (const file of fs.readdirSync(nativeBin)) {
			if (file.endsWith('.pdb') || !fs.statSync(path.join(nativeBin, file)).isFile()) { continue; }   // debug symbols do not ship
			fs.copyFileSync(path.join(nativeBin, file), path.join(dir, 'native', 'bin', file));
		}
	}
	const missingHelpers = HELPERS.filter((helper) => !fs.existsSync(path.join(dir, 'native', 'bin', helper)));
	if (missingHelpers.length && !allowMissingHelpers) {
		throw new Error(`native/bin lacks ${missingHelpers.join(' and ')}: build the Windows helper with npm run build:helper and the macOS one on a Mac with npm run build:helper:macos, or stage with --allow-missing-helpers.`);
	}
	const rules = path.join(REPO, 'native', 'linux');
	fs.mkdirSync(path.join(dir, 'native', 'linux'), { recursive: true });
	for (const file of fs.readdirSync(rules).filter((name) => name.endsWith('.rules'))) {
		fs.copyFileSync(path.join(rules, file), path.join(dir, 'native', 'linux', file));
	}

	fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(dir, 'LICENSE'));
	writeManifest(dir, {
		name: COCKPIT_NAME,
		description: 'The EVƎ Cockpit daemon, the ev3 command and the cockpit MCP server, for EV3 bricks.',
		...common(root),
		bin: { ev3: 'out/cli.js', 'ev3-cockpit-mcp': 'out/mcp.js' },
		// The ranges of the root package.json: npm installs each for the platform it lands on, and a
		// platform without one still runs, without that transport.
		optionalDependencies: Object.fromEntries(NATIVE_MODULES.map((name) => {
			const version = root.optionalDependencies?.[name];
			if (!version) { throw new Error(`The root package.json has no optional dependency ${name}.`); }
			return [name, version];
		})),
	});
	return { dir, missingHelpers };
}

/** Stages both packages into `out`. */
function stageNpm({ out, bundles, nativeBin, allowMissingHelpers = false }) {
	const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
	const client = stageClient(out, root);
	const cockpit = stageCockpit(out, root, { bundles, nativeBin, allowMissingHelpers });
	return { client, cockpit: cockpit.dir, missingHelpers: cockpit.missingHelpers, version: root.version };
}

module.exports = { CLIENT_NAME, COCKPIT_NAME, COCKPIT_BUNDLES, HELPERS, requiredModules, stageClient, stageCockpit, stageNpm };

if (require.main === module) {
	try {
		const args = process.argv.slice(2);
		const at = args.indexOf('--out');
		const out = at >= 0 && args[at + 1] ? path.resolve(args[at + 1]) : path.join(REPO, 'dist', 'npm');
		const bundles = path.join(REPO, 'out');
		if (!args.includes('--skip-build')) {
			const tsc = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', REPO], { cwd: REPO, stdio: 'inherit' });
			if (tsc.status !== 0) { throw new Error('npm run compile failed.'); }
			bundle({ names: COCKPIT_BUNDLES, outDir: bundles });
		}
		const staged = stageNpm({ out, bundles, nativeBin: path.join(REPO, 'native', 'bin'), allowMissingHelpers: args.includes('--allow-missing-helpers') });
		for (const helper of staged.missingHelpers) { console.warn(`Staged without native/bin/${helper}: this package lacks the Bluetooth that goes through it.`); }
		console.log(`Staged ${CLIENT_NAME} and ${COCKPIT_NAME} ${staged.version} in ${out}; nothing is published.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
