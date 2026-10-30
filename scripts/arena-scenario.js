/**
 * The step-2 success criteria on the bench, through the shipped runtime (step-2 plan, U10).
 *
 *   node scripts/arena-scenario.js --brick CCC --phase arena|transfer|rename|presence
 *
 * Builds the runtime with createRuntime, exactly as the extension does (KTD9), and drives the
 * brick layer. Needs the owner at the bricks; cues come from the PC speaker and the log:
 *
 *   arena     USB and Bluetooth up, a command every 300 ms. Three high beeps: pull the cable.
 *             Traffic must move to Bluetooth with at most one failed command. One long low beep:
 *             plug it back in. Traffic must return to USB.
 *   transfer  USB and Bluetooth up: a 64 KB file written and read back while the telemetry
 *             loop runs. Nothing may freeze; the file is deleted afterwards.
 *   rename    Renames the brick and back; the list must show each name once the brick
 *             confirms it, without reconnecting.
 *   presence  The brick signed out, background presence on. Three high beeps: switch Bluetooth
 *             off on the brick. It must turn "not heard". One long low beep: switch it back on.
 *             It must turn available again. Takes minutes: checks run once a minute.
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
const { createRuntime } = require(out('runtime/createRuntime'));
const { createBrickFilesystem } = require(out('fs/brickFilesystem'));
const { TelemetryService } = require(out('telemetry/telemetryService'));
const { ChannelState, Transport } = require(out('contracts/enums'));

const argAfter = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BRICK = argAfter('--brick', 'CCC').toUpperCase();
const PHASE = argAfter('--phase', 'arena');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const log = (line) => console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(7)} s  ${line}`);
// Session and route changes are what the scenario is about; the rest of the runtime's log is noise here.
const quiet = {
	info: (m) => { if (/^(Session|Route|Bluetooth presence)/.test(m)) { log(m); } },
	warn: (m) => log(`warn: ${m}`), error: (m) => log(`error: ${m}`), debug: () => {},
};

function beep(pattern) {
	const script = pattern.map(([hz, ms]) => `[console]::beep(${hz},${ms})`).join(';');
	spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
}
const CUE_GO = [[1500, 150], [1500, 150], [1500, 150]];
const CUE_BACK = [[600, 900]];

async function until(predicate, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) { throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`); }
		await wait(100);
	}
}

const channelOf = (runtime, id, transport) =>
	runtime.aggregator.getBrick(id)?.channels.find((c) => c.transport === transport);

async function findBrick(runtime) {
	let found;
	await until(() => {
		found = runtime.aggregator.getDiscoveryList().find((b) => b.name.value.toUpperCase() === BRICK);
		return Boolean(found);
	}, 60000, `${BRICK} in the discovery list`);
	return found.brickId;
}

async function signInBoth(runtime, id) {
	if (channelOf(runtime, id, Transport.USB)?.state === ChannelState.Connected
		&& channelOf(runtime, id, Transport.BT)?.state === ChannelState.Connected) { return; }
	await until(() => channelOf(runtime, id, Transport.USB)?.state === ChannelState.Available
		&& channelOf(runtime, id, Transport.BT)?.state === ChannelState.Available, 60000, 'USB and BT available');
	await runtime.bricks.signIn(id);
	await until(() => channelOf(runtime, id, Transport.USB)?.state === ChannelState.Connected
		&& channelOf(runtime, id, Transport.BT)?.state === ChannelState.Connected, 240000, 'USB and BT both connected');
	log(`signed in over USB and BT; route ${runtime.bricks.routeOf(id)}`);
}

async function arena(runtime, id) {
	await signInBoth(runtime, id);
	const results = [];
	let running = true;
	const loop = (async () => {
		while (running) {
			const at = Date.now();
			const route = runtime.bricks.routeOf(id);
			try {
				await runtime.bricks.send(id, { kind: 'battery' });
				results.push({ at, ok: true, route });
			} catch (error) {
				results.push({ at, ok: false, route, error: String(error && error.message || error) });
				log(`command FAILED on ${route}: ${error && error.message || error}`);
			}
			await wait(300);
		}
	})();

	await wait(3000);
	log('>>> PULL THE USB CABLE now (three high beeps)');
	beep(CUE_GO);
	const cuedOut = Date.now();
	await until(() => (runtime.bricks.routeOf(id) ?? '').startsWith('bt:'), 180000, 'traffic on Bluetooth');
	const firstFail = results.find((r) => r.at >= cuedOut && !r.ok);
	await wait(1500);
	const firstBt = results.find((r) => r.at >= cuedOut && r.ok && (r.route ?? '').startsWith('bt:'));
	const failsOut = results.filter((r) => r.at >= cuedOut && !r.ok).length;
	log(`on Bluetooth: ${failsOut} failed command(s); first failure to first Bluetooth answer `
		+ `${firstFail && firstBt ? firstBt.at - firstFail.at : '?'} ms`);

	await wait(10000);
	log('>>> PLUG THE USB CABLE back in now (one long low beep)');
	beep(CUE_BACK);
	const cuedIn = Date.now();
	await until(() => channelOf(runtime, id, Transport.USB)?.state !== ChannelState.Lost, 180000, 'USB seen again');
	const usbSeen = Date.now();
	await until(() => (runtime.bricks.routeOf(id) ?? '').startsWith('usb:'), 60000, 'traffic back on USB');
	const backOnUsb = Date.now();
	await wait(3000);
	running = false;
	await loop;
	const failsIn = results.filter((r) => r.at >= cuedIn && !r.ok).length;
	log(`back on USB ${backOnUsb - usbSeen} ms after USB was seen again; ${failsIn} failed command(s) on the way back`);
	log(`SUMMARY arena: ${results.length} commands, ${results.filter((r) => !r.ok).length} failed `
		+ `(out: ${failsOut}, in: ${failsIn})`);
}

async function transfer(runtime, id) {
	await signInBoth(runtime, id);
	const telemetry = new TelemetryService({ host: runtime.bricks.telemetryHost(), providerRegistry: runtime.registry });
	let frames = 0;
	let frameErrors = 0;
	telemetry.onValues(() => { frames += 1; });
	telemetry.onError(() => { frameErrors += 1; });
	try {
		const fs = createBrickFilesystem(runtime.bricks, id);
		const file = new Uint8Array(64 * 1024).map((_, i) => (i * 7) & 0xff);
		const target = '/home/root/lms2012/prjs/arena-test.bin';
		const started = Date.now();
		await fs.transfer.writeFile(target, file);
		const back = await fs.transfer.readFile(target);
		const same = back.length === file.length && back.every((b, i) => b === file[i]);
		log(`64 KB written and read back over ${runtime.bricks.routeOf(id)} in ${Date.now() - started} ms; `
			+ `identical: ${same}; telemetry frames meanwhile: ${frames}, frame errors: ${frameErrors}`);
		await fs.files.remove(target);
		await runtime.bricks.send(id, { kind: 'battery' });
		log(`SUMMARY transfer: identical ${same}, ${frames} frames, ${frameErrors} frame errors, brick still answering`);
	} finally {
		telemetry.dispose();
	}
}

async function rename(runtime, id) {
	await signInBoth(runtime, id);
	const original = runtime.aggregator.getBrick(id).name.value;
	for (const name of ['ArenaTest', original]) {
		const at = Date.now();
		await runtime.bricks.send(id, { kind: 'brick:setName', name });
		await until(() => runtime.aggregator.getBrick(id)?.name.value === name, 20000, `name ${name}`);
		log(`list shows ${name} ${Date.now() - at} ms after the rename (confirmed: ${runtime.aggregator.getBrick(id).name.confirmed})`);
	}
	log('SUMMARY rename: both names shown without reconnecting');
}

async function presence(runtime, id) {
	if (runtime.bricks.isSignedIn(id)) { await runtime.bricks.signOut(id); }
	const bt = () => channelOf(runtime, id, Transport.BT)?.state;
	await until(() => bt() === ChannelState.Available, 120000, 'BT available');
	log('>>> SWITCH BLUETOOTH OFF on the brick now (three high beeps); expect "not heard" within ~4 min');
	beep(CUE_GO);
	const off = Date.now();
	await until(() => bt() === ChannelState.Lost, 420000, 'BT not heard');
	log(`not heard ${Math.round((Date.now() - off) / 1000)} s after the cue`);
	log('>>> SWITCH BLUETOOTH ON again now (one long low beep); expect available within ~1-2 min');
	beep(CUE_BACK);
	const on = Date.now();
	await until(() => bt() === ChannelState.Available, 240000, 'BT heard again');
	log(`SUMMARY presence: not heard after off, available ${Math.round((Date.now() - on) / 1000)} s after back on`);
}

async function main() {
	// Presence on, as in the extension: a Bluetooth join that fails waits for a presence answer.
	const runtime = createRuntime({ extensionPath: REPO, log: quiet, startPresence: true });
	try {
		const id = await findBrick(runtime);
		log(`${BRICK} is ${id}; phase ${PHASE}`);
		const phases = { arena, transfer, rename, presence };
		// Several phases run in one process, as in the extension: the provider's 5 s gap after a
		// Bluetooth close lives in the process, and a fresh process reconnecting seconds after
		// the last one closed is the too-soon reconnect that locks a brick out for minutes (D3).
		for (const phase of PHASE.split(',')) {
			if (!phases[phase]) { throw new Error(`unknown phase ${phase}`); }
			log(`--- phase ${phase}`);
			await phases[phase](runtime, id);
		}
		if (runtime.bricks.isSignedIn(id)) { await runtime.bricks.signOut(id); }
	} finally {
		runtime.dispose();
	}
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); log('done'); process.exit(0); },
	(error) => { clearInterval(keepAlive); log(`FAILED: ${error && error.message || error}`); process.exit(1); },
);
