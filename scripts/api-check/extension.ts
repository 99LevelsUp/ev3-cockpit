/**
 * An add-on of the cockpit, for a hardware session. It is a client of the cockpit daemon, as EVƎ C
 * is: it connects through the client library with `kind: 'addon'` and works only through the
 * contract's methods, never through the cockpit extension. It connects a brick, puts files on it
 * and reads them back, deploys and runs a program, stops it, asks for an emergency stop while a
 * motor turns, tries the shell in safe mode (refused) and in full mode, and disconnects and
 * connects again.
 *
 * Every step is written to the output channel and to `~/ev3-api-check.txt`, so the session can be
 * read afterwards from the file alone. The person at the brick picks the brick and the program,
 * says what the motor did, and switches full mode in VS Code (EVƎ: Settings) when asked: an add-on
 * cannot switch it, and the check shows that too. Everything else runs by itself.
 *
 * The client library comes from this repository's compiled tree (`out/client`, with its
 * `node_modules`), so build first (`npm run compile`, which also bundles this file into
 * `extension.js` beside it, the file VS Code loads) and start VS Code with the check as a
 * development extension beside the installed cockpit:
 *
 *     code --extensionDevelopmentPath=<repo>/scripts/api-check
 *
 * Installed some other way, set `EV3_COCKPIT_REPO` to the repository folder before VS Code starts.
 * When no daemon runs, the client library starts the one the installed cockpit recorded; without
 * an installed cockpit the check says to install it. Not shipped: packaging.mts allow-lists the
 * cockpit's own files.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CockpitClient, ContractBrick } from '../../src/client/index.ts';

/** The client library, as `out/client` holds it compiled. */
type Library = typeof import('../../src/client/index.ts');

const PROJECTS = '/home/root/lms2012/prjs';
const CHECK_DIR = `${PROJECTS}/cockpit-api-check`;
const SHELL_FILE = '/tmp/cockpit-api-check.txt';
const LOG_FILE = path.join(os.homedir(), 'ev3-api-check.txt');
const LOCAL_DIR = path.join(os.tmpdir(), 'ev3-api-check');
const REPO = process.env.EV3_COCKPIT_REPO || path.resolve(__dirname, '..', '..');
const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string }).version;
/** What other clients read in `brick_busy` and `endedBy`. */
const CLIENT_NAME = 'EVƎ Cockpit API check (VS Code)';

/** An error as the client library raises it: a contract code, its kind and data. */
type Failure = Error & { code?: string; kind?: string; data?: { holder?: string } };

let out: vscode.OutputChannel;
let lib: Library | undefined;
const results: { name: string; ok: boolean }[] = [];

function line(text: string): void {
	const stamped = `${new Date().toISOString().slice(11, 23)} ${text}`;
	out.appendLine(stamped);
	fs.appendFileSync(LOG_FILE, `${stamped}\n`);
}

/** The client library from the repository's compiled tree, loaded on first use. */
function library(): Library {
	if (lib) { return lib; }
	try {
		lib = require(path.join(REPO, 'out', 'client', 'index.js')) as Library;
		return lib;
	} catch (error) {
		throw new Error(`the client library is not in ${path.join(REPO, 'out', 'client')} (${(error as Error).message}). `
			+ 'Run npm run compile in the repository, and start VS Code with --extensionDevelopmentPath=<repo>/scripts/api-check '
			+ 'or with EV3_COCKPIT_REPO set to the repository.');
	}
}

const describe = (error: unknown): string => {
	const failure = error as Failure | undefined;
	const code = failure?.code ? `[${failure.code}${failure.kind && failure.kind !== 'Unknown' ? ` ${failure.kind}` : ''}] ` : '';
	const holder = failure?.data?.holder ? ` (held by ${failure.data.holder})` : '';
	return `${code}${failure?.message ?? String(error)}${holder}`;
};

