/**
 * The cockpit's bundles: the extension and the npm package's `ev3` launcher. The daemon and the
 * `ev3` command are native binaries built by cargo, not bundles.
 *
 *   node scripts/bundle.mts                     both into out/
 *   node scripts/bundle.mts --sourcemap         with source maps, for development (F5)
 *   node scripts/bundle.mts ev3                 only this one
 *   node scripts/bundle.mts api-check           the API check add-on, into scripts/api-check/
 *
 * Installed, the extension finds the daemon and its manifest in its own folder; the launcher starts
 * the native `ev3` of the npm platform package for this computer, which finds the daemon beside it.
 * Every bundle inlines everything but VS Code's API, so neither package needs a dependency at run time.
 * The Node native modules of the old daemon stay external, so an import of one that crept back
 * shows as a `require` the packaging checks refuse, instead of being inlined without its binary.
 *
 * The API check (scripts/api-check, a development extension for hardware sessions, never shipped)
 * is built only when named: VS Code loads it as `scripts/api-check/extension.js`, which is this
 * build's output and is not committed. `npm run compile` builds it.
 */

import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { NATIVE_MODULES } from './packaging.mts';

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..');

/** The modules no bundle inlines. */
export const EXTERNALS: readonly string[] = ['vscode', ...NATIVE_MODULES];

/** A bundle: its entry in the sources, its file in the output folder, and whether a shell runs it. */
export interface BundleSpec {
	readonly entry: string;
	readonly file: string;
	readonly executable: boolean;
	/** Where it goes whatever the output folder, relative to the repository; built only when named. */
	readonly fixedOut?: string;
}

/** Each bundle: its entry in the sources, its file in the output folder, and whether a shell runs it. */
export const BUNDLES: Readonly<Record<string, BundleSpec>> = {
	extension: { entry: 'src/vscode/extension.ts', file: 'extension.js', executable: false },
	ev3: { entry: 'src/npm/ev3.ts', file: 'ev3.js', executable: true },
	'api-check': { entry: 'scripts/api-check/extension.ts', file: 'extension.js', executable: false, fixedOut: 'scripts/api-check' },
};

/** The bundles built when none is named: every one without a fixed place of its own. */
const DEFAULT_NAMES = Object.keys(BUNDLES).filter((name) => BUNDLES[name].fixedOut === undefined);

export interface BundleOptions {
	readonly names?: readonly string[];
	readonly outDir?: string;
	readonly sourcemap?: boolean;
}

/** Builds the named bundles (both by default) into `outDir` (out/ by default). */
export function bundle({ names = DEFAULT_NAMES, outDir = path.join(REPO, 'out'), sourcemap = false }: BundleOptions = {}): void {
	const esbuild = require('esbuild') as typeof import('esbuild');
	for (const name of names) {
		const spec = Object.hasOwn(BUNDLES, name) ? BUNDLES[name] : undefined;
		if (!spec) { throw new Error(`Unknown bundle ${name}; known: ${Object.keys(BUNDLES).join(', ')}.`); }
		esbuild.buildSync({
			entryPoints: [path.join(REPO, spec.entry)],
			bundle: true,
			platform: 'node',
			target: 'node20',
			external: [...EXTERNALS],
			outfile: path.join(spec.fixedOut === undefined ? outDir : path.join(REPO, spec.fixedOut), spec.file),
			sourcemap,
			logLevel: 'warning',
			...(spec.executable ? { banner: { js: '#!/usr/bin/env node' } } : {}),
		});
	}
}

/** Whether this file is the script node was started with, rather than a module another one loads. */
function startedDirectly(): boolean {
	const entry = process.argv[1];
	try {
		return entry !== undefined && realpathSync.native(entry) === realpathSync.native(import.meta.filename);
	} catch {
		return false;
	}
}

if (startedDirectly()) {
	const args = process.argv.slice(2);
	const names = args.filter((arg) => !arg.startsWith('--'));
	try {
		bundle({ ...(names.length ? { names } : {}), sourcemap: args.includes('--sourcemap') });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
