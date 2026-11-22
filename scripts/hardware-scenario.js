/**
 * Drives the native daemon `ev3-cockpitd` through its surface, the way a client does, to record a
 * service scenario of a real brick or to replay one.
 *
 *   node scripts/hardware-scenario.js --list
 *   node scripts/hardware-scenario.js <scenario> --daemon <ev3-cockpitd> --brick <NAME>
 *        --out <dir> [--transport usb|bt|tcp] [--state-root <dir>] [--owner-present]
 *   node scripts/hardware-scenario.js <scenario> --daemon <ev3-cockpitd> --brick <NAME>
 *        --replay <fixture dir> [--strict] [--state-root <dir>]
 *
 * Recording starts the daemon on a private test channel in record mode: `--mode record
 * --record-dir <out>/<transport>-<scenario>-<brick>`, limited to the one transport. The daemon
 * creates that directory for the user alone (it must not exist yet), replaces every identifier it
 * knows with the repository's placeholders as it records (brick addresses and serials, this
 * computer's name, the user's name, LAN addresses, the Bluetooth adapter's address), and writes
 * `recording.jsonl` there. Read the recording, search it for real identifiers, and only then copy
 * it under `daemon/fixtures/service/`.
 *
 * Replaying starts the daemon on a test channel with `--fixtures <dir>` (matched, as the client
 * tests replay; `--strict` for every recorded call in its recorded order) and runs the same calls,
 * so a scenario and its fixture can be checked against each other without hardware.
 *
 * Each run ends the way the daemon tests end it: the brick disconnected, then `daemon/exit`, whose
 * restart question this client answers yes; the daemon then checks the recording is complete (or
 * that a strict replay made every recorded call) and exits 0, or 1 when not.
 *
 * Standalone: Node 20 and nothing else, so it runs on a recording host that has only Node. Nothing
 * it prints names a brick's address or a network address: those are masked before printing.
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ── Inputs the scenarios use (published in each fixture's scenario.md) ──────────

/** The firmware's own folders: what the read-only listing shows. */
const LMS = '/home/root/lms2012/';
/** The projects folder. */
const PRJS = '/home/root/lms2012/prjs/';
/**
 * The folder the writing scenarios create and remove. Letters only, like every input here: the
 * recorder replaces anything shaped like an address or a dotted quad, and the user and host names,
 * in request bytes too, so an input carrying one would not replay.
 */
const DIR = '/home/root/lms2012/prjs/CockpitFixture';
/** The line the written files repeat. */
const LINE = 'the quick brown fox jumps over the lazy dog\n';
/** The round-trip file: inline content, under the daemon's 4 KiB inline limit. */
const NOTE_BYTES = 3000;
/** The cut upload: about two hundred packets on a 1024-byte link, so the cut lands in the middle. */
const CUT_BYTES = 200000;
/**
 * When the second client cuts the upload, after the write was sent. The daemon reports no progress
 * for a write, so the cut is timed: the upload takes well over a second on a USB link.
 */
const CUT_AFTER_MS = 300;
/** The same cut in a replay, inside the 63 packets the recorded cut let through on any host. */
const CUT_AFTER_REPLAY_MS = 100;
/** How much one `transfer/write` carries. */
const TRANSFER_CHUNK = 16384;
/**
 * `Wait.rbf`, assembled with the firmware's assembler (lmssrc/adk/lmsasm) from
 *
 *     vmthread MAIN
 *     {
 *       DATA32 Timer
 *       TIMER_WAIT(8000,Timer)
 *       TIMER_READY(Timer)
 *     }
 *
 * It waits eight seconds and ends; it draws nothing, writes nothing and moves no motor.
 */
const WAIT_RBF = 'TEVHTyQAAABtAAEAAAAAABwAAAAAAAAABAAAAIWCQB9AhkAK';
/** How long the telemetry scenario listens. */
const TELEMETRY_MS = 60_000;
/** The interval the telemetry scenario asks for. */
const TELEMETRY_INTERVAL_MS = 1000;
/** Who this client says it is. The daemon tests that replay a fixture say the same. */
const CLIENT = { kind: 'cli', name: 'hardware scenario', version: '0.0.1', buildKind: 'development' };