/** One step: its outcome is a row, a throw is a failed row, never a dead run. */
async function step(name: string, fn: () => Promise<string | undefined | void> | string): Promise<boolean> {
	const started = Date.now();
	try {
		const detail = await fn();
		results.push({ name, ok: true });
		line(`ok    ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started} ms)`);
		return true;
	} catch (error) {
		results.push({ name, ok: false });
		line(`FAIL  ${name} — ${describe(error)} (${Date.now() - started} ms)`);
		// A write the daemon may or may not have done is never tried again.
		if ((error as Failure | undefined)?.code === library().WireErrorCode.OutcomeUnknown) { line('      whether it happened is not known; not retried'); }
		return false;
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) { throw new Error(message); }
}

/** The call must fail with this contract code; a success or another error fails the step. */
async function refused(code: string, fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (error) {
		assert(error instanceof library().ContractError && error.code === code, `refused with ${describe(error)}, expected [${code}]`);
		return `refused [${code}]`;
	}
	throw new Error(`not refused, expected [${code}]`);
}

const route = (brick: ContractBrick | undefined): string => (brick ? brick.channels.map((c) => `${c.transport}:${c.state}`).join(' ') : 'not listed');
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, test: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (test()) { return; }
		await wait(250);
	}
	throw new Error(`${what} did not happen within ${ms / 1000} s`);
}

async function ask(question: string, ...answers: string[]): Promise<string | undefined> {
	const answer = await vscode.window.showInformationMessage(question, { modal: true }, ...answers);
	line(`ask   ${question} → ${answer ?? '(dismissed)'}`);
	return answer;
}

function localFile(name: string, content?: Buffer): string {
	fs.mkdirSync(LOCAL_DIR, { recursive: true });
	const file = path.join(LOCAL_DIR, name);
	if (content) { fs.writeFileSync(file, content); }
	return file;
}

/**
 * A client of the daemon for one command. Questions for a person (releasing a transfer slot left
 * open, for one) are shown as a modal dialog; a dismissed one leaves things as they are.
 */
async function openClient(purpose: string): Promise<CockpitClient> {
	const { CockpitClient, ContractError, WireErrorCode, installedNativeLaunch, nativeChannelFiles, nativeStateRoot } = library();
	// An add-on carries no daemon: the library starts the one the installed cockpit recorded.
	const launch = installedNativeLaunch(nativeChannelFiles(nativeStateRoot()));
	let client: CockpitClient;
	try {
		client = await CockpitClient.connect({ name: CLIENT_NAME, kind: 'addon', version: VERSION });
	} catch (error) {
		if (error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable && !launch) {
			throw new Error('no cockpit daemon runs, and no installed EVƎ Cockpit was found to start one: install EVƎ Cockpit and run the check again');
		}
		throw error;
	}
	const daemon = client.daemon;
	line(`      ${purpose}: daemon ${daemon.version}, contract ${daemon.contractVersion}, pid ${daemon.pid}, transports ${(daemon.transports ?? []).join(' ')}`);
	client.onNotice((notice) => line(`note  ${notice}`));
	client.onReconnected(() => line('note  connected again to a daemon; subscriptions renewed'));
	client.onLost((error) => line(`note  the daemon went and could not be reached again — ${describe(error)}`));
	client.onQuestion(async (question) => {
		const detail = question.details?.length ? `\n\n${question.details.join('\n')}` : '';
		const answer = await vscode.window.showWarningMessage(`${question.text}${detail}`, { modal: true }, 'Yes', 'No');
		const given = answer === 'Yes' ? 'yes' : answer === 'No' ? 'no' : 'keep';
		line(`ask   (${question.kind}) ${question.text} → ${given}`);
		return given;
	});
	return client;
}

async function pickBrick(client: CockpitClient): Promise<ContractBrick | undefined> {
	await client.request('bricks/list', { waitForDiscovery: true });
	const picked = await vscode.window.showQuickPick(
		client.bricks().map((b) => ({ label: b.name, description: `${b.connected ? 'connected' : 'not connected'} — ${route(b)}`, brick: b })),
		{ title: 'API check: which brick?' });
	return picked?.brick;
}

