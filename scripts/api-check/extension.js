/**
 * A consumer of the cockpit's public API, for a hardware session (step-5 plan, U9). It does what a
 * sibling extension would: registers, connects a brick, puts files on it and reads them back, runs
 * and stops a program, asks for an emergency stop while a motor turns, tries the shell in safe and
 * in full mode, and disconnects and connects again.
 *
 * Every step is written to the output channel and to `~/ev3-api-check.txt`, so the session can be
 * read afterwards from the file alone. The person at the brick picks the brick and the program and
 * says what the motor did; everything else runs by itself.
 *
 * Not shipped: packaging.cjs allow-lists the cockpit's own files. Install it beside the cockpit
 * with `npx @vscode/vsce package` in this folder and "Install from VSIX".
 */
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = '/home/root/lms2012/prjs';
const CHECK_DIR = `${PROJECTS}/cockpit-api-check`;
const SHELL_FILE = '/tmp/cockpit-api-check.txt';
const LOG_FILE = path.join(os.homedir(), 'ev3-api-check.txt');

let out;
const results = [];

function line(text) {
	const stamped = `${new Date().toISOString().slice(11, 23)} ${text}`;
	out.appendLine(stamped);
	fs.appendFileSync(LOG_FILE, `${stamped}\n`);
}

/** One step: its outcome is a row, a throw is a failed row, never a dead run. */
async function step(name, fn) {
	const started = Date.now();
	try {
		const detail = await fn();
		results.push({ name, ok: true });
		line(`ok    ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started} ms)`);
		return true;
	} catch (error) {
		results.push({ name, ok: false });
		line(`FAIL  ${name} — ${describe(error)} (${Date.now() - started} ms)`);
		return false;
	}
}

const describe = (error) => `${error?.code ? `[${error.code}] ` : ''}${error?.message ?? String(error)}`;

function assert(condition, message) {
	if (!condition) { throw new Error(message); }
}

/** The call must fail with this code; a success or another error fails the step. */
async function refused(code, fn) {
	try {
		await fn();
	} catch (error) {
		assert(error?.code === code, `refused with ${describe(error)}, expected [${code}]`);
		return `refused [${code}]`;
	}
	throw new Error(`not refused, expected [${code}]`);
}

const route = (brick) => brick.channels.map((c) => `${c.transport}:${c.state}`).join(' ');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, test, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (test()) { return; }
		await wait(250);
	}
	throw new Error(`${what} did not happen within ${ms / 1000} s`);
}

async function ask(question, ...answers) {
	const answer = await vscode.window.showInformationMessage(question, { modal: true }, ...answers);
	line(`ask   ${question} → ${answer ?? '(dismissed)'}`);
	return answer;
}

async function pickBrick(consumer) {
	const bricks = consumer.listBricks();
	const picked = await vscode.window.showQuickPick(
		bricks.map((b) => ({ label: b.name, description: `${b.signedIn ? 'connected' : 'not connected'} — ${route(b)}`, brick: b })),
		{ title: 'API check: which brick?' });
	return picked?.brick;
}

/**
 * The programs in the projects folder and one level of project folders below it: .rbf from the PC tools
 * and MakeCode, .rpf from the brick's own Brick Program app (BrkProg_SAVE). The firmware runs
 * both the same way (ui.lms, RunBytecodefile).
 */
async function findPrograms(consumer, brickId) {
	const programs = [];
	const isProgram = (file) => file.kind === 'file' && /\.r[bp]f$/i.test(file.name);
	for (const entry of await consumer.list(brickId, PROJECTS)) {
		if (isProgram(entry)) { programs.push(`${PROJECTS}/${entry.name}`); continue; }
		if (entry.kind !== 'directory' || entry.name.startsWith('.')) { continue; }
		const folder = `${PROJECTS}/${entry.name}`;
		for (const file of await consumer.list(brickId, folder).catch(() => [])) {
			if (isProgram(file)) { programs.push(`${folder}/${file.name}`); }
		}
	}
	return programs;
}