const text = (bytes) => LINE.repeat(Math.ceil(bytes / LINE.length)).slice(0, bytes);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Output that names no address ────────────────────────────────────────────────

const started = Date.now();
/** Hardware addresses in any spelling and dotted quads, masked. */
function mask(value) {
	return String(value)
		.replace(/\b[0-9A-Fa-f]{2}(?:[:_-]?[0-9A-Fa-f]{2}){5}\b/g, '<id>')
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
}
function say(line) {
	process.stdout.write(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${mask(line)}\n`);
}
const brief = (value) => {
	const json = JSON.stringify(value);
	return json === undefined ? 'nothing' : json.length > 240 ? `${json.slice(0, 240)}...` : json;
};

// ── The channel: framing and the hello (docs/channel.md) ───────────────────────

class Client {
	constructor(socket, key) {
		this.socket = socket;
		this.key = key;
		this.buffer = Buffer.alloc(0);
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = [];
		this.questions = [];
		this.closed = false;
		socket.on('data', (chunk) => this.receive(chunk));
		socket.on('close', () => {
			this.closed = true;
			for (const { reject } of this.pending.values()) { reject(new Error('the daemon closed the connection')); }
			this.pending.clear();
		});
		socket.on('error', () => {});
	}

	static open(channelPath, key) {
		return new Promise((resolve, reject) => {
			const socket = net.connect(channelPath);
			socket.once('connect', () => resolve(new Client(socket, key)));
			socket.once('error', reject);
		});
	}

	send(message) {
		const body = Buffer.from(JSON.stringify(message), 'utf8');
		this.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
		this.socket.write(body);
	}

	receive(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const end = this.buffer.indexOf('\r\n\r\n');
			if (end < 0) { return; }
			const match = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString('utf8'));
			const length = Number(match?.[1] ?? 0);
			if (this.buffer.length < end + 4 + length) { return; }
			const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
			this.buffer = this.buffer.subarray(end + 4 + length);
			this.dispatch(message);
		}
	}

	dispatch(message) {
		if (message.method === undefined && this.pending.has(message.id)) {
			const call = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) {
				const error = new Error(`${call.method}: ${message.error.message}`);
				error.code = message.error.data?.code;
				error.data = message.error.data;
				call.reject(error);
			} else {
				call.resolve(message.result);
			}
			return;
		}
		if (message.method === 'question/ask') {
			const answer = this.answerFor(message.params);
			this.questions.push({ kind: message.params?.kind, answer });
			say(`question ${message.params?.kind}: answered ${answer}`);
			this.send({ jsonrpc: '2.0', id: message.id, result: { answer } });
			return;
		}
		for (const listener of this.listeners) { listener(message); }
	}

	/** The restart question `daemon/exit` raises is the one this client says yes to. */
	answerFor(params) {
		return params?.kind === 'restart' ? 'yes' : 'no';
	}

	call(method, params = {}, { progress } = {}) {
		const id = this.nextId++;
		const sent = progress ? { ...params, __progressToken: progress } : params;
		this.send({ jsonrpc: '2.0', id, method, params: sent });
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
	}

	/** Resolves with the first notification `wanted` accepts, or undefined after `ms`. */
	until(wanted, ms) {
		return new Promise((resolve) => {
			const listener = (message) => {
				if (wanted(message)) { done(message); }
			};
			const timer = setTimeout(() => done(undefined), ms);
			const done = (message) => {
				clearTimeout(timer);
				this.listeners = this.listeners.filter((l) => l !== listener);
				resolve(message);
			};
			this.listeners.push(listener);
		});
	}

	on(listener) {
		this.listeners.push(listener);
		return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
	}

	hmac(label, a, b) {
		return crypto.createHmac('sha256', this.key).update(`${label}\n${a}\n${b}`).digest('hex');
	}

	async hello(contractVersion) {
		const clientNonce = crypto.randomBytes(16).toString('hex');
		const start = await this.call('hello/start', {
			clientNonce, clientName: CLIENT.name, clientKind: CLIENT.kind, version: CLIENT.version,
			contractVersion, buildKind: CLIENT.buildKind,
		});
		if (start.daemonProof !== this.hmac('daemon', clientNonce, start.daemonNonce)) {
			throw new Error('the daemon could not prove it holds the key');
		}
		return this.call('hello/finish', { clientProof: this.hmac('client', clientNonce, start.daemonNonce) });
	}

	close() { this.socket.end(); }
}

/** A client past the hello, on the contract version the daemon speaks. */
async function connectClient(daemon) {
	let client = await Client.open(daemon.record.path, daemon.key);
	let hello = await client.hello(daemon.contractVersion ?? 2);
	if (daemon.contractVersion === undefined) {
		daemon.contractVersion = hello.contractVersion;
		if (hello.contractVersion !== 2) {
			client.close();
			client = await Client.open(daemon.record.path, daemon.key);
			hello = await client.hello(hello.contractVersion);
		}
	}
	return { client, hello };
}

// ── The daemon on a private test channel ───────────────────────────────────────

const CHANNEL = 'scenario';

async function startDaemon(binary, stateRoot, extra) {
	const child = spawn(binary, ['--channel', CHANNEL, '--state-root', stateRoot, ...extra], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
	const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
	const recordFile = path.join(stateRoot, 'channels', CHANNEL, 'channel.json');
	const deadline = Date.now() + 30_000;
	let gone;
	exited.then((outcome) => { gone = outcome; });
	while (Date.now() < deadline) {
		if (gone) { throw new Error(`the daemon exited at once (${gone.code ?? gone.signal}): ${mask(stderr.trim())}`); }
		try {
			const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
			if (record.pid === child.pid) {
				return { child, record, key: fs.readFileSync(path.join(stateRoot, 'key')), exited, stderr: () => stderr };
			}
		} catch { /* not written yet */ }
		await wait(50);
	}
	child.kill();
	throw new Error('the daemon did not open its channel within 30 s');
}

/** Ends the daemon the way the tests do: `daemon/exit`, the restart question answered yes. */
async function endDaemon(daemon, client) {
	const answer = await client.call('daemon/exit', {});
	say(`daemon/exit: ${brief(answer)}`);
	const outcome = await Promise.race([daemon.exited, wait(60_000).then(() => undefined)]);
	if (!outcome) {
		daemon.child.kill();
		throw new Error('the daemon did not end within 60 s of daemon/exit');
	}
	return outcome;
}

// ── Scenario steps ──────────────────────────────────────────────────────────────

/**
 * Waits for the first discovery round, then until the brick is listed on the transport with its
 * name confirmed. The daemon confirms a name with a probe of its own as the brick is first
 * discovered; connecting only after it keeps the probe's exchanges ahead of the session's on
 * every run, which a strict replay needs.
 */
async function findBrick(c) {
	await c.call('bricks/list', { waitForDiscovery: true });
	const deadline = Date.now() + 40_000;
	const unconfirmedUntil = Date.now() + 10_000;
	for (;;) {
		const { bricks } = await c.client.call('bricks/list', {});
		const on = (b) => (b.channels ?? []).map((ch) => ch.transport);
		const brick = bricks.find((b) => b.name.toLowerCase() === c.brick.toLowerCase());
		if (brick && on(brick).includes(c.transport) && (brick.nameConfirmed || Date.now() > unconfirmedUntil)) {
			say(`listed ${brick.name} on ${on(brick).join(', ')}`);
			return brick;
		}
		if (Date.now() > deadline) {
			throw new Error(`${c.brick} was not listed on ${c.transport} within 40 s; `
				+ `listed: ${bricks.map((b) => `${b.name}[${on(b).join(',')}]`).join(' ') || 'nothing'}`);
		}
		await wait(1000);
	}
}

/**
 * Waits until the brick's channel on the transport is available again: a link lost under a running
 * call can take the channel with it until discovery lists the brick again.
 */
async function untilAvailable(c) {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const { bricks } = await c.client.call('bricks/list', {});
		const brick = bricks.find((b) => b.name.toLowerCase() === c.brick.toLowerCase());
		if ((brick?.channels ?? []).some((ch) => ch.transport === c.transport && ch.state === 'available')) { return; }
		if (Date.now() > deadline) { throw new Error(`${c.brick} was not available on ${c.transport} again within 15 s`); }
		await wait(100);
	}
}

/** Makes sure the scenario's folder is not there yet, so every run sends the same requests. */
async function expectNoFolder(c) {
	const { exists } = await c.call('files/exists', { brick: c.brick, path: DIR });
	if (exists) {
		throw new Error(`${DIR} is already on the brick, left by an earlier run; remove it first `
			+ `(ev3 files rm -r ${DIR}) so the recording starts from a known state`);
	}
}

/** Uploads `bytes` into a transfer handle. */
async function fillTransfer(c, bytes) {
	const content = Buffer.from(text(bytes), 'utf8');
	const { handle, chunkBytes } = await c.call('transfer/begin', { size: content.length });
	const step = Math.min(TRANSFER_CHUNK, chunkBytes);
	for (let at = 0; at < content.length; at += step) {
		await c.client.call('transfer/write', { handle, data: content.subarray(at, at + step).toString('base64') });
	}
	return handle;
}

async function infoStorageListing(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	await c.call('bricks/info', { brick: c.brick });
	await c.call('bricks/storage', { brick: c.brick });
	await c.call('files/list', { brick: c.brick, path: LMS });
	await c.call('files/exists', { brick: c.brick, path: PRJS });
	await c.call('bricks/disconnect', { brick: c.brick });
}

async function fileRoundTrip(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	await expectNoFolder(c);
	await c.call('files/makeDirectory', { brick: c.brick, path: DIR });
	const note = text(NOTE_BYTES);
	await c.call('files/write', { brick: c.brick, path: `${DIR}/notes.txt`, content: Buffer.from(note).toString('base64') });
	await c.call('files/size', { brick: c.brick, path: `${DIR}/notes.txt` });
	const back = await c.call('files/read', { brick: c.brick, path: `${DIR}/notes.txt`, inline: true });
	const same = Buffer.from(back.content, 'base64').toString('utf8') === note;
	c.results.readBackMatches = same;
	if (!same) { throw new Error('the file read back differs from the one written'); }
	await c.call('files/move', { brick: c.brick, from: `${DIR}/notes.txt`, to: `${DIR}/moved.txt` });
	await c.call('files/list', { brick: c.brick, path: DIR });
	await c.call('files/remove', { brick: c.brick, path: DIR, recursive: true });
	await c.call('files/exists', { brick: c.brick, path: DIR });
	await c.call('bricks/disconnect', { brick: c.brick });
}

/**
 * A second client signs the brick out for everyone while the upload runs: the daemon drops the
 * session under the running write, as a pulled cable would, with no person needed. The write
 * fails; the brick is connected again and what the cut left is listed and removed.
 */
async function cutUpload(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	await expectNoFolder(c);
	await c.call('files/makeDirectory', { brick: c.brick, path: DIR });
	const handle = await fillTransfer(c, CUT_BYTES);
	const { client: other } = await connectClient(c.daemon);
	const writing = c.client.call('files/write', { brick: c.brick, path: `${DIR}/big.txt`, handle });
	writing.catch(() => {});
	// A replay serves each packet as fast as the brick answered it, so it cuts earlier: after the
	// last recorded packet the write would fail on a missing answer, a lost link, not a sign-out.
	await wait(c.replaying ? CUT_AFTER_REPLAY_MS : CUT_AFTER_MS);
	const cut = await other.call('bricks/disconnect', { brick: c.brick, forEveryone: true });
	say(`bricks/disconnect for everyone (second client): ${brief(cut)}`);
	try {
		const written = await writing;
		throw new Error(`the upload finished despite the cut (${brief(written)})`);
	} catch (error) {
		if (!error.code) { throw error; }
		c.results.cutError = error.code;
		say(`files/write failed: ${error.code}: ${error.message}`);
	}
	other.close();
	await untilAvailable(c);
	await c.call('bricks/connect', { brick: c.brick });
	await c.call('files/list', { brick: c.brick, path: DIR });
	await c.call('files/remove', { brick: c.brick, path: DIR, recursive: true });
	await c.call('bricks/disconnect', { brick: c.brick });
}

/** Subscribes to program states and returns the states heard. */
async function subscribePrograms(c) {
	const states = [];
	c.client.on((m) => { if (m.method === 'programs/stateChanged') { states.push(m.params); } });
	const subscription = await c.call('programs/subscribe', { brick: c.brick });
	return { states, subscription };
}

async function untilStopped(c, states, ms) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (states.some((s) => s.state?.running === false)) { return true; }
		await wait(100);
	}
	return false;
}

async function deployAndRun(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	await expectNoFolder(c);
	const { states, subscription } = await subscribePrograms(c);
	await c.call('programs/deployAndRun', {
		brick: c.brick,
		files: [{ remotePath: `${DIR}/Wait.rbf`, content: WAIT_RBF }],
		runPath: `${DIR}/Wait.rbf`,
	});
	const stopped = await untilStopped(c, states, 30_000);
	c.results.statesHeard = states.length;
	if (!stopped) { throw new Error('the program was not heard ending within 30 s'); }
	say(`program states heard: ${brief(states)}`);
	await c.call('subscriptions/cancel', { subscriptionId: subscription.subscriptionId });
	await c.call('files/remove', { brick: c.brick, path: DIR, recursive: true });
	await c.call('bricks/disconnect', { brick: c.brick });
}

async function programs(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	await expectNoFolder(c);
	await c.call('files/makeDirectory', { brick: c.brick, path: DIR });
	await c.call('files/write', { brick: c.brick, path: `${DIR}/Wait.rbf`, content: WAIT_RBF });
	const { states, subscription } = await subscribePrograms(c);
	await c.call('programs/run', { brick: c.brick, path: `${DIR}/Wait.rbf` });
	await c.call('programs/stop', { brick: c.brick });
	await c.call('programs/status', { brick: c.brick });
	const stopped = await untilStopped(c, states, 10_000);
	c.results.statesHeard = states.length;
	say(`program states heard: ${brief(states)}${stopped ? '' : ' (no stop heard)'}`);
	await c.call('subscriptions/cancel', { subscriptionId: subscription.subscriptionId });
	await c.call('files/remove', { brick: c.brick, path: DIR, recursive: true });
	await c.call('bricks/disconnect', { brick: c.brick });
}

async function telemetryMinute(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	const { rows } = await c.call('telemetry/rows', {});
	const wanted = rows.map((r) => r.id).filter((id) => /battery|program/i.test(id));
	const updates = [];
	c.client.on((m) => { if (m.method === 'telemetry/update') { updates.push(m.params); } });
	const subscription = await c.call('telemetry/subscribe', {
		brick: c.brick, request: { rows: wanted, intervalMs: TELEMETRY_INTERVAL_MS },
	});
	await wait(c.replaying ? Math.min(TELEMETRY_MS, 5000) : TELEMETRY_MS);
	c.results.rows = wanted;
	c.results.updates = updates.length;
	say(`telemetry updates heard: ${updates.length}; last ${brief(updates[updates.length - 1])}`);
	await c.call('subscriptions/cancel', { subscriptionId: subscription.subscriptionId });
	await c.call('bricks/disconnect', { brick: c.brick });
}

/** Owner-run: the brick switched off while its program runs. */
async function deployBrickOff(c) {
	await findBrick(c);
	await c.call('bricks/connect', { brick: c.brick });
	await expectNoFolder(c);
	const { states, subscription } = await subscribePrograms(c);
	const lost = c.client.until((m) => m.method === 'bricks/changed'
		&& !(m.params?.bricks ?? []).some((b) => b.name === c.brick && b.connected), 60_000);
	await c.call('programs/deployAndRun', {
		brick: c.brick,
		files: [{ remotePath: `${DIR}/Wait.rbf`, content: WAIT_RBF }],
		runPath: `${DIR}/Wait.rbf`,
	});
	beep();
	say('>>> SWITCH THE BRICK OFF NOW (press its dark grey back button, then the centre button)');
	const event = await lost;
	say(event ? `heard: ${event.method}` : 'the brick was not heard leaving within 60 s');
	c.results.statesHeard = states.length;
	c.results.leftHeard = Boolean(event);
	await c.call('subscriptions/cancel', { subscriptionId: subscription.subscriptionId }).catch(() => {});
	await c.call('bricks/disconnect', { brick: c.brick }).catch(() => {});
}

function beep() { process.stdout.write('\u0007'); }

const SCENARIOS = {
	'info-storage-listing': {
		summary: 'Connect, ask info and storage, list the firmware folder, check the projects folder exists, disconnect.',
		run: infoStorageListing,
	},
	'file-round-trip': {
		summary: 'Make a folder, write a 3000-byte file inline, size it, read it back, move it, list, remove the folder.',
		run: fileRoundTrip,
	},
	'cut-upload': {
		summary: 'A 200000-byte upload cut 300 ms in by a second client signing the brick out for everyone; connect again, list and remove what is left.',
		run: cutUpload,
	},
	'deploy-and-run': {
		summary: 'Deploy an eight-second program and run it, hear it end through a program subscription, remove it.',
		run: deployAndRun,
	},
	programs: {
		summary: 'Write the program, subscribe, run it, stop it at once, read the status, remove it.',
		run: programs,
	},
	'telemetry-minute': {
		summary: 'Subscribe to the battery and program rows at 1000 ms for a minute.',
		run: telemetryMinute,
	},
	'remove-folder': {
		summary: `Remove ${DIR} that a failed run left behind (a utility; its recording is not a fixture).`,
		run: async (c) => {
			await findBrick(c);
			await c.call('bricks/connect', { brick: c.brick });
			await c.call('files/remove', { brick: c.brick, path: DIR, recursive: true });
			await c.call('bricks/disconnect', { brick: c.brick });
		},
	},
	'deploy-brick-off': {
		summary: 'Deploy and run the eight-second program, and switch the brick off while it runs.',
		needsOwner: 'switch the brick off within eight seconds of the beep',
		run: deployBrickOff,
	},
};

// ── The run ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = { flags: new Set() };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (['--daemon', '--brick', '--out', '--transport', '--state-root', '--replay'].includes(arg)) {
			args[arg.slice(2)] = argv[++i];
		} else if (arg.startsWith('--')) {
			args.flags.add(arg.slice(2));
		} else if (!args.scenario) {
			args.scenario = arg;
		} else {
			throw new Error(`unexpected argument ${arg}`);
		}
	}
	return args;
}

const USAGE = 'usage: node scripts/hardware-scenario.js --list\n'
	+ '       node scripts/hardware-scenario.js <scenario> --daemon <ev3-cockpitd> --brick <NAME> --out <dir> '
	+ '[--transport usb|bt|tcp] [--state-root <dir>] [--owner-present]\n'
	+ '       node scripts/hardware-scenario.js <scenario> --daemon <ev3-cockpitd> --brick <NAME> --replay <fixture dir> '
	+ '[--strict] [--state-root <dir>]';

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.flags.has('list')) {
		for (const [name, s] of Object.entries(SCENARIOS)) {
			process.stdout.write(`${name.padEnd(22)} ${s.summary}${s.needsOwner ? ` (needs the owner: ${s.needsOwner})` : ''}\n`);
		}
		return 0;
	}
	const scenario = SCENARIOS[args.scenario];
	if (!scenario || !args.daemon || !args.brick || (!args.out === !args.replay)) {
		process.stderr.write(`${USAGE}\n`);
		return 64;
	}
	if (scenario.needsOwner && !args.replay && !args.flags.has('owner-present')) {
		process.stderr.write(`${args.scenario} needs the owner: ${scenario.needsOwner}. Run it with --owner-present when that is arranged.\n`);
		return 64;
	}
	const transport = args.transport ?? 'usb';
	if (!['usb', 'bt', 'tcp'].includes(transport)) { throw new Error(`${transport} is not a transport`); }
	const name = `${transport}-${args.scenario}-${args.brick.toLowerCase()}`;
	const stateParent = args['state-root'] ?? (args.replay ? os.tmpdir() : path.join(os.homedir(), 'ev3rec', 'state'));
	fs.mkdirSync(stateParent, { recursive: true, mode: 0o700 });
	const stateRoot = fs.mkdtempSync(path.join(stateParent, 'run-'));
	const daemonArgs = args.replay
		? ['--mode', 'replay', '--fixtures', path.resolve(args.replay), ...(args.flags.has('strict') ? ['--replay', 'strict'] : [])]
		: ['--mode', 'record', '--record-dir', path.resolve(args.out, name), '--transports', transport];

	say(`${args.scenario} on ${args.brick} over ${transport}, ${args.replay ? `replaying ${path.basename(args.replay)}${args.flags.has('strict') ? ' strictly' : ''}` : `recording ${name}`}`);
	const daemon = await startDaemon(path.resolve(args.daemon), stateRoot, daemonArgs);
	const { client, hello } = await connectClient(daemon);
	say(`hello: daemon ${hello.version}, contract ${hello.contractVersion}, ${hello.buildKind}, ${hello.mode}`);
	const c = {
		daemon, client, brick: args.brick, transport, replaying: Boolean(args.replay), results: {},
		async call(method, params) {
			try {
				const result = await client.call(method, params);
				say(`${method} ${brief(params)} -> ${brief(result)}`);
				return result;
			} catch (error) {
				say(`${method} ${brief(params)} -> ERROR ${error.code ?? ''} ${error.message}`);
				throw error;
			}
		},
	};
	let failure;
	if (scenario.needsOwner && !args.replay) {
		beep();
		say(`${args.scenario}: ${scenario.needsOwner}. Starting in 5 s.`);
		await wait(5000);
	}
	try {
		await scenario.run(c);
	} catch (error) {
		failure = error;
	}
	const outcome = await endDaemon(daemon, client).catch((error) => ({ error }));
	client.close();
	say(`results: ${brief(c.results)}`);
	if (failure) { say(`FAILED: ${failure.message}`); }
	if (outcome.error) { say(`FAILED to end the daemon: ${outcome.error.message}`); return 1; }
	const stderr = daemon.stderr().trim();
	if (stderr) { say(`daemon said: ${stderr}`); }
	say(`daemon exited with ${outcome.code ?? outcome.signal}`);
	if (!args.replay && outcome.code === 0) {
		const file = path.join(path.resolve(args.out, name), 'recording.jsonl');
		const recorded = fs.readFileSync(file, 'utf8');
		say(`recorded ${recorded.split('\n').filter(Boolean).length} lines, ${recorded.length} bytes into ${file}`);
	}
	return failure || outcome.code !== 0 ? 1 : 0;
}

module.exports = {
	Client, connectClient, startDaemon, endDaemon, findBrick, untilAvailable, say, mask, brief, wait, beep,
};

if (require.main === module) {
	main().then((code) => process.exit(code), (error) => {
		process.stderr.write(`${mask(error?.stack ?? error)}\n`);
		process.exit(1);
	});
}
