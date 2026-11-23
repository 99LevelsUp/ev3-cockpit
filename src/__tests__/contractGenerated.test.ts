/**
 * The generated contract (`scripts/generate-contract.mts`, `src/contract/generated/`).
 *
 * One language-neutral schema in `contract/` produces the TypeScript and the Rust contract. These
 * tests check the TypeScript side and the generator's gate: the committed files are current, every
 * message in `contract/vectors/messages.json` (the same file the Rust crate round-trips) type-checks
 * against the generated maps, the stable core takes unknown properties, the schema rules hold, and
 * a breaking change needs a raised contract version. The cross-language vectors in
 * `contract/vectors/channel.json` are checked against today's hello proofs.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as ts from 'typescript';
import { clientProof, daemonProof } from '../client/proofs';
import {
	CONTRACT_VERSION, ERROR_FAMILY, METHODS, SETTING_SPECS, readBuildKind, readClientKind, readDaemonMode, readDaemonState,
} from '../contract/generated';
import type { ChannelRecord } from '../contract/generated';

interface Outcome {
	readonly ok: boolean;
	readonly problems: readonly string[];
	readonly notes?: readonly string[];
	readonly written?: readonly string[];
}
interface Paths { readonly contractDir?: string; readonly outDir?: string }
interface Generator {
	generate(paths?: Paths): Promise<Outcome>;
	check(paths?: Paths): Promise<Outcome>;
	snapshot(paths?: Paths): Outcome;
	readonly NO_SNAPSHOT: string;
}

const ROOT = path.join(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require(path.join(ROOT, 'scripts', 'generate-contract.mts')) as Generator;

type Json = Record<string, unknown>;
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
const messages = readJson(path.join(ROOT, 'contract', 'vectors', 'messages.json'));
const table = readJson(path.join(ROOT, 'contract', 'methods.json'));

/** Type-checks `source` as a module sitting in `src/contract/generated/`; returns the errors. */
function typeCheck(source: string): string[] {
	const file = path.join(ROOT, 'src', 'contract', 'generated', '__check__.ts').split(path.sep).join('/');
	const isCheck = (name: string): boolean => path.resolve(name) === path.resolve(file);
	const options: ts.CompilerOptions = {
		strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, types: [], skipLibCheck: true,
	};
	const host = ts.createCompilerHost(options);
	const { getSourceFile, fileExists, readFile } = host;
	host.getSourceFile = (name, language, ...rest) => isCheck(name)
		? ts.createSourceFile(name, source, language)
		: getSourceFile.call(host, name, language, ...rest);
	host.fileExists = (name) => isCheck(name) || fileExists.call(host, name);
	host.readFile = (name) => isCheck(name) ? source : readFile.call(host, name);
	const program = ts.createProgram([file], options, host);
	return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function messagesModule(vectors: Json): string {
	return [
		'import type { ClientRequests, HelloMethods, Methods, Notifications } from \'./index\';',
		'type Exchange<T extends { params: unknown; result: unknown }> = { params: T[\'params\']; result: T[\'result\'] };',
		`export const hello: { [M in keyof HelloMethods]: Exchange<HelloMethods[M]> } = ${JSON.stringify(vectors.hello)};`,
		`export const methods: { [M in keyof Methods]: Exchange<Methods[M]> } = ${JSON.stringify(vectors.methods)};`,
		`export const notifications: { [N in keyof Notifications]: Notifications[N] } = ${JSON.stringify(vectors.notifications)};`,
		`export const clientRequests: { [R in keyof ClientRequests]: Exchange<ClientRequests[R]> } = ${JSON.stringify(vectors.clientRequests)};`,
	].join('\n');
}

const tempDirs: string[] = [];
after(() => { for (const dir of tempDirs) { fs.rmSync(dir, { recursive: true, force: true }); } });

/** A copy of `contract/` in a temporary folder, changed by `change`, with an output folder beside it. */
function tempContract(change: (files: { schema: (name: string) => Json; table: Json }) => void = () => undefined): Required<Paths> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-contract-'));
	tempDirs.push(dir);
	const contractDir = path.join(dir, 'contract');
	fs.cpSync(path.join(ROOT, 'contract'), contractDir, { recursive: true });
	fs.rmSync(path.join(contractDir, 'released'), { recursive: true, force: true });
	editContract(contractDir, change);
	return { contractDir, outDir: path.join(dir, 'generated') };
}

function editContract(contractDir: string, change: (files: { schema: (name: string) => Json; table: Json }) => void): void {
	const loaded = new Map<string, Json>();
	const schema = (name: string): Json => {
		const file = path.join(contractDir, 'schema', `${name}.json`);
		if (!loaded.has(file)) { loaded.set(file, readJson(file)); }
		return loaded.get(file)!;
	};
	const tableFile = path.join(contractDir, 'methods.json');
	const contractTable = readJson(tableFile);
	loaded.set(tableFile, contractTable);
	change({ schema, table: contractTable });
	for (const [file, value] of loaded) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
}

