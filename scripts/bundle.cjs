/**
 * The cockpit's bundles: the extension, the `ev3` command and the MCP server. The daemon is the
 * native binary `ev3-cockpitd`, built by cargo, not a bundle.
 *
 *   node scripts/bundle.cjs                     all three into out/
 *   node scripts/bundle.cjs --sourcemap         with source maps, for development (F5)
 *   node scripts/bundle.cjs cli mcp             only these
 *
 * Installed, the extension finds the daemon and its manifest in its own folder; the command and
 * the MCP server find them in the npm platform package for this computer (`installation`). Every
 * bundle inlines everything but VS Code's API, so neither package needs a dependency at run time.
 * The Node native modules of the old daemon stay external, so an import of one that crept back
 * shows as a `require` the packaging checks refuse, instead of being inlined without its binary.
 */
'use strict';

const path = require('path');

const REPO = path.resolve(__dirname, '..');

/** The modules no bundle inlines. */
const { NATIVE_MODULES } = require('./packaging.cjs');
const EXTERNALS = ['vscode', ...NATIVE_MODULES];

/** Each bundle: its entry in the sources, its file in the output folder, and whether a shell runs it. */
const BUNDLES = {
	extension: { entry: 'src/vscode/extension.ts', file: 'extension.js', executable: false },
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