/** Connects the brick for this client and makes it this client's active one. */
async function connectBrick(client: CockpitClient, brickId: string): Promise<ContractBrick> {
	const brick = await client.request('bricks/connect', { brick: brickId });
	await client.setActiveBrick(brick.brickId);
	return brick;
}

const heldByMe = (client: CockpitClient, brickId: string): boolean => client.brick(brickId)?.holders.some((h) => h.kind === 'client' && h.client === CLIENT_NAME) === true;

/**
 * The programs in the projects folder and one level of project folders below it: .rbf from the PC tools
 * and MakeCode, .rpf from the brick's own Brick Program app (BrkProg_SAVE). The firmware runs
 * both the same way (ui.lms, RunBytecodefile).
 */
async function findPrograms(client: CockpitClient, brickId: string): Promise<string[]> {
	const programs: string[] = [];
	const isProgram = (file: { kind: string; name: string }): boolean => file.kind === 'file' && /\.r[bp]f$/i.test(file.name);
	for (const entry of (await client.request('files/list', { brick: brickId, path: PROJECTS })).entries) {
		if (isProgram(entry)) { programs.push(`${PROJECTS}/${entry.name}`); continue; }
		if (entry.kind !== 'directory' || entry.name.startsWith('.')) { continue; }
		const folder = `${PROJECTS}/${entry.name}`;
		for (const file of await client.request('files/list', { brick: brickId, path: folder }).then((listing) => listing.entries, () => [])) {
			if (isProgram(file)) { programs.push(`${folder}/${file.name}`); }
		}
	}
	return programs;
}

async function checkFiles(client: CockpitClient, brickId: string): Promise<void> {
	const { WireErrorCode } = library();
	await step('files: a folder in the projects area', async () => {
		await client.request('files/makeDirectory', { brick: brickId, path: CHECK_DIR });
		return CHECK_DIR;
	});
	// Up to 4 KiB goes inline both ways; larger files go through local paths the daemon reads and
	// writes itself.
	for (const bytes of [1, 1000, 100_000]) {
		await step(`files: ${bytes} B written and read back`, async () => {
			const content = Buffer.from(new Uint8Array(bytes).map((_, i) => (i * 7 + bytes) & 0xff));
			const file = `${CHECK_DIR}/t${bytes}.bin`;
			const inline = bytes <= 4096;
			const started = Date.now();
			await client.request('files/write', inline
				? { brick: brickId, path: file, content: content.toString('base64') }
				: { brick: brickId, path: file, fromLocalPath: localFile(`t${bytes}.bin`, content) });
			const wrote = Date.now() - started;
			let back: Buffer;
			if (inline) {
				back = Buffer.from((await client.request('files/read', { brick: brickId, path: file, inline: true })).content ?? '', 'base64');
			} else {
				const target = localFile(`t${bytes}.back.bin`);
				await client.request('files/read', { brick: brickId, path: file, toLocalPath: target });
				back = fs.readFileSync(target);
			}
			assert(back.length === bytes, `read back ${back.length} B`);
			const first = back.findIndex((b, i) => b !== content[i]);
			assert(first < 0, `byte ${first} differs`);
			return `${inline ? 'inline' : 'local path'}, write ${wrote} ms, read ${Date.now() - started - wrote} ms, ${route(client.brick(brickId))}`;
		});
	}
	await step('files: the listing shows the three files with their sizes', async () => {
		const { entries } = await client.request('files/list', { brick: brickId, path: CHECK_DIR });
		const sizes = Object.fromEntries(entries.filter((e) => e.kind === 'file').map((e) => [e.name, e.bytes]));
		for (const bytes of [1, 1000, 100_000]) { assert(sizes[`t${bytes}.bin`] === bytes, `t${bytes}.bin listed as ${sizes[`t${bytes}.bin`]}`); }
		return JSON.stringify(sizes);
	});
	await step('files: safe mode refuses a write outside the user areas',
		() => (client.accessMode() === 'safe'
			? refused(WireErrorCode.AccessDenied, () => client.request('files/write',
				{ brick: brickId, path: '/home/root/lms2012/sys/cockpit-api-check.bin', content: Buffer.from([1]).toString('base64') }))
			: 'skipped: not in safe mode'));
	await step('files: the folder removed with its contents', async () => {
		const report = await client.request('files/remove', { brick: brickId, path: CHECK_DIR, recursive: true });
		assert(report.leftBehind.length === 0, `left behind: ${report.leftBehind.join(', ')}`);
		assert(!(await client.request('files/exists', { brick: brickId, path: CHECK_DIR })).exists, 'still there');
		return 'gone';
	});
}

