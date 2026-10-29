/**
 * Does a paired brick answer a live inquiry, and does the signal follow distance?
 *
 *   node scripts/presence-signal-probe.js --helper <path-to-bt-pairing-helper.exe> --moved <MAC>
 *
 * Needs a person: one brick (--moved) is carried to another room and back, the others stay
 * at the computer as controls. Signals from the PC speaker:
 *   three short high beeps -> carry the moved brick away now
 *   one long low beep      -> bring it back
 *
 * Each round reads two things for every brick (step-1 plan, section 4a):
 *   records  the value the current scan uses: Windows' paired-device records (helper --scan)
 *   live     a watcher with live inquiry switched on for paired and unpaired alike
 *            (helper --watch-raw), every Added/Updated with its signal and IsPresent
 * Bluetooth only: no USB is needed, so the moved brick can leave its cable behind.
 */

'use strict';

const { spawn } = require('child_process');

const argAfter = (flag) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const HELPER = argAfter('--helper');
const MOVED = (argAfter('--moved') ?? '').toUpperCase();
const ROUNDS = 2;
const WINDOW_S = 25;
const AQS_ALL = 'System.Devices.DevObjectType:=5 AND System.Devices.Aep.ProtocolId:="{E0CBF06C-CD8B-4647-BB8A-263B43F0F974}" '
	+ 'AND System.Devices.Aep.Bluetooth.IssueInquiry:=System.StructuredQueryType.Boolean#True';
const LEGO = '00:16:53';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const log = (line) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${line}`);

function beep(pattern) {
	const script = pattern.map(([hz, ms]) => `[console]::beep(${hz},${ms})`).join(';');
	spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
}

/** Runs the helper and returns its JSON lines. */
function helper(args) {
	return new Promise((resolve) => {
		const child = spawn(HELPER, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let out = '';
		child.stdout.on('data', (chunk) => { out += chunk; });
		child.on('close', () => resolve(out.split('\n').map((l) => l.trim()).filter(Boolean)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)));
	});
}

async function round(phase, n, rows) {
	const records = await helper(['--scan', '--inquiry-seconds', '1', '--timeout-seconds', '20']);
	for (const e of records.filter((x) => x.type === 'device' && x.paired && x.mac.toUpperCase().startsWith(LEGO))) {
		rows.push({ phase, n, mac: e.mac.toUpperCase(), name: e.name, source: 'records', signal: e.signal });
	}
	const live = await helper(['--watch-raw', '--aqs', AQS_ALL, '--inquiry-seconds', String(WINDOW_S), '--timeout-seconds', String(WINDOW_S + 20)]);
	for (const e of live.filter((x) => (x.type === 'rawAdded' || x.type === 'rawUpdated') && x.mac && x.mac.toUpperCase().startsWith(LEGO))) {
		rows.push({ phase, n, mac: e.mac.toUpperCase(), name: e.name, source: e.type === 'rawAdded' ? 'live-added' : 'live-updated', signal: e.signal, present: e.present, atMs: e.atMs });
	}
	const heard = new Set(rows.filter((r) => r.phase === phase && r.n === n && r.source === 'live-updated').map((r) => r.mac));
	log(`${phase} round ${n}: live updates from ${[...heard].join(', ') || 'nobody'}`);
}

function report(rows) {
	const macs = [...new Set(rows.map((r) => r.mac))].sort();
	const names = new Map(rows.filter((r) => r.name).map((r) => [r.mac, r.name]));
	const phases = ['near', 'away', 'back'];
	console.log('\nper brick, per phase and round: records value | live Added value | live Updated values (signal, present)');
	for (const mac of macs) {
		console.log(`\n${names.get(mac) ?? '?'} ${mac}${mac === MOVED ? '   <- MOVED' : ''}`);
		for (const phase of phases) {
			for (let n = 1; n <= ROUNDS; n += 1) {
				const pick = (source) => rows.filter((r) => r.mac === mac && r.phase === phase && r.n === n && r.source === source);
				const rec = pick('records').map((r) => r.signal).join(',') || '-';
				const added = pick('live-added').map((r) => `${r.signal}/${r.present}`).join(',') || '-';
				const updated = pick('live-updated').map((r) => `${r.signal}/${r.present}`).join(' ') || '-';
				console.log(`  ${phase.padEnd(4)} ${n}  records ${String(rec).padEnd(5)} added ${added.padEnd(12)} updated ${updated}`);
			}
		}
	}
}

async function main() {
	if (!HELPER || !MOVED) {
		console.error('usage: --helper <exe> --moved <MAC>');
		process.exit(1);
	}
	const rows = [];
	for (let n = 1; n <= ROUNDS; n += 1) { await round('near', n, rows); }

	log('>>> CARRY the moved brick away now (three high beeps); 45 s to get there');
	beep([[1500, 150], [1500, 150], [1500, 150]]);
	await wait(45000);
	for (let n = 1; n <= ROUNDS; n += 1) { await round('away', n, rows); }

	log('>>> BRING it back (one long low beep); 30 s');
	beep([[600, 900]]);
	await wait(30000);
	for (let n = 1; n <= ROUNDS; n += 1) { await round('back', n, rows); }

	report(rows);
}

main().catch((error) => { console.error(error); process.exit(1); });