async function checkFiles(consumer, brickId) {
	await step('files: a folder in the projects area', async () => {
		await consumer.makeDirectory(brickId, CHECK_DIR);
		return CHECK_DIR;
	});
	for (const bytes of [1, 1000, 100_000]) {
		await step(`files: ${bytes} B written and read back`, async () => {
			const content = new Uint8Array(bytes).map((_, i) => (i * 7 + bytes) & 0xff);
			const file = `${CHECK_DIR}/t${bytes}.bin`;
			const started = Date.now();
			await consumer.writeFile(brickId, file, content);
			const wrote = Date.now() - started;
			const back = await consumer.readFile(brickId, file);
			assert(back.length === bytes, `read back ${back.length} B`);
			const first = back.findIndex((b, i) => b !== content[i]);
			assert(first < 0, `byte ${first} differs`);
			return `write ${wrote} ms, read ${Date.now() - started - wrote} ms, route ${route(consumer.listBricks().find((b) => b.brickId === brickId))}`;
		});
	}
	await step('files: the listing shows the three files with their sizes', async () => {
		const entries = await consumer.list(brickId, CHECK_DIR);
		const sizes = Object.fromEntries(entries.filter((e) => e.kind === 'file').map((e) => [e.name, e.bytes]));
		for (const bytes of [1, 1000, 100_000]) { assert(sizes[`t${bytes}.bin`] === bytes, `t${bytes}.bin listed as ${sizes[`t${bytes}.bin`]}`); }
		return JSON.stringify(sizes);
	});
	await step('files: safe mode refuses a write outside the user areas',
		() => (consumer.getAccessMode() === 'safe'
			? refused('access_denied', () => consumer.writeFile(brickId, '/home/root/lms2012/sys/cockpit-api-check.bin', new Uint8Array([1])))
			: 'skipped: not in safe mode'));
	await step('files: the folder removed with its contents', async () => {
		await consumer.remove(brickId, CHECK_DIR, { recursive: true });
		assert(!(await consumer.exists(brickId, CHECK_DIR)), 'still there');
		return 'gone';
	});
}

async function checkPrograms(consumer, brickId) {
	const programs = await findPrograms(consumer, brickId).catch((error) => { line(`FAIL  listing programs — ${describe(error)}`); return []; });
	const program = await vscode.window.showQuickPick(programs, {
		title: 'API check: a program that turns a motor for a while (for the emergency stop)',
	});
	if (!program) { line('skip  programs: no program picked'); return; }
	line(`      program ${program}`);
	await step('programs: run', async () => {
		const state = await consumer.runProgram(brickId, program);
		assert(state.running, 'the brick does not report it running');
		return 'running';
	});
	await step('programs: a second run is refused while it runs',
		() => refused('program_running', () => consumer.runProgram(brickId, program)));
	await step('programs: run with replace', async () => {
		const state = await consumer.runProgram(brickId, program, { replace: true });
		assert(state.running, 'not running after the replace');
		return 'running';
	});
	await step('programs: stop', async () => {
		const state = await consumer.stopProgram(brickId);
		assert(!state.running, 'still running');
		return 'stopped';
	});
	await step('programs: run again for the emergency stop', async () => {
		const state = await consumer.runProgram(brickId, program);
		assert(state.running, 'not running');
		return 'running';
	});
	await ask('Does a motor turn now? Press "Emergency stop" to stop it.', 'Emergency stop');
	await step('programs: emergency stop', async () => {
		const state = await consumer.emergencyStop(brickId);
		assert(!state.running, 'still running');
		return 'not running';
	});
	const stopped = await ask('Did the motor stop, and does the brick show its menu again?', 'Yes', 'No');
	results.push({ name: 'programs: the motor stopped (person at the brick)', ok: stopped === 'Yes' });
}

