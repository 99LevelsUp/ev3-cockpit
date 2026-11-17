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

/**
 * Watches the daisy chain of the brick picked, through the API a consumer uses (step-8 plan, U7):
 * every chain event, and the member ports each time they change. Runs until the command is given
 * again, so the bricks can be rewired in between.
 */
let chainWatch;

async function watchChain() {
	if (chainWatch) { chainWatch.dispose(); chainWatch = undefined; line('===== chain watch stopped'); return; }
	out.show(true);
	const cockpit = vscode.extensions.getExtension('99LevelsUp.ev3-cockpit');
	if (!cockpit) { line('FAIL  the cockpit is not installed'); return; }
	const api = await cockpit.activate();
	const consumer = api.registerConsumer('ev3-cockpit-chain-watch');
	const brick = await pickBrick(consumer);
	if (!brick) { consumer.dispose(); line('skip  no brick picked'); return; }
	if (!brick.signedIn) { await consumer.connect(brick.brickId); }
	consumer.setActiveBrick(brick.brickId);
	line(`===== chain watch on ${brick.name}, ${route(consumer.listBricks().find((b) => b.brickId === brick.brickId))}`);

	const show = (chain) => {
		const members = chain.members.map((m) => `${m.layer}${m.capabilities.motorTypes ? '' : ' (motor types not vouched for)'}`);
		line(`chain read=${chain.read} stale=${chain.stale} members=[${members.join(', ')}]`);
	};
	show(consumer.getChain(brick.brickId));
	const following = consumer.onChainChanged(brick.brickId, show);

	// Every member port row: type, raw code and mode from occupancy, value for sensors. A member's
	// motor has no position row, so none can show.
	const rows = consumer.listTelemetryRows().filter((r) => r.id.startsWith('chain.')).map((r) => r.id);
	line(`      ${rows.length} chain rows; motor position rows among them: ${rows.filter((id) => /\.motor\..*\.(?!occupancy$)/.test(id)).length}`);
	let lastTable = '';
	const telemetry = consumer.subscribeTelemetry(brick.brickId, { rows, intervalMs: 500 }, () => {
		const table = telemetry.snapshot()
			.filter((v) => v.rowId !== 'chain.depth' && v.value !== undefined && !(v.rowId.endsWith('.occupancy') && v.value === 126))
			.map((v) => `${v.rowId}=${typeof v.value === 'number' ? Math.round(v.value * 10) / 10 : v.value}${v.mode !== undefined ? `/m${v.mode}` : ''}${v.stale ? ' (stale)' : ''}`)
			.sort()
			.join('  ');
		if (table !== lastTable) { lastTable = table; line(`ports ${table || '(none)'}`); }
	});
	chainWatch = { dispose: () => { following.dispose(); telemetry.dispose(); consumer.dispose(); } };
}

/**
 * Failure scenarios for a hardware session (IMPLEMENTATION_PLAN 2.8.12): the person cuts a link
 * while the API is busy, and the check records what the consumer saw. Two of them:
 *
 *  - an upload cut mid-way (4.6.17): the brick's free space before, the failure the write ended
 *    with, and the free space after the brick is back, which the cockpit should have released
 *    without a reboot;
 *  - commands in flight when the link drops (2.8.14): several callers keep asking the brick, and
 *    each failure is listed with how long it took, so a command refused at once (never sent) shows
 *    apart from one that waited out a timeout.
 */
async function failures() {
	out.show(true);
	const cockpit = vscode.extensions.getExtension('99LevelsUp.ev3-cockpit');
	if (!cockpit) { line('FAIL  the cockpit is not installed'); return; }
	const api = await cockpit.activate();
	const consumer = api.registerConsumer('ev3-cockpit-failures');
	try {
		const brick = await pickBrick(consumer);
		if (!brick) { line('skip  no brick picked'); return; }
		const scenario = await vscode.window.showQuickPick([
			{ label: 'An upload cut mid-way (4.6.17)', run: interruptedUpload },
			{ label: 'Commands in flight when the link drops (2.8.14)', run: commandsInFlight },
		], { title: 'API check: which failure scenario?' });
		if (!scenario) { line('skip  no scenario picked'); return; }
		if (!brick.signedIn) { await consumer.connect(brick.brickId); }
		line(`===== ${scenario.label} on ${brick.name}, ${route(consumer.listBricks().find((b) => b.brickId === brick.brickId))}, cockpit ${cockpit.packageJSON.version}`);
		await scenario.run(consumer, brick.brickId);
	} finally {
		consumer.dispose();
	}
}

const connectedOn = (consumer, brickId) => consumer.listBricks().find((b) => b.brickId === brickId)
	?.channels.some((c) => c.state === 'connected') === true;