async function checkPrograms(client: CockpitClient, brickId: string): Promise<void> {
	const { WireErrorCode } = library();
	const programs = await findPrograms(client, brickId).catch((error: unknown) => { line(`FAIL  listing programs — ${describe(error)}`); return []; });
	const program = await vscode.window.showQuickPick(programs, {
		title: 'API check: a program that turns a motor for a while (for the emergency stop)',
	});
	if (!program) { line('skip  programs: no program picked'); return; }
	line(`      program ${program}`);
	const following = await client.subscribePrograms(brickId, (state) =>
		line(`      program state: running ${state.running}, runSeq ${state.runSeq}${state.endedBy ? `, ended by ${state.endedBy}` : ''}`));
	try {
		let runSeq = following.state.runSeq;
		// The program goes up again from its own copy: the brick holds the same bytes, so it is skipped.
		const copy = localFile(path.posix.basename(program));
		await step('programs: deploy and run (the same file is skipped)', async () => {
			await client.request('files/read', { brick: brickId, path: program, toLocalPath: copy });
			const result = await client.request('programs/deployAndRun', {
				brick: brickId, runPath: program, files: [{ remotePath: program, localPath: copy, skipIfSameMd5: true }],
			});
			assert(result.outcome === 'started', `outcome ${result.outcome}`);
			assert(result.skipped.includes(program), `uploaded ${JSON.stringify(result.uploaded)}, skipped ${JSON.stringify(result.skipped)}`);
			assert(result.runSeq > runSeq, `runSeq ${result.runSeq} after ${runSeq}`);
			runSeq = result.runSeq;
			return `started, runSeq ${result.runSeq}, skipped ${result.skipped.length}`;
		});
		await step('programs: a second deployment is refused while it runs',
			() => refused(WireErrorCode.ProgramRunning, () => client.request('programs/deployAndRun', { brick: brickId, runPath: program, files: [] })));
		await step('programs: run with replace', async () => {
			const result = await client.request('programs/run', { brick: brickId, path: program, replace: true });
			assert(result.outcome === 'started', `outcome ${result.outcome}`);
			return `started, runSeq ${result.runSeq}`;
		});
		await step('programs: stop', async () => {
			const state = await client.request('programs/stop', { brick: brickId });
			assert(!state.running, 'still running');
			assert(state.endedBy === CLIENT_NAME, `ended by ${state.endedBy ?? '(not said)'}`);
			return `ended by ${state.endedBy}`;
		});
		await step('programs: deploy and run again for the emergency stop', async () => {
			const result = await client.request('programs/deployAndRun', { brick: brickId, runPath: program, files: [] });
			assert(result.outcome === 'started', `outcome ${result.outcome}`);
			return `started, runSeq ${result.runSeq}`;
		});
		await ask('Does a motor turn now? Press "Emergency stop" to stop it.', 'Emergency stop');
		await step('programs: emergency stop', async () => {
			const state = await client.request('programs/emergencyStop', { brick: brickId });
			assert(!state.running, 'still running');
			return `not running, ended by ${state.endedBy ?? '(not said)'}`;
		});
		const stopped = await ask('Did the motor stop, and does the brick show its menu again?', 'Yes', 'No');
		results.push({ name: 'programs: the motor stopped (person at the brick)', ok: stopped === 'Yes' });
	} finally {
		following.dispose();
	}
}

