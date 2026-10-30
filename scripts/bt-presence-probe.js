/**
 * Which check tells a paired brick that is switched on from one that is off? (step-2 plan, U6)
 *
 *   node scripts/bt-presence-probe.js --states AAA=on,BBB=off,CCC=hidden [--reps 3]
 *   node scripts/bt-presence-probe.js --under-inquiry [--reps 6]
 *
 * Windows lists every paired brick whether it is on or not, so the cockpit cannot tell from
 * its records which of the user's bricks are actually there. Two candidates, measured here:
 *
 *   sdp      an uncached RFCOMM service query to one address (helper --sdp). It has to reach
 *            the brick itself, and works without the brick being visible, if it works at all.
 *   inquiry  a live inquiry that includes paired devices (helper --watch-raw, all devices).
 *            Needs the brick visible. On 29.10.2026 it reported nothing for any paired brick
 *            (step-1 plan §4a); measured again here alongside the SDP query.
 *
 * Each brick is put by the owner into the state --states names: `on` (on and visible),
 * `hidden` (on, Bluetooth visibility off) or `off`. After every SDP query the script opens
 * one Bluetooth connection to the same brick and reads `info`, through the shipped
 * provider, to see whether the query left the brick locked out the way a too-soon reconnect
 * does (D3). `--under-inquiry` instead compares connect success with and without a
 * background inquiry running, all bricks on.
 *
 * Decision rule, written before the run (plan U6): a method qualifies when it separates on
 * from off in every repetition on all three bricks, answers within 6 s, and causes no failed
 * connect after it beyond the adapter's usual rate. Prefer the one that also works hidden.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '..');

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') { return path.join(REPO, 'src/test/vscodeStub.cjs'); }
	return originalResolve.call(this, request, ...rest);
};

const out = (dir) => path.join(REPO, 'out', dir);
const { BtTransportProvider, BtWinsockAdapter, BtConnectionQueue } = require(out('transports'));
const { encodeEv3Packet, decodeEv3Packet } = require(out('protocol/ev3Packet'));
const { buildCommand } = require(out('protocol/ev3Commands'));
const { parseResponse } = require(out('protocol/ev3Responses'));
const { makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const argAfter = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const HELPER = argAfter('--helper', path.join(REPO, 'native', 'bin', 'bt-pairing-helper.exe'));
const UNDER_INQUIRY = process.argv.includes('--under-inquiry');
const REPS = Number.parseInt(argAfter('--reps', UNDER_INQUIRY ? '6' : '3'), 10);
const STATES = new Map((argAfter('--states', '') || '').split(',').filter(Boolean)
	.map((pair) => pair.split('=').map((s) => s.trim())).map(([name, state]) => [name.toUpperCase(), state]));
const AQS_ALL = 'System.Devices.DevObjectType:=5 AND System.Devices.Aep.ProtocolId:="{E0CBF06C-CD8B-4647-BB8A-263B43F0F974}" '
	+ 'AND System.Devices.Aep.Bluetooth.IssueInquiry:=System.StructuredQueryType.Boolean#True';
const LEGO = '00:16:53';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const log = (line) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s  ${line}`);

/** Runs the helper and returns its JSON lines. */
function helper(args) {
	return new Promise((resolve) => {
		const child = spawn(HELPER, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let text = '';
		child.stdout.on('data', (chunk) => { text += chunk; });
		child.on('close', () => resolve(text.split('\n').map((l) => l.trim()).filter(Boolean)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)));
	});
}

/** The paired bricks Windows knows, by name. */
async function pairedBricks() {
	const lines = await helper(['--scan', '--inquiry-seconds', '1', '--timeout-seconds', '20']);
	return lines.filter((e) => e.type === 'device' && e.paired && e.mac.toUpperCase().startsWith(LEGO))
		.map((e) => ({ name: (e.name || e.mac).toUpperCase(), mac: e.mac.toUpperCase() }));
}

async function sdp(mac) {
	const lines = await helper(['--sdp', '--mac', mac, '--timeout-seconds', '10']);
	const result = lines.find((e) => e.type === 'sdp');
	return result ?? { answered: false, reason: 'no output', elapsedMs: NaN };
}

/** Which LEGO addresses a live inquiry over all devices heard, and how. */
async function inquiry(seconds) {
	const lines = await helper(['--watch-raw', '--aqs', AQS_ALL, '--inquiry-seconds', String(seconds),
		'--timeout-seconds', String(seconds + 20)]);
	const heard = new Map();
	for (const e of lines) {
		if ((e.type !== 'rawAdded' && e.type !== 'rawUpdated') || !e.mac?.toUpperCase().startsWith(LEGO)) { continue; }
		const mac = e.mac.toUpperCase();
		const seen = heard.get(mac) ?? { added: 0, updated: 0, present: [] };
		if (e.type === 'rawAdded') { seen.added += 1; } else { seen.updated += 1; }
		seen.present.push(e.present);
		heard.set(mac, seen);
	}
	return heard;
}