async function checkShell(consumer, brickId) {
	const config = vscode.workspace.getConfiguration('ev3-cockpit');
	const before = config.inspect('accessMode')?.globalValue;
	if (consumer.getAccessMode() === 'safe') {
		await step('shell: refused in safe mode', () => refused('access_denied', () => consumer.runShell(brickId, 'true')));
	}
	const go = await ask('Switch ev3-cockpit.accessMode to "full" for the shell check? It is set back afterwards.', 'Switch', 'Skip');
	if (go !== 'Switch') { line('skip  shell in full mode'); return; }
	try {
		await config.update('accessMode', 'full', vscode.ConfigurationTarget.Global);
		await until('full mode', () => consumer.getAccessMode() === 'full', 5000);
		await step('shell: echo in full mode, the file read back', async () => {
			const result = await consumer.runShell(brickId, `echo cockpit > ${SHELL_FILE}`);
			assert(result.status === 0, `status ${result.status}`);
			const text = Buffer.from(await consumer.readFile(brickId, SHELL_FILE)).toString('utf8');
			assert(text === 'cockpit\n', `read ${JSON.stringify(text)}`);
			await consumer.runShell(brickId, `rm ${SHELL_FILE}`);
			return 'status 0, "cockpit" read back';
		});
	} finally {
		await config.update('accessMode', before, vscode.ConfigurationTarget.Global);
		line(`      accessMode set back to ${before ?? '(unset)'}`);
	}
}

async function checkConnection(consumer, brickId) {
	const signedIn = () => consumer.listBricks().find((b) => b.brickId === brickId)?.signedIn === true;
	await step('connection: disconnect', async () => {
		await consumer.disconnect(brickId);
		await until('the sign-out', () => !signedIn(), 10_000);
		return 'signed out';
	});
	await step('connection: connect again', async () => {
		await consumer.connect(brickId);
		await until('the sign-in', signedIn);
		return route(consumer.listBricks().find((b) => b.brickId === brickId));
	});
}

async function run() {
	results.length = 0;
	out.show(true);
	line(`===== API check, ${new Date().toString()}`);
	const cockpit = vscode.extensions.getExtension('99LevelsUp.ev3-cockpit');
	if (!cockpit) { line('FAIL  the cockpit is not installed'); return; }
	const api = await cockpit.activate();
	line(`      cockpit ${cockpit.packageJSON.version}, API ${api.apiVersion}`);
	const consumer = api.registerConsumer('ev3-cockpit-api-check');
	try {
		const brick = await pickBrick(consumer);
		if (!brick) { line('skip  no brick picked'); return; }
		const brickId = brick.brickId;
		line(`      brick ${brick.name}, ${route(brick)}, access mode ${consumer.getAccessMode()}`);
		await step('connection: connect through the API', async () => {
			if (!brick.signedIn) { await consumer.connect(brickId); }
			consumer.setActiveBrick(brickId);
			const info = await consumer.getBrickInfo(brickId);
			return `${info.name}, firmware ${info.firmwareVersion ?? '?'}, ${route(consumer.listBricks().find((b) => b.brickId === brickId))}`;
		});
		await checkFiles(consumer, brickId);
		await checkPrograms(consumer, brickId);
		await checkShell(consumer, brickId);
		await checkConnection(consumer, brickId);
	} finally {
		consumer.dispose();
		const failed = results.filter((r) => !r.ok);
		line(`===== ${results.length - failed.length} ok, ${failed.length} failed${failed.length ? `: ${failed.map((r) => r.name).join('; ')}` : ''}`);
	}
}

function activate(context) {
	out = vscode.window.createOutputChannel('EVƎ Cockpit API check');
	context.subscriptions.push(out, vscode.commands.registerCommand('ev3-cockpit-api-check.run', () =>
		run().catch((error) => line(`FAIL  the check itself — ${describe(error)}`))));
}

module.exports = { activate };