async function checkShell(client: CockpitClient, brickId: string): Promise<void> {
	const { WireErrorCode } = library();
	const before = client.accessMode();
	if (before === 'safe') {
		await step('shell: refused in safe mode', () => refused(WireErrorCode.AccessDenied, () => client.request('shell/run', { brick: brickId, command: 'true' })));
		await step('settings: an add-on cannot switch full mode', () =>
			refused(WireErrorCode.NeedsPerson, () => client.request('settings/set', { key: 'accessMode', value: 'full' })));
		const go = await ask('For the shell check, switch the access mode to "full" in VS Code (EVƎ: Settings), then press Continue. '
			+ 'The check sets it back to safe afterwards.', 'Continue', 'Skip');
		if (go !== 'Continue') { line('skip  shell in full mode'); return; }
	}
	try {
		await step('shell: full mode reaches this client', async () => {
			await until('full mode', () => client.accessMode() === 'full', 60_000);
			return 'full';
		});
		if (client.accessMode() !== 'full') { return; }
		await step('shell: echo in full mode, the file read back', async () => {
			const result = await client.request('shell/run', { brick: brickId, command: `echo cockpit > ${SHELL_FILE}` });
			assert(result.status === 0, `status ${result.status}`);
			const read = await client.request('files/read', { brick: brickId, path: SHELL_FILE, inline: true });
			const text = Buffer.from(read.content ?? '', 'base64').toString('utf8');
			assert(text === 'cockpit\n', `read ${JSON.stringify(text)}`);
			await client.request('shell/run', { brick: brickId, command: `rm ${SHELL_FILE}` });
			return 'status 0, "cockpit" read back';
		});
	} finally {
		// Back to safe is not dangerous, so an add-on may do it.
		if (before === 'safe' && client.accessMode() !== 'safe') {
			await client.request('settings/set', { key: 'accessMode', value: 'safe' })
				.then(() => line('      access mode set back to safe'))
				.catch((error: unknown) => line(`FAIL  setting the access mode back to safe — ${describe(error)}; switch it in EVƎ: Settings`));
		}
	}
}

async function checkConnection(client: CockpitClient, brickId: string): Promise<void> {
	await step('connection: disconnect', async () => {
		const result = await client.request('bricks/disconnect', { brick: brickId });
		await until('this client to let go', () => !heldByMe(client, brickId), 10_000);
		return result.stillHeldBy.length > 0 ? `let go; still held by ${result.stillHeldBy.join(', ')}` : 'let go; nobody holds it';
	});
	await step('connection: connect again', async () => {
		await connectBrick(client, brickId);
		await until('this client to hold it', () => heldByMe(client, brickId));
		return route(client.brick(brickId));
	});
}

async function run(): Promise<void> {
	results.length = 0;
	out.show(true);
	line(`===== API check, ${new Date().toString()}`);
	const client = await openClient('API check');
	try {
		const brick = await pickBrick(client);
		if (!brick) { line('skip  no brick picked'); return; }
		const brickId = brick.brickId;
		line(`      brick ${brick.name} [${brickId}], ${route(brick)}, access mode ${client.accessMode()}`);
		const connected = await step('connection: connect through the daemon', async () => {
			await connectBrick(client, brickId);
			const info = await client.request('bricks/info', { brick: brickId });
			return `${info.name}, firmware ${info.firmwareVersion ?? '?'}, ${route(client.brick(brickId))}`;
		});
		if (!connected) { return; }
		await checkFiles(client, brickId);
		await checkPrograms(client, brickId);
		await checkShell(client, brickId);
		await checkConnection(client, brickId);
	} finally {
		client.dispose();
		const failed = results.filter((r) => !r.ok);
		line(`===== ${results.length - failed.length} ok, ${failed.length} failed${failed.length ? `: ${failed.map((r) => r.name).join('; ')}` : ''}`);
	}
}