async function interruptedUpload(consumer, brickId) {
	const size = await vscode.window.showQuickPick([
		{ label: '3 MB', bytes: 3_000_000, description: 'USB: several seconds' },
		{ label: '1 MB', bytes: 1_000_000, description: 'Bluetooth or Wi-Fi: a minute or more' },
		{ label: '300 kB', bytes: 300_000, description: 'Bluetooth: half a minute' },
	], { title: 'API check: how big an upload?' });
	if (!size) { line('skip  no size picked'); return; }
	const file = `${CHECK_DIR}/cut.bin`;
	await consumer.makeDirectory(brickId, CHECK_DIR).catch(() => { /* there already */ });
	const before = await consumer.storage(brickId);
	line(`      free before: ${before.freeKb} KB of ${before.totalKb} KB`);
	await ask(`An upload of ${size.label} starts when you press Start. Cut the link while it runs, `
		+ 'when the output says it is a quarter through.', 'Start');

	const content = new Uint8Array(size.bytes).map((_, i) => (i * 13) & 0xff);
	const started = Date.now();
	let told = false;
	let lastTenth = -1;
	try {
		await consumer.writeFile(brickId, file, content, {
			onProgress: (p) => {
				const done = p.transferred;
				const tenth = Math.floor((done / size.bytes) * 10);
				if (tenth !== lastTenth) { lastTenth = tenth; line(`      ${tenth * 10} % (${done} B, ${Date.now() - started} ms)`); }
				if (!told && done >= size.bytes / 4) {
					told = true;
					line('>>>>  CUT THE LINK NOW');
					void vscode.window.showWarningMessage('API check: cut the link now.');
				}
			},
		});
		line(`note  the upload finished before the link went (${Date.now() - started} ms); nothing to release`);
	} catch (error) {
		line(`ok    the upload failed — ${describe(error)} (${Date.now() - started} ms)`);
	}

	line('      waiting for the brick to be connected again (restore the link, or it stays on its other channel)');
	await until('the brick connected again', () => connectedOn(consumer, brickId), 300_000)
		.then(() => line(`      connected: ${route(consumer.listBricks().find((b) => b.brickId === brickId))}`));
	const leftBefore = await consumer.exists(brickId, file).catch(() => undefined);
	line(`      the partial file ${leftBefore === undefined ? 'could not be checked' : leftBefore ? 'is there' : 'is not there'} before the next transfer`);
	const freeBetween = await consumer.storage(brickId).catch(() => undefined);
	line(`      free before the next transfer: ${freeBetween?.freeKb ?? '?'} KB`);
	// The cockpit pays what an interrupted transfer owes when the next transfer begins (4.6.17,
	// TransferLedger), not on the reconnect itself: a one-byte upload is that next transfer.
	await consumer.writeFile(brickId, `${CHECK_DIR}/next.bin`, new Uint8Array([1]))
		.then(() => line('      next transfer: a one-byte upload went through'))
		.catch((error) => line(`      next transfer: ${describe(error)}`));
	const deadline = Date.now() + 90_000;
	let after;
	while (Date.now() < deadline) {
		after = await consumer.storage(brickId).catch((error) => { line(`      storage: ${describe(error)}`); return undefined; });
		if (after) { line(`      free now: ${after.freeKb} KB`); }
		if (after && after.freeKb >= before.freeKb - 4) { break; }
		await wait(5000);
	}
	const released = after !== undefined && after.freeKb >= before.freeKb - 4;
	results.push({ name: 'upload cut: space released without a reboot', ok: released });
	line(`${released ? 'ok   ' : 'FAIL '} upload cut: free ${before.freeKb} KB before, ${after?.freeKb ?? '?'} KB after`);
	const left = await consumer.exists(brickId, file).catch(() => undefined);
	line(`      the partial file ${left === undefined ? 'could not be checked' : left ? 'is still there' : 'is gone'}`);
	await consumer.remove(brickId, CHECK_DIR, { recursive: true }).catch((error) => line(`      cleanup: ${describe(error)}`));
}

async function commandsInFlight(consumer, brickId) {
	const CALLERS = 6;
	const SECONDS = 60;
	const go = await ask(`${CALLERS} callers keep asking the brick for ${SECONDS} s. Cut the link a few seconds after Start, `
		+ 'and restore it if you want to see it come back.', 'Start');
	if (go !== 'Start') { line('skip  commands in flight'); return; }
	const end = Date.now() + SECONDS * 1000;
	const answered = [];
	const failed = [];
	const caller = async (n) => {
		while (Date.now() < end) {
			const t = Date.now();
			try {
				await consumer.storage(brickId);
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
	const kinds = new Map();
	for (const f of failed) {
		const k = kinds.get(f.what) ?? { count: 0, min: Infinity, max: 0 };
		k.count += 1; k.min = Math.min(k.min, f.ms); k.max = Math.max(k.max, f.ms);
		kinds.set(f.what, k);
	}
	line(`      answered ${answered.length}, median ${answered.sort((a, b) => a - b)[Math.floor(answered.length / 2)] ?? '?'} ms`);
	for (const [what, k] of kinds) { line(`      failed ${k.count}× in ${k.min}–${k.max} ms — ${what}`); }
	line(`===== commands in flight: ${answered.length} answered, ${failed.length} failed`);
}

function activate(context) {
	out = vscode.window.createOutputChannel('EVƎ Cockpit API check');
	context.subscriptions.push(out, vscode.commands.registerCommand('ev3-cockpit-api-check.run', () =>
		run().catch((error) => line(`FAIL  the check itself — ${describe(error)}`))));
	context.subscriptions.push(vscode.commands.registerCommand('ev3-cockpit-api-check.watchChain', () =>
		watchChain().catch((error) => line(`FAIL  the chain watch — ${describe(error)}`))));
	context.subscriptions.push(vscode.commands.registerCommand('ev3-cockpit-api-check.failures', () =>
		failures().catch((error) => line(`FAIL  the failure scenario — ${describe(error)}`))));
	context.subscriptions.push({ dispose: () => chainWatch?.dispose() });
}

module.exports = { activate };
