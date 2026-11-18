/**
 * The core runs without VS Code.
 *
 * Everything under src/core must load in plain Node, where a daemon or a command-line tool will run
 * it, so it may depend neither on the `vscode` module nor on anything under src/vscode. The lint
 * rule for src/core says the same; this test also catches what lint cannot see once the code is
 * compiled, and proves the entry points load in a process with no `vscode` at all.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as ts from 'typescript';

const REPO = path.resolve(__dirname, '..', '..');
const CORE_SRC = path.join(REPO, 'src', 'core');
const VSCODE_SRC = path.join(REPO, 'src', 'vscode');
const CORE_OUT = path.join(REPO, 'out', 'core');

function filesUnder(dir: string, extension: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { found.push(...filesUnder(full, extension)); } else if (entry.name.endsWith(extension)) { found.push(full); }
	}
	return found;
}

/**
 * Every module a file names, read from its syntax tree rather than its text, so a path in a string
 * or a comment is not a dependency: imports and re-exports (type-only too), `import()`, `require()`,
 * `typeof import()`, `import x = require()`, and `/// <reference types>` or `path` directives.
 */
function specifiersOf(fileName: string, source: string): string[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const found: string[] = [
		...file.typeReferenceDirectives.map((d) => d.fileName),
		...file.referencedFiles.map((d) => d.fileName),
	];
	const literal = (node: ts.Node | undefined): string | undefined =>
		node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
	const visit = (node: ts.Node): void => {
		let named: string | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			named = literal(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			named = literal(node.moduleReference.expression);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			named = literal(node.argument.literal);
		} else if (ts.isCallExpression(node)
			&& (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			named = literal(node.arguments[0]);
		}
		if (named !== undefined) { found.push(named); }
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** Why a specifier crosses the boundary, or undefined when it does not. */
function crossing(file: string, specifier: string): string | undefined {
	if (specifier === 'vscode' || specifier.startsWith('vscode/')) { return 'the vscode module'; }
	if (specifier.startsWith('.')) {
		const target = path.resolve(path.dirname(file), specifier);
		if (target === VSCODE_SRC || target.startsWith(VSCODE_SRC + path.sep)) { return 'a module under src/vscode'; }
	}
	return undefined;
}

describe('the core runs without VS Code', () => {
	it('no core source names the vscode module or a module under src/vscode', () => {
		const offences: string[] = [];
		let scanned = 0;
		for (const file of filesUnder(CORE_SRC, '.ts')) {
			for (const specifier of specifiersOf(file, fs.readFileSync(file, 'utf8'))) {
				scanned += 1;
				const why = crossing(file, specifier);
				if (why) { offences.push(`${path.relative(REPO, file)}: '${specifier}' (${why})`); }
			}
		}
		// The core has hundreds of imports: a scan that found almost none would prove nothing.
		assert.ok(scanned > 300, `only ${scanned} module specifiers found in the core`);
		assert.deepEqual(offences, []);
	});

	it('no compiled core module requires vscode', () => {
		const offences = filesUnder(CORE_OUT, '.js')
			.filter((file) => specifiersOf(file, fs.readFileSync(file, 'utf8')).some((s) => crossing(file, s) === 'the vscode module'))
			.map((file) => path.relative(REPO, file));
		assert.deepEqual(offences, []);
	});

	it('the core entry points load in a fresh Node process that has no vscode module', () => {
		const entries = ['runtime/index', 'transports/index', 'api/cockpitApi'].map((e) => path.join(CORE_OUT, e));
		const script = `for (const e of ${JSON.stringify(entries)}) { require(e); } process.stdout.write('loaded');`;
		const env = { ...process.env };
		delete env.NODE_OPTIONS;
		delete env.NODE_TEST_CONTEXT;
		const run = spawnSync(process.execPath, ['-e', script], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, 'loaded');
	});
});