/** The definition `name` in schema file `file`. */
function definition(files: { schema: (name: string) => Json }, file: string, name: string): Json {
	return (files.schema(file).definitions as Record<string, Json>)[name];
}

function methodsTable(files: { table: Json }): Record<string, Json> {
	return files.table.methods as Record<string, Json>;
}

describe('generated contract', () => {
	it('the committed files are what the schema gives now', async () => {
		const result = await generator.check();
		assert.deepEqual(result.problems, []);
		assert.equal(result.ok, true);
	});

	it('every message of the method table type-checks against the generated maps', () => {
		assert.deepEqual(typeCheck(messagesModule(messages)), []);
	});

	it('a message that does not fit its type fails the type check', () => {
		const broken = JSON.parse(JSON.stringify(messages)) as { methods: Record<string, { result: Json }> };
		delete broken.methods['bricks/info'].result.name;
		broken.methods['bricks/storage'].result.usedKb = 1;
		const errors = typeCheck(messagesModule(broken as unknown as Json));
		assert.ok(errors.some((e) => e.includes('\'name\'')), errors.join('\n'));
		assert.ok(errors.some((e) => e.includes('usedKb')), errors.join('\n'));
	});

	it('a request without a message fails the type check', () => {
		const missing = JSON.parse(JSON.stringify(messages)) as { methods: Record<string, unknown> };
		delete missing.methods['shell/run'];
		const errors = typeCheck(messagesModule(missing as unknown as Json));
		assert.ok(errors.some((e) => e.includes('shell/run')), errors.join('\n'));
	});

	it('stable-core messages take unknown properties; other messages stay exact', () => {
		const hello = messages.hello as Record<string, { params: Json; result: Json }>;
		const exit = (messages.methods as Record<string, { params: Json; result: Json }>)['daemon/exit'];
		const extra = (value: Json): string => JSON.stringify({ ...value, addedLater: { nested: [1, 2] } });
		const core = [
			'import type { ChannelRecord, DaemonExitParams, DaemonExitResult, HelloAccepted, HelloChallenge, HelloFinish, HelloStart } from \'./index\';',
			`export const start: HelloStart = ${extra(hello['hello/start'].params)};`,
			`export const challenge: HelloChallenge = ${extra(hello['hello/start'].result)};`,
			`export const finish: HelloFinish = ${extra(hello['hello/finish'].params)};`,
			`export const accepted: HelloAccepted = ${extra(hello['hello/finish'].result)};`,
			`export const exitParams: DaemonExitParams = ${extra(exit.params)};`,
			`export const exitResult: DaemonExitResult = ${extra(exit.result)};`,
			`export const record: ChannelRecord = ${extra({ path: '/run/user/1000/ev3-cockpit/daemon-0a.sock', pid: 7 })};`,
		].join('\n');
		assert.deepEqual(typeCheck(core), []);
		const exact = 'import type { BrickInfo } from \'./index\';\nexport const info: BrickInfo = { brickId: \'001653f00a0a\', name: \'AAA\', addedLater: 1 };';
		assert.ok(typeCheck(exact).some((e) => e.includes('addedLater')));
	});

	it('reads a hello value this version does not know as the least privileged one', () => {
		assert.equal(readClientKind('python'), 'mcp');
		assert.equal(readBuildKind('nightly'), 'release');
		assert.equal(readDaemonMode('record'), 'hardware');
		assert.equal(readDaemonState('draining'), 'serving');
		for (const kind of ['vscode', 'cli', 'mcp', 'addon']) { assert.equal(readClientKind(kind), kind); }
		assert.equal(readBuildKind('development'), 'development');
		assert.equal(readDaemonMode('replay'), 'replay');
		assert.equal(readDaemonState('exiting'), 'exiting');
		const hello = messages.hello as Record<string, { params: Json }>;
		const unknownKind = JSON.stringify({ ...hello['hello/start'].params, clientKind: 'python', buildKind: 'nightly' });
		assert.deepEqual(typeCheck(`import type { HelloStart } from './index';\nexport const start: HelloStart = ${unknownKind};`), []);
	});

	it('carries the table: version, flags, families and the settings spec', () => {
		assert.equal(CONTRACT_VERSION, table.contractVersion);
		assert.equal(METHODS['daemon/exit'].stableCore, true);
		assert.ok(!METHODS['daemon/exit'].callableBy.includes('mcp'));
		assert.ok(METHODS['daemon/exit'].callableBy.includes('cli'));
		assert.equal(METHODS['bricks/forget'].needsPerson, true);
		assert.equal(METHODS['files/write'].leased, true);
		assert.equal(ERROR_FAMILY.replay_unmatched, 'daemon');
		assert.equal(ERROR_FAMILY.brick_busy, 'lease');
		const access = SETTING_SPECS.find((s) => s.key === 'accessMode');
		assert.deepEqual([access?.cliKey, access?.dangerous, access?.stored], ['access-mode', true, false]);
		assert.equal(SETTING_SPECS.find((s) => s.key === 'telemetry.throttle.step')?.exclusiveMinimum, 1);
	});
});