/**
 * Watches the daisy chain of the brick picked, through the contract (step-8 plan, U7): every chain
 * change, and the member ports each time they change. Runs until the command is given again, so
 * the bricks can be rewired in between.
 */
let chainWatch: vscode.Disposable | undefined;

async function watchChain(): Promise<void> {
	if (chainWatch) { chainWatch.dispose(); chainWatch = undefined; line('===== chain watch stopped'); return; }
	out.show(true);
	const client = await openClient('chain watch');
	const disposables: { dispose(): void }[] = [client];
	chainWatch = { dispose: () => { for (const d of disposables.reverse()) { d.dispose(); } } };
	try {
		await startChainWatch(client, disposables);
	} catch (error) {
		chainWatch?.dispose();
		chainWatch = undefined;
		throw error;
	}
}

async function startChainWatch(client: CockpitClient, disposables: { dispose(): void }[]): Promise<void> {
	const brick = await pickBrick(client);
	if (!brick) { throw new Error('no brick picked'); }
	await connectBrick(client, brick.brickId);
	line(`===== chain watch on ${brick.name}, ${route(client.brick(brick.brickId))}`);

	// The chain as it is now comes first, then each change.
	disposables.push(await client.followChain(brick.brickId, (chain) => {
		const members = chain.members.map((m) => `${m.layer}${m.capabilities.motorTypes ? '' : ' (motor types not vouched for)'}`);
		line(`chain read=${chain.read} stale=${chain.stale} members=[${members.join(', ')}]`);
	}));

	// Every member port row: type, raw code and mode from occupancy, value for sensors. A member's
	// motor has no position row, so none can show.
	const rows = (await client.request('telemetry/rows', {})).rows.filter((r) => r.id.startsWith('chain.')).map((r) => r.id);
	line(`      ${rows.length} chain rows; motor position rows among them: ${rows.filter((id) => /\.motor\..*\.(?!occupancy$)/.test(id)).length}`);
	const values = new Map<string, { rowId: string; value: unknown; mode?: number; stale?: boolean }>();
	let lastTable = '';
	disposables.push(await client.subscribeTelemetry(brick.brickId, { rows, intervalMs: 500 }, (update) => {
		if (update.kind === 'snapshot') { values.clear(); }
		for (const v of update.values) { values.set(v.rowId, v); }
		for (const id of update.removed) { values.delete(id); }
		if (update.kind === 'ended') { line('      telemetry ended: the brick went'); }
		const table = [...values.values()]
			.filter((v) => v.rowId !== 'chain.depth' && v.value !== null && !(v.rowId.endsWith('.occupancy') && v.value === 126))
			.map((v) => `${v.rowId}=${typeof v.value === 'number' ? Math.round(v.value * 10) / 10 : String(v.value)}${v.mode !== undefined ? `/m${v.mode}` : ''}${v.stale ? ' (stale)' : ''}`)
			.sort()
			.join('  ');
		if (table !== lastTable) { lastTable = table; line(`ports ${table || '(none)'}`); }
	}));
}

/**
 * Failure scenarios for a hardware session (IMPLEMENTATION_PLAN 2.8.12): the person cuts a link
 * while the daemon is busy, and the check records what the add-on saw. Two of them:
 *
 *  - an upload cut mid-way (4.6.17): the brick's free space before, the failure the write ended
 *    with, and the free space after the brick is back, which the cockpit should have released
 *    without a reboot — after asking the person, which this check shows as a dialog;
 *  - commands in flight when the link drops (2.8.14): several callers keep asking the brick, and
 *    each failure is listed with how long it took, so a command refused at once (never sent) shows
 *    apart from one that waited out a timeout.
 */
