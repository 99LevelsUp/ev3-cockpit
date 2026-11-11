/**
 * Does reading telemetry slow a program running on the brick? (owner, 11.11.2026)
 *
 * The VM is one thread and takes its slots in turn: a slot runs up to PRG_PRIORITY
 * instructions or 2 ms before the next one gets the VM (lms2012.c 1777-1786, 2397-2412). A
 * telemetry frame is a direct command in CMD_SLOT, so the user program waits while it runs. How
 * much that costs is a measurement, not an argument: scripts/bench/Bench.lms counts passes of a
 * tight loop for 10 s, and this runs it with telemetry off and at several periods, interleaved,
 * through the shipped objects (UsbTransportProvider, SessionManager, BrickTelemetry, the
 * filesystem layer), and compares the counts.
 *
 * Rule written before the run (step-6 plan, U10 addendum): at the foreground cadences (USB
 * 100 ms, Bluetooth 500 ms) the program loses at most 2 %; at 20 ms at most 10 %.
 *
 *   node scripts/program-load-probe.js [repeats=3] [periods=0,500,100,20]
 *
 * Needs `npm run compile` first and Bench.rbf beside Bench.lms (built with the firmware's
 * assembler: java -jar assembler.jar <path to Bench without extension>).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') { return path.join(REPO, 'src/test/vscodeStub.cjs'); }
	return originalResolve.call(this, request, ...rest);
};

const out = (dir) => path.join(REPO, 'out', dir);
const { ProviderRegistry, UsbTransportProvider } = require(out('transports'));
const { SessionManager } = require(out('runtime/sessionManager'));
const { createBrickTelemetry } = require(out('telemetry/brickTelemetry'));
const { createBrickFilesystem } = require(out('fs/brickFilesystem'));
const { Transport } = require(out('contracts/enums'));

const DIR = '/home/root/lms2012/prjs/Bench';
const PROGRAM = `${DIR}/Bench.rbf`;
const RESULT = `${DIR}/result.txt`;
const RUN_MS = 10000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const repeats = Number(process.argv[2] ?? 3);
const periods = (process.argv[3] ?? '0,500,100,20').split(',').map(Number);

async function main() {
	const image = fs.readFileSync(path.join(__dirname, 'bench', 'Bench.rbf'));
	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider();
	registry.register(usb);
	const scan = await usb.discover();
	if (scan.items.length === 0) { console.error('No USB brick found.'); process.exit(1); }
	const brick = scan.items[0];
	const sessions = new SessionManager({ providerRegistry: registry });
	const results = new Map(periods.map((p) => [p, []]));

	try {
		await sessions.connect(brick.brickKey, Transport.USB, brick.displayName);
		const key = brick.brickKey;
		const brickFs = createBrickFilesystem(sessions, key);
		if (!(await brickFs.files.exists(DIR))) { await brickFs.files.makeDirectory(DIR); }
		await brickFs.transfer.writeFile(PROGRAM, new Uint8Array(image));
		console.log(`Brick ${brick.displayName ?? ''}: Bench.rbf uploaded (${image.length} B).`);

		for (let round = 0; round < repeats; round += 1) {
			for (const period of periods) {
				if (await brickFs.files.exists(RESULT)) { await brickFs.files.remove(RESULT); }
				let telemetry;
				if (period > 0) {
					telemetry = createBrickTelemetry({ sender: sessions, brickKey: key, tickPeriodMs: period });
					telemetry.start();
				}
				const run = await sessions.send(key, { kind: 'program:run', path: PROGRAM });
				if (run.kind !== 'program:run' || run.imageBytes <= 0) { throw new Error('Bench.rbf did not load.'); }
				await wait(RUN_MS + 300);
				for (let i = 0; i < 50; i += 1) {
					const status = await sessions.send(key, { kind: 'program:status' });
					if (status.kind === 'program:status' && !status.running) { break; }
					await wait(100);
				}
				const frames = telemetry ? telemetry.stats.framesSent : 0;
				telemetry?.dispose();
				const text = Buffer.from(await brickFs.transfer.readFile(RESULT)).toString('utf8').trim();
				const count = Number(text);
				results.get(period).push(count);
				console.log(`round ${round + 1}  telemetry ${period ? `${period} ms` : 'off'}`.padEnd(30)
					+ `count ${String(count).padStart(10)}   frames ${frames}`);
			}
		}

		const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
		const base = mean(results.get(0) ?? results.get(periods[0]));
		console.log('\n─── loss against telemetry off ───');
		for (const period of periods) {
			const m = mean(results.get(period));
			const loss = (1 - m / base) * 100;
			console.log(`${period ? `${period} ms` : 'off'}`.padEnd(10)
				+ `mean ${m.toFixed(0).padStart(10)}   loss ${loss.toFixed(2).padStart(6)} %   runs ${results.get(period).join(', ')}`);
		}
	} finally {
		await sessions.disconnect(brick.brickKey).catch(() => {});
		sessions.dispose();
		registry.dispose();
	}
}

main().catch((error) => { console.error(error); process.exit(1); });