describe('cross-language vectors', () => {
	const vectors = readJson(path.join(ROOT, 'contract', 'vectors', 'channel.json')) as {
		hello: { key: string; cases: { clientNonce: string; daemonNonce: string; daemonProof: string; clientProof: string }[] };
		channelRecord: { file: string; path: string; pid: number }[];
	};

	it('the hello proofs are today\'s scheme', () => {
		const key = Buffer.from(vectors.hello.key, 'hex');
		assert.equal(key.length, 32);
		assert.ok(vectors.hello.cases.length > 0);
		for (const c of vectors.hello.cases) {
			assert.equal(daemonProof(key, c.clientNonce, c.daemonNonce), c.daemonProof);
			assert.equal(clientProof(key, c.clientNonce, c.daemonNonce), c.clientProof);
		}
	});

	it('channel.json reads as the vectors say', () => {
		assert.ok(vectors.channelRecord.length >= 3);
		for (const record of vectors.channelRecord) {
			const parsed = JSON.parse(record.file) as ChannelRecord;
			assert.equal(parsed.path, record.path);
			assert.equal(parsed.pid, record.pid);
		}
	});
});

describe('contract generator rules', () => {
	it('refuses a oneOf without a const tag and writes nothing', async () => {
		const paths = tempContract((files) => {
			const rate = definition(files, 'telemetry', 'TelemetryRate') as { oneOf: { properties: Json }[] };
			rate.oneOf[1].properties.kind = { type: 'string' };
		});
		const result = await generator.generate(paths);
		assert.equal(result.ok, false);
		assert.ok(result.problems.some((p) => p.startsWith('TelemetryRate') && p.includes('const tag')), result.problems.join('\n'));
		assert.equal(fs.existsSync(paths.outDir), false);
	});

	it('refuses anyOf, an unknown $ref and an object closed to unknown properties', async () => {
		const paths = tempContract((files) => {
			const info = definition(files, 'bricks', 'BrickInfo') as { properties: Json; additionalProperties?: boolean };
			info.properties.osVersion = { anyOf: [{ type: 'string' }, { type: 'null' }] };
			info.properties.firmwareVersion = { $ref: '#/definitions/NoSuchType' };
			info.additionalProperties = false;
		});
		const { problems } = await generator.generate(paths);
		assert.ok(problems.some((p) => p.includes('anyOf')), problems.join('\n'));
		assert.ok(problems.some((p) => p.includes('NoSuchType')), problems.join('\n'));
		assert.ok(problems.some((p) => p.startsWith('BrickInfo:') && p.includes('open')), problems.join('\n'));
	});

	it('refuses an enum on the stable core and a reader whose fallback is not a value', async () => {
		const paths = tempContract((files) => {
			const start = definition(files, 'core', 'HelloStart') as { properties: Record<string, Json> };
			start.properties.clientKind = { $ref: '#/definitions/ClientKind' };
			start.properties.buildKind = { type: 'string', enum: ['release', 'development'] };
			const accepted = definition(files, 'core', 'HelloAccepted') as { properties: Record<string, Json> };
			accepted.properties.mode['x-unknownReadsAs'] = 'simulated';
		});
		const { problems } = await generator.generate(paths);
		assert.ok(problems.some((p) => p.startsWith('HelloStart.clientKind') && p.includes('not on the stable core')), problems.join('\n'));
		assert.ok(problems.some((p) => p.startsWith('HelloStart.buildKind') && p.includes('no enum')), problems.join('\n'));
		assert.ok(problems.some((p) => p.includes('simulated is not one of its values')), problems.join('\n'));
	});

	it('says the comparison is skipped before the first release', async () => {
		const result = await generator.generate(tempContract());
		assert.equal(result.ok, true, result.problems.join('\n'));
		assert.ok(result.notes?.includes(generator.NO_SNAPSHOT));
	});

	it('flags a stale generated file and a schema change not generated yet', async () => {
		const paths = tempContract();
		assert.equal((await generator.generate(paths)).ok, true);
		assert.equal((await generator.check(paths)).ok, true);
		const methodsFile = path.join(paths.outDir, 'methods.ts');
		fs.appendFileSync(methodsFile, '// edited by hand\n');
		const edited = await generator.check(paths);
		assert.equal(edited.ok, false);
		assert.ok(edited.problems.some((p) => p.includes('methods.ts is stale')), edited.problems.join('\n'));
		assert.equal((await generator.generate(paths)).ok, true);
		editContract(paths.contractDir, (files) => {
			(definition(files, 'bricks', 'BrickInfo').properties as Json).serial = { type: 'string' };
		});
		const changed = await generator.check(paths);
		assert.equal(changed.ok, false);
		assert.ok(changed.problems.some((p) => p.includes('types.ts is stale')), changed.problems.join('\n'));
	});
});