async function failures(): Promise<void> {
	out.show(true);
	const client = await openClient('failure scenarios');
	try {
		const brick = await pickBrick(client);
		if (!brick) { line('skip  no brick picked'); return; }
		const scenario = await vscode.window.showQuickPick([
			{ label: 'An upload cut mid-way (4.6.17)', run: interruptedUpload },
			{ label: 'Commands in flight when the link drops (2.8.14)', run: commandsInFlight },
		], { title: 'API check: which failure scenario?' });
		if (!scenario) { line('skip  no scenario picked'); return; }
		await connectBrick(client, brick.brickId);
		line(`===== ${scenario.label} on ${brick.name}, ${route(client.brick(brick.brickId))}, daemon ${client.daemon.version}`);
		await scenario.run(client, brick.brickId);
	} finally {
		client.dispose();
	}
}

const connectedOn = (client: CockpitClient, brickId: string): boolean => client.brick(brickId)?.channels.some((c) => c.state === 'connected') === true;

async function interruptedUpload(client: CockpitClient, brickId: string): Promise<void> {
	// The daemon reports no progress for a write, so the cue to cut the link comes after a time
	// that puts it roughly a quarter through on the link the size is meant for.
	const size = await vscode.window.showQuickPick([
		{ label: '3 MB', bytes: 3_000_000, cueMs: 1500, description: 'USB: several seconds' },
		{ label: '1 MB', bytes: 1_000_000, cueMs: 15_000, description: 'Bluetooth or Wi-Fi: a minute or more' },
		{ label: '300 kB', bytes: 300_000, cueMs: 7000, description: 'Bluetooth: half a minute' },
	], { title: 'API check: how big an upload?' });
	if (!size) { line('skip  no size picked'); return; }
	const file = `${CHECK_DIR}/cut.bin`;
	await client.request('files/makeDirectory', { brick: brickId, path: CHECK_DIR }).catch(() => { /* there already */ });
	const before = await client.request('bricks/storage', { brick: brickId });
	line(`      free before: ${before.freeKb} KB of ${before.totalKb} KB`);
	await ask(`An upload of ${size.label} starts when you press Start. Cut the link while it runs, `
		+ `when the output says so (after ${size.cueMs / 1000} s).`, 'Start');

	const local = localFile('cut.bin', Buffer.from(new Uint8Array(size.bytes).map((_, i) => (i * 13) & 0xff)));
	const started = Date.now();
	const cue = setTimeout(() => {
		line('>>>>  CUT THE LINK NOW');
		void vscode.window.showWarningMessage('API check: cut the link now.');
	}, size.cueMs);
	try {
		await client.request('files/write', { brick: brickId, path: file, fromLocalPath: local });
		line(`note  the upload finished before the link went (${Date.now() - started} ms); nothing to release`);
	} catch (error) {
		line(`ok    the upload failed — ${describe(error)} (${Date.now() - started} ms)`);
	} finally {
		clearTimeout(cue);
	}

	line('      waiting for the brick to be connected again (restore the link, or it stays on its other channel)');
	await until('the brick connected again', () => connectedOn(client, brickId), 300_000)
		.then(() => line(`      connected: ${route(client.brick(brickId))}`));
	const leftBefore = await client.request('files/exists', { brick: brickId, path: file }).then((found) => found.exists, () => undefined);
	line(`      the partial file ${leftBefore === undefined ? 'could not be checked' : leftBefore ? 'is there' : 'is not there'} before the next transfer`);
	const freeBetween = await client.request('bricks/storage', { brick: brickId }).catch(() => undefined);
	line(`      free before the next transfer: ${freeBetween?.freeKb ?? '?'} KB`);
	// The cockpit pays what an interrupted transfer owes when the next transfer begins (4.6.17,
	// TransferLedger), not on the reconnect itself: a one-byte upload is that next transfer. It may
	// ask the person first; the dialog comes from this client's question handler.
	await client.request('files/write', { brick: brickId, path: `${CHECK_DIR}/next.bin`, content: Buffer.from([1]).toString('base64') })
		.then(() => line('      next transfer: a one-byte upload went through'))
		.catch((error: unknown) => line(`      next transfer: ${describe(error)}`));
	const deadline = Date.now() + 90_000;
	let after;
	while (Date.now() < deadline) {
		after = await client.request('bricks/storage', { brick: brickId }).catch((error: unknown) => { line(`      storage: ${describe(error)}`); return undefined; });
		if (after) { line(`      free now: ${after.freeKb} KB`); }
		if (after && after.freeKb >= before.freeKb - 4) { break; }
		await wait(5000);
	}
	const released = after !== undefined && after.freeKb >= before.freeKb - 4;
	results.push({ name: 'upload cut: space released without a reboot', ok: released });
	line(`${released ? 'ok   ' : 'FAIL '} upload cut: free ${before.freeKb} KB before, ${after?.freeKb ?? '?'} KB after`);
	const left = await client.request('files/exists', { brick: brickId, path: file }).then((found) => found.exists, () => undefined);
	line(`      the partial file ${left === undefined ? 'could not be checked' : left ? 'is still there' : 'is gone'}`);
	await client.request('files/remove', { brick: brickId, path: CHECK_DIR, recursive: true }).catch((error: unknown) => line(`      cleanup: ${describe(error)}`));
}

