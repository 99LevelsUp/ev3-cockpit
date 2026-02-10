import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

await esbuild.build({
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'out/extension.js',
	platform: 'node',
	target: 'es2022',
	format: 'cjs',
	sourcemap: true,
	external: ['vscode', 'node-hid', 'serialport'],
	minify: production,
	metafile: process.argv.includes('--metafile'),
});