describe('contract version against the released contract', () => {
	/** A temporary contract released as it stands, then changed by `change`. */
	function released(change: Parameters<typeof editContract>[1]): Required<Paths> {
		const paths = tempContract();
		assert.equal(generator.snapshot(paths).ok, true);
		editContract(paths.contractDir, change);
		return paths;
	}
	const raise = (files: { table: Json }): void => { files.table.contractVersion = (files.table.contractVersion as number) + 1; };

	it('keeps the version for an added optional field and an added method', async () => {
		const paths = released((files) => {
			(definition(files, 'bricks', 'BrickInfo').properties as Json).serial = { type: 'string' };
			methodsTable(files)['bricks/blink'] = { ...methodsTable(files)['bricks/info'], doc: 'Blink the brick\'s light.' };
		});
		const result = await generator.generate(paths);
		assert.deepEqual(result.problems, []);
		assert.equal(result.notes?.length, 0);
	});

	for (const [what, change, expected] of [
		['removing a field', (files: { schema: (name: string) => Json; table: Json }) => {
			delete (definition(files, 'bricks', 'BrickInfo').properties as Json).osVersion;
		}, 'bricks/info result.osVersion: field removed or renamed'],
		['renaming a method', (files: { schema: (name: string) => Json; table: Json }) => {
			const entries = methodsTable(files);
			entries['bricks/details'] = entries['bricks/info'];
			delete entries['bricks/info'];
		}, 'methods bricks/info: removed or renamed'],
		['making a field required', (files: { schema: (name: string) => Json; table: Json }) => {
			(definition(files, 'bricks', 'BrickInfo').required as string[]).push('firmwareVersion');
		}, 'bricks/info result.firmwareVersion: field became required'],
	] as const) {
		it(`fails ${what} without a raised version, and passes with it`, async () => {
			const unraised = await generator.generate(released(change));
			assert.equal(unraised.ok, false);
			assert.ok(unraised.problems.some((p) => p.includes('need contractVersion above')), unraised.problems.join('\n'));
			assert.ok(unraised.problems.some((p) => p.includes(expected)), unraised.problems.join('\n'));

			const paths = released((files) => { change(files); raise(files); });
			const raised = await generator.generate(paths);
			assert.deepEqual(raised.problems, []);
			const version = (table.contractVersion as number) + 1;
			assert.match(fs.readFileSync(path.join(paths.outDir, 'methods.ts'), 'utf8'), new RegExp(`export const CONTRACT_VERSION = ${version};`));
		});
	}

	it('counts a new enum value as breaking where the daemon reads it, and as additive in a result', async () => {
		const inParams = await generator.generate(released((files) => {
			const notice = definition(files, 'messages', 'LogNoticeParams') as { properties: { level: { enum: string[] } } };
			notice.properties.level.enum.push('debug');
		}));
		assert.ok(inParams.problems.some((p) => p.includes('log/notice params.level: value "debug" added')), inParams.problems.join('\n'));

		const inResult = await generator.generate(released((files) => {
			(definition(files, 'files', 'StartOutcome').enum as string[]).push('queued');
		}));
		assert.deepEqual(inResult.problems, []);
	});

	it('adds a client kind without a raised version, since the hello carries the kind as a string', async () => {
		const result = await generator.generate(released((files) => {
			(definition(files, 'daemon', 'ClientKind').enum as string[]).push('python');
		}));
		assert.deepEqual(result.problems, []);
	});

	it('never lets the stable core break, even with a raised version', async () => {
		const removed = await generator.generate(released((files) => {
			const accepted = definition(files, 'core', 'HelloAccepted') as { properties: Json; required: string[] };
			delete accepted.properties.instanceId;
			accepted.required = accepted.required.filter((name) => name !== 'instanceId');
			raise(files);
		}));
		assert.equal(removed.ok, false);
		assert.ok(removed.problems.some((p) => p.startsWith('stable core:') && p.includes('instanceId')), removed.problems.join('\n'));

		const optional = await generator.generate(released((files) => {
			(definition(files, 'core', 'HelloStart').properties as Json).locale = { type: 'string' };
		}));
		assert.deepEqual(optional.problems, []);
	});
});
