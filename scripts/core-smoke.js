/**
 * Does the cockpit core work in plain Node, with no VS Code at all?
 *
 *   node scripts/core-smoke.js <brick name or id> <usb|bt|tcp> [--wait <seconds>]
 *
 * Builds the runtime and the public API the way the extension does, but in a bare Node process:
 * no `vscode` module, not even a stub. That is how a daemon or a command-line tool will run it.
 * Settings are the defaults package.json declares; the log goes to the console.
 *
 * Then, as a consumer of the API would: waits for the brick to be heard on the named channel, signs
 * in, checks that the route is that channel, reads the brick's name and firmware, its battery and
 * its storage, and disconnects. One line per step. Any failed step, or a route over another
 * channel, ends with a non-zero exit code.
 *
 * Make the named channel the only one the brick can use before running: for USB, Bluetooth off on
 * the brick; for Bluetooth, no cable; for TCP, Bluetooth off and no cable. Only one process may hold
 * a brick, so close VS Code (or disable the cockpit extension) first.
 *
 * Needs a compiled core (npm run compile). Not shipped in the VSIX.
 */

'use strict';

const path = require('path');
const REPO = path.resolve(__dirname, '..');
const core = (dir) => path.join(REPO, 'out', 'core', dir);

const [, , target, channel] = process.argv;
const waitIndex = process.argv.indexOf('--wait');
const WAIT_MS = 1000 * (waitIndex > 0 ? Number(process.argv[waitIndex + 1]) : 90);
const CHANNELS = { usb: 'usb', bt: 'bt', tcp: 'tcp' };

if (!target || !CHANNELS[channel]) {
	console.error('usage: node scripts/core-smoke.js <brick name or id> <usb|bt|tcp> [--wait <seconds>]');
	process.exit(2);
}

const started = Date.now();
const step = (name, detail) => console.log(`${String(Date.now() - started).padStart(6)} ms  ${name}${detail ? `  ${detail}` : ''}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const { createRuntime } = require(core('runtime/createRuntime'));
	const { createCockpitApi } = require(core('api/cockpitApi'));
	const { brickKeyTransport } = require(core('contracts/brickKey'));
	const {
		telemetrySettingsFromPackage, throttleSettingsFromPackage, programPresetSettingsFromPackage,
	} = require(core('telemetry/telemetrySettings'));
	const manifest = require(path.join(REPO, 'package.json'));

	const verbose = process.argv.includes('--verbose');
	const log = {
		info: (message) => { if (verbose) { console.log(`        log  ${message}`); } },
		warn: (message) => console.log(`        warn ${message}`),
		error: (message, error) => console.log(`        error ${message}${error ? `: ${error.message}` : ''}`),
		debug: () => { /* not needed here */ },
	};

	const runtime = createRuntime({
		extensionPath: REPO,
		log,
		startPresence: true,
		telemetrySettings: telemetrySettingsFromPackage(manifest),
		throttleSettings: throttleSettingsFromPackage(manifest),
		programPreset: programPresetSettingsFromPackage(manifest),
	});
	const none = { dispose: () => { /* nothing to release */ } };
	const api = createCockpitApi({
		bricks: runtime.bricks,
		aggregator: runtime.aggregator,
		connect: (brickId) => runtime.bricks.signIn(brickId),
		accessMode: () => 'safe',
		onAccessModeChange: () => none,
		log,
	});
	const consumer = api.registerConsumer('core-smoke');
	let vscodeAvailable = true;
	try { require.resolve('vscode'); } catch { vscodeAvailable = false; }
	const stubLoaded = Object.keys(require.cache).some((k) => k.endsWith('vscodeStub.cjs'));
	step('core built', `vscode resolvable: ${vscodeAvailable}, stub loaded: ${stubLoaded}`);
	if (vscodeAvailable || stubLoaded) { throw new Error('this run would not prove the core runs without VS Code'); }

	let failed = false;
	let brickId;
	try {
		const wanted = target.toLowerCase();
		const deadline = Date.now() + WAIT_MS;
		let brick;
		let lastSeen = '';
		while (Date.now() < deadline) {
			const found = consumer.listBricks().find((b) => b.brickId.toLowerCase() === wanted || b.name.toLowerCase() === wanted);
			const seen = found ? found.channels.map((c) => `${c.transport}:${c.state}`).join(' ') : 'not listed';
			if (seen !== lastSeen) { step('waiting', `${target}: ${seen}`); lastSeen = seen; }
			if (found && found.channels.some((c) => c.transport === channel && c.state === 'available')) { brick = found; break; }
			await wait(1000);
		}
		if (!brick) { throw new Error(`${target} was not heard on ${channel} within ${WAIT_MS / 1000} s`); }
		brickId = brick.brickId;
		step('heard', `${brick.name} [${brickId}] channels ${brick.channels.map((c) => `${c.transport}:${c.state}`).join(' ')}`);

		await consumer.connect(brickId);
		const route = runtime.bricks.routeOf(brickId);
		const over = route ? brickKeyTransport(route) : 'none';
		step('signed in', `route ${over}`);
		if (over !== channel) { throw new Error(`the route is ${over}, not ${channel}: make ${channel} the only channel and run again`); }

		const info = await consumer.getBrickInfo(brickId);
		step('info', `name ${info.name}, firmware ${info.firmwareVersion ?? '?'}`);
		const battery = await runtime.bricks.send(brickId, { kind: 'battery' });
		step('battery', `${battery.level} %${battery.voltage !== undefined ? `, ${battery.voltage} V` : ''}`);
		const storage = await consumer.storage(brickId);
		step('storage', `${storage.freeKb} KB free of ${storage.totalKb} KB`);
	} catch (error) {
		failed = true;
		step('FAILED', error instanceof Error ? error.message : String(error));
	} finally {
		if (brickId && runtime.bricks.isSignedIn(brickId)) {
			await consumer.disconnect(brickId).catch((error) => { failed = true; step('disconnect FAILED', String(error)); });
			step('disconnected');
		}
		consumer.dispose();
		api.dispose();
		runtime.dispose();
	}
	step(failed ? 'RESULT: FAIL' : 'RESULT: OK');
	process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
