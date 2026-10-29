/**
 * Logs Bluetooth signal and presence of every LEGO brick continuously, while a person carries
 * one brick away and back (step-1 plan, section 4a: does the signal follow distance, and can a
 * paired brick be heard live at all).
 *
 *   node scripts/signal-monitor.js --helper <bt-pairing-helper.exe> [--minutes 20] [--stop-file <path>]
 *
 * Each cycle reads two sources, one after the other:
 *   records  Windows' paired-device records -- what the current scan shows (helper --scan)
 *   live     a watcher with live inquiry on for paired and unpaired alike (helper --watch-raw)
 * One line per reading, with the wall-clock time, so the log can be matched against where the
 * brick was. Runs until --minutes passes or the stop file appears.
 */

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const argAfter = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const HELPER = argAfter('--helper');
const MINUTES = Number.parseFloat(argAfter('--minutes', '20'));
const STOP = argAfter('--stop-file');
const LIVE_WINDOW_S = 12;
const AQS_ALL = 'System.Devices.DevObjectType:=5 AND System.Devices.Aep.ProtocolId:="{E0CBF06C-CD8B-4647-BB8A-263B43F0F974}" '
	+ 'AND System.Devices.Aep.Bluetooth.IssueInquiry:=System.StructuredQueryType.Boolean#True';
const LEGO = '00:16:53';

const clock = () => new Date().toTimeString().slice(0, 8);

function helper(args, onEvent) {
	return new Promise((resolve) => {
		const child = spawn(HELPER, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
		let tail = '';
		child.stdout.on('data', (chunk) => {
			tail += chunk;
			const lines = tail.split('\n');
			tail = lines.pop() ?? '';
			for (const line of lines) {
				try { onEvent(JSON.parse(line)); } catch { /* not a protocol line */ }
			}
		});
		child.on('close', () => resolve());
	});
}

const lego = (mac) => typeof mac === 'string' && mac.toUpperCase().startsWith(LEGO);

async function main() {
	const end = Date.now() + MINUTES * 60000;
	let cycle = 0;
	console.log(`start ${clock()}; time | cycle | source | mac | name | signal | present`);
	while (Date.now() < end && !(STOP && fs.existsSync(STOP))) {
		cycle += 1;
		await helper(['--scan', '--inquiry-seconds', '1', '--timeout-seconds', '20'], (e) => {
			if (e.type === 'device' && e.paired && lego(e.mac)) {
				console.log(`${clock()} | ${cycle} | records | ${e.mac} | ${e.name} | ${e.signal} |`);
			}
		});
		await helper(['--watch-raw', '--aqs', AQS_ALL, '--inquiry-seconds', String(LIVE_WINDOW_S), '--timeout-seconds', String(LIVE_WINDOW_S + 15)], (e) => {
			if ((e.type === 'rawAdded' || e.type === 'rawUpdated') && lego(e.mac)) {
				console.log(`${clock()} | ${cycle} | ${e.type === 'rawAdded' ? 'live+' : 'live~'} | ${e.mac} | ${e.name ?? ''} | ${e.signal} | ${e.present}`);
			} else if (e.type === 'rawRemoved' && lego(e.mac)) {
				console.log(`${clock()} | ${cycle} | live- | ${e.mac} | | |`);
			}
		});
	}
	console.log(`stop ${clock()} after ${cycle} cycles`);
}

main().catch((error) => { console.error(error); process.exit(1); });