let counter = 0;
/** One connect, `info`, close, through the shipped provider. */
async function connectCycle(provider, mac) {
	const key = makeBrickKey(Transport.BT, mac);
	const at = Date.now();
	try {
		await provider.connect(key);
		counter = (counter + 1) & 0xffff;
		const { type, payload } = buildCommand({ kind: 'info' });
		const reply = await provider.sendPacket(key, encodeEv3Packet(counter, type, payload), {
			expectedMessageCounter: counter, timeoutMs: 3000,
		});
		parseResponse({ kind: 'info' }, decodeEv3Packet(reply));
		await provider.disconnect(key);
		return { ok: true, ms: Date.now() - at };
	} catch (error) {
		await provider.disconnect(key).catch(() => {});
		return { ok: false, ms: Date.now() - at, error: String((error && error.message) || error) };
	}
}

function makeProvider() {
	// No queue cooldown: the connect right after a check is the question. The provider's own
	// 5 s gap after a close stays, so the script's own closes do not lock a brick out (D3).
	const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
	const provider = new BtTransportProvider({
		backends: new Map([['winsock', (m) => new BtWinsockAdapter({ mac: m })]]),
		connectionQueue: queue,
	});
	return { provider, queue };
}

async function measureStates(bricks) {
	const { provider, queue } = makeProvider();
	const rows = [];
	for (let rep = 1; rep <= REPS; rep += 1) {
		for (const brick of bricks) {
			const state = STATES.get(brick.name) ?? '?';
			const check = await sdp(brick.mac);
			const after = await connectCycle(provider, brick.mac);
			rows.push({ rep, brick: brick.name, state, method: 'sdp', heard: check.answered, ms: check.elapsedMs, link: check.connectionStatus, detail: check.error ?? check.reason, connectAfter: after });
			log(`${brick.name} (${state}) rep ${rep}: sdp ${check.answered ? 'ANSWERED' : 'silent'} ${check.elapsedMs} ms `
				+ `(${check.error ?? check.reason}, link ${check.connectionStatus ?? '-'}, services ${check.services ?? '-'}); `
				+ `connect after: ${after.ok ? `ok ${after.ms} ms` : `FAIL ${after.ms} ms ${after.error}`}`);
			await wait(6000);   // past the provider's 5 s gap, so the next check starts clean
		}
		// Run 1 (30.10.2026) heard nothing for any paired brick, on and visible included.
		if (process.argv.includes('--no-inquiry')) { continue; }
		const heard = await inquiry(12);
		for (const brick of bricks) {
			const state = STATES.get(brick.name) ?? '?';
			const seen = heard.get(brick.mac);
			rows.push({ rep, brick: brick.name, state, method: 'inquiry', heard: Boolean(seen), detail: seen ? `added ${seen.added} updated ${seen.updated} present ${seen.present.join('/')}` : '' });
			log(`${brick.name} (${state}) rep ${rep}: inquiry ${seen ? `HEARD ${JSON.stringify(seen)}` : 'silent'}`);
		}
	}
	queue.dispose?.();
	provider.dispose?.();

	console.log('\nbrick  state   method   heard/reps  median ms  connect-after ok  sdp link status');
	for (const brick of bricks) {
		for (const method of ['sdp', 'inquiry']) {
			const mine = rows.filter((r) => r.brick === brick.name && r.method === method);
			const heard = mine.filter((r) => r.heard).length;
			const times = mine.map((r) => r.ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
			const median = times.length ? times[Math.floor(times.length / 2)] : '-';
			const after = mine.filter((r) => r.connectAfter).map((r) => r.connectAfter.ok);
			console.log(`${brick.name.padEnd(6)} ${String(mine[0]?.state).padEnd(7)} ${method.padEnd(8)} `
				+ `${`${heard}/${mine.length}`.padEnd(11)} ${String(median).padEnd(10)} `
				+ `${(after.length ? `${after.filter(Boolean).length}/${after.length}` : '-').padEnd(17)} `
				+ `${mine.map((r) => r.link).filter(Boolean).join(',')}`);
		}
	}
}

async function measureUnderInquiry(bricks) {
	const { provider, queue } = makeProvider();
	const arms = { quiet: [], inquiry: [] };
	for (let rep = 1; rep <= REPS; rep += 1) {
		for (const arm of rep % 2 ? ['quiet', 'inquiry'] : ['inquiry', 'quiet']) {
			let background;
			if (arm === 'inquiry') { background = inquiry(25); await wait(1000); }
			for (const brick of bricks) {
				const result = await connectCycle(provider, brick.mac);
				arms[arm].push(result.ok);
				log(`${arm.padEnd(7)} rep ${rep} ${brick.name}: ${result.ok ? `ok ${result.ms} ms` : `FAIL ${result.ms} ms ${result.error}`}`);
				await wait(6000);
			}
			if (background) { await background; }
		}
	}
	queue.dispose?.();
	provider.dispose?.();
	for (const [arm, results] of Object.entries(arms)) {
		console.log(`${arm.padEnd(8)} ${results.filter(Boolean).length}/${results.length} connects opened`);
	}
}

async function main() {
	const bricks = await pairedBricks();
	if (bricks.length === 0) { throw new Error('No paired LEGO bricks in the Windows records.'); }
	log(`paired bricks: ${bricks.map((b) => `${b.name} ${b.mac} (${STATES.get(b.name) ?? 'state not given'})`).join(', ')}`);
	if (UNDER_INQUIRY) { await measureUnderInquiry(bricks); } else { await measureStates(bricks); }
	log('done');
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); },
);
