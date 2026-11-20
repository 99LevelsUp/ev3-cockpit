/**
 * The cockpit's bundles (KTD16): the extension, the daemon, the `ev3` command and the MCP server.
 *
 *   node scripts/bundle.cjs                     all four into out/
 *   node scripts/bundle.cjs --sourcemap         with source maps, for development (F5)
 *   node scripts/bundle.cjs daemon cli          only these
 *
 * They lie side by side in one folder: the command and the MCP server find the daemon as the
 * `daemon.js` beside them, and the installation one folder up (`cliLaunch`, `installation`). Every
 * bundle leaves the same modules external: VS Code's API, and the native modules, which ship
 * prebuilt per platform beside the bundle (the VSIX) or as optional dependencies (npm). Everything
 * else is inlined, so the npm package of the daemon needs no other dependency.
 */
'use strict';

const path = require('path');

const REPO = path.resolve(__dirname, '..');

/** The modules no bundle inlines. */
const EXTERNALS = ['vscode', 'node-hid', 'serialport', 'koffi', 'usb'];

/** Each bundle: its entry in the sources, its file in the output folder, and whether a shell runs it. */
const BUNDLES = {
	extension: { entry: 'src/vscode/extension.ts', file: 'extension.js', executable: false },
	daemon: { entry: 'src/daemon/main.ts', file: 'daemon.js', executable: false },
	cli: { entry: 'src/cli/main.ts', file: 'cli.js', executable: true },
	mcp: { entry: 'src/mcp/main.ts', file: 'mcp.js', executable: true },
};

/** Builds the named bundles (all by default) into `outDir` (out/ by default). */
function bundle({ names = Object.keys(BUNDLES), outDir = path.join(REPO, 'out'), sourcemap = false } = {}) {
	const esbuild = require('esbuild');
	for (const name of names) {
		const spec = BUNDLES[name];
		if (!spec) { throw new Error(`Unknown bundle ${name}; known: ${Object.keys(BUNDLES).join(', ')}.`); }
		esbuild.buildSync({
			entryPoints: [path.join(REPO, spec.entry)],
			bundle: true,
			platform: 'node',
			target: 'node20',
			external: EXTERNALS,
			outfile: path.join(outDir, spec.file),
			sourcemap,
			logLevel: 'warning',
			...(spec.executable ? { banner: { js: '#!/usr/bin/env node' } } : {}),
		});
	}
}

module.exports = { EXTERNALS, BUNDLES, bundle };

if (require.main === module) {
	const args = process.argv.slice(2);
	const names = args.filter((arg) => !arg.startsWith('--'));
	try {
		bundle({ ...(names.length ? { names } : {}), sourcemap: args.includes('--sourcemap') });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