async function commandsInFlight(client: CockpitClient, brickId: string): Promise<void> {
	const CALLERS = 6;
	const SECONDS = 60;
	const go = await ask(`${CALLERS} callers keep asking the brick for ${SECONDS} s. Cut the link a few seconds after Start, `
		+ 'and restore it if you want to see it come back.', 'Start');
	if (go !== 'Start') { line('skip  commands in flight'); return; }
	const end = Date.now() + SECONDS * 1000;
	const answered: number[] = [];
	const failed: { ms: number; what: string }[] = [];
	const caller = async (n: number): Promise<void> => {
		while (Date.now() < end) {
			const t = Date.now();
			try {
				await client.request('bricks/storage', { brick: brickId });
				answered.push(Date.now() - t);
			} catch (error) {
				const ms = Date.now() - t;
				failed.push({ ms, what: describe(error) });
				line(`      caller ${n}: ${ms} ms — ${describe(error)}`);
				await wait(1000);   // a link that stays down would otherwise be asked as fast as it refuses
			}
		}
	};
	await Promise.all(Array.from({ length: CALLERS }, (_, n) => caller(n + 1)));
	const kinds = new Map<string, { count: number; min: number; max: number }>();
	for (const f of failed) {
		const k = kinds.get(f.what) ?? { count: 0, min: Infinity, max: 0 };
		k.count += 1; k.min = Math.min(k.min, f.ms); k.max = Math.max(k.max, f.ms);
		kinds.set(f.what, k);
	}
	line(`      answered ${answered.length}, median ${answered.sort((a, b) => a - b)[Math.floor(answered.length / 2)] ?? '?'} ms`);
	for (const [what, k] of kinds) { line(`      failed ${k.count}× in ${k.min}–${k.max} ms — ${what}`); }
	line(`===== commands in flight: ${answered.length} answered, ${failed.length} failed`);
}

export function activate(context: vscode.ExtensionContext): void {
	out = vscode.window.createOutputChannel('EVƎ Cockpit API check');
	context.subscriptions.push(out, vscode.commands.registerCommand('ev3-cockpit-api-check.run', () =>
		run().catch((error: unknown) => line(`FAIL  the check itself — ${describe(error)}`))));
	context.subscriptions.push(vscode.commands.registerCommand('ev3-cockpit-api-check.watchChain', () =>
		watchChain().catch((error: unknown) => line(`FAIL  the chain watch — ${describe(error)}`))));
	context.subscriptions.push(vscode.commands.registerCommand('ev3-cockpit-api-check.failures', () =>
		failures().catch((error: unknown) => line(`FAIL  the failure scenario — ${describe(error)}`))));
	context.subscriptions.push({ dispose: () => chainWatch?.dispose() });
}
