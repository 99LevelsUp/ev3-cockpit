/**
 * Does a brick work through the cockpit daemon, with no VS Code at all?
 *
 *   node scripts/core-smoke.js <brick name or id> <usb|bt|tcp|mock> [--wait <seconds>] [--channel <name>] [--simulated] [--verbose]
 *
 * A client of the daemon, the way the `ev3` command is one: it connects to this user's cockpit
 * daemon through the client library, and when none runs it starts this repository's daemon
 * (`out/daemon/main.js`) with the Node that runs this script. `--channel` talks to a development or
 * test daemon instead (default: `EV3_COCKPIT_CHANNEL`, else the user's own); `--simulated` starts a
 * daemon with simulated bricks only, if this script has to start one. A daemon that already runs is
 * used as it is, and this script never asks it to step aside for a newer build.
 *
 * Then: waits for the brick to be listed with the named channel available, connects it, checks
 * that the named channel is the one connected and no other is, reads the brick's name, firmware
 * and storage, reads the battery through a telemetry subscription (`system.battery.level`), and
 * disconnects. One line per step. Any failed step, or another channel connected, ends with a
 * non-zero exit code. The contract does not name a brick's route; a brick connected over the named
 * channel alone is what this checks instead.
 *
 * Make the named channel the only one the brick can use before running: for USB, Bluetooth off on
 * the brick; for Bluetooth, no cable; for TCP, Bluetooth off and no cable. VS Code may stay open:
 * it is another client of the same daemon. If VS Code (or `ev3 connect`, or a remembered brick)
 * holds the brick already, it stays connected after this script disconnects; the last line says who
 * still holds it.
 *
 * `mock` is the transport of simulated bricks: `--channel t-smoke --simulated` with `Marvin` and
 * `mock` runs the whole sequence without hardware.
 *
 * Needs a compiled tree (npm run compile). Not shipped in the VSIX.
 */

'use strict';

const path = require('path');
const REPO = path.resolve(__dirname, '..');
const out = (...parts) => path.join(REPO, 'out', ...parts);

const argv = process.argv.slice(2);
const option = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !['--wait', '--channel'].includes(argv[i - 1]));
const [target, channel] = positional;
const WAIT_MS = 1000 * Number(option('--wait') ?? 90);
const DAEMON_CHANNEL = option('--channel') ?? (process.env.EV3_COCKPIT_CHANNEL || undefined);
const SIMULATED = argv.includes('--simulated');
const VERBOSE = argv.includes('--verbose');
const CHANNELS = ['usb', 'bt', 'tcp', 'mock'];
const BATTERY_ROW = 'system.battery.level';
const BATTERY_WAIT_MS = 15_000;

if (!target || !CHANNELS.includes(channel) || !Number.isFinite(WAIT_MS)) {
	console.error('usage: node scripts/core-smoke.js <brick name or id> <usb|bt|tcp|mock> [--wait <seconds>] [--channel <name>] [--simulated] [--verbose]');
	process.exit(2);
}

const started = Date.now();
const step = (name, detail) => console.log(`${String(Date.now() - started).padStart(6)} ms  ${name}${detail ? `  ${detail}` : ''}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channels = (brick) => brick.channels.map((c) => `${c.transport}:${c.state}`).join(' ') || 'none';
const describe = (error) => (error && error.code ? `[${error.code}${error.kind && error.kind !== 'Unknown' ? ` ${error.kind}` : ''}] ` : '')
	+ (error instanceof Error ? error.message : String(error));

async function connectClient() {
	const { CockpitClient, WireErrorCode, ContractError } = require(out('client', 'index.js'));
	const { cliLaunch } = require(out('cli', 'main.js'));
	const launch = cliLaunch(out('cli'));
	const options = {
		name: 'core-smoke (terminal)',
		kind: 'cli',
		version: launch.version,
		reconnect: false,
		...(DAEMON_CHANNEL ? { channel: DAEMON_CHANNEL } : {}),
	};
	try {
		// A daemon that runs already is used as it is: without a launch, the client never asks it to
		// make way for this build.
		return { client: await CockpitClient.connect(options), startedDaemon: false };
	} catch (error) {
		if (!(error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable)) { throw error; }
	}
	const launchArgs = [...(DAEMON_CHANNEL ? ['--channel', DAEMON_CHANNEL] : []), ...(SIMULATED ? ['--simulated'] : [])];
	return { client: await CockpitClient.connect({ ...options, launch, launchArgs }), startedDaemon: true };
}

async function main() {
	const { client, startedDaemon } = await connectClient();
	const daemon = client.daemon;
	step('daemon', `${daemon.version}, contract ${daemon.contractVersion}, pid ${daemon.pid}, `
		+ `${startedDaemon ? 'started by this script' : 'already running'}${DAEMON_CHANNEL ? `, channel ${DAEMON_CHANNEL}` : ''}, `
		+ `transports ${daemon.transports.join(' ') || 'none'}`);
	client.onNotice((notice) => step('notice', notice.text));

	let failed = false;
	let brickId;
	let telemetry;
	try {
		const wanted = target.toLowerCase();
		const find = () => client.bricks().find((b) => b.brickId.toLowerCase() === wanted || b.name.toLowerCase() === wanted);
		await client.request('bricks/list', { waitForDiscovery: true });
		const deadline = Date.now() + WAIT_MS;
		let brick;
		let lastSeen = '';
		while (Date.now() < deadline) {
			const found = find();
			const seen = found ? channels(found) : 'not listed';
			if (seen !== lastSeen) { step('waiting', `${target}: ${seen}`); lastSeen = seen; }
			if (found && found.channels.some((c) => c.transport === channel && (c.state === 'available' || c.state === 'connected'))) { brick = found; break; }
			await wait(1000);
		}
		if (!brick) { throw new Error(`${target} was not heard on ${channel} within ${WAIT_MS / 1000} s`); }
		step('heard', `${brick.name} [${brick.brickId}] channels ${channels(brick)}`);

		const connected = await client.request('bricks/connect', { brick: brick.brickId });
		brickId = connected.brickId;
		const over = connected.channels.filter((c) => c.state === 'connected').map((c) => c.transport);
		step('connected', `channels ${channels(connected)}; held by ${connected.holders.map((h) => h.client ?? h.kind).join(', ') || 'nobody'}`);
		if (!over.includes(channel) || over.length > 1) {
			throw new Error(`connected over ${over.join(' and ') || 'nothing'}, not ${channel} alone: make ${channel} the only channel and run again`);
		}

		const info = await client.request('bricks/info', { brick: brickId });
		step('info', `name ${info.name}, firmware ${info.firmwareVersion ?? '?'}${info.osVersion ? `, OS ${info.osVersion}` : ''}`);
		const storage = await client.request('bricks/storage', { brick: brickId });
		step('storage', `${storage.freeKb} KB free of ${storage.totalKb} KB`);

		const rows = await client.request('telemetry/rows', {});
		if (!rows.some((r) => r.id === BATTERY_ROW)) { throw new Error(`the daemon offers no ${BATTERY_ROW} row`); }
		let snapshots = 0;
		let battery;
		const heard = new Promise((resolve) => {
			const timer = setTimeout(() => resolve(undefined), BATTERY_WAIT_MS);
			client.subscribeTelemetry(brickId, { rows: [BATTERY_ROW], intervalMs: 1000 }, (update) => {
				if (update.kind === 'snapshot') { snapshots += 1; }
				if (VERBOSE) { step('telemetry', `${update.kind} ${JSON.stringify(update.values)}`); }
				const value = update.values.find((v) => v.rowId === BATTERY_ROW);
				if (value && typeof value.value === 'number' && !value.stale) { battery = value; clearTimeout(timer); resolve(value); }
			}).then((sub) => { telemetry = sub; }, (error) => { clearTimeout(timer); resolve(error); });
		});
		const result = await heard;
		if (result instanceof Error) { throw result; }
		if (!battery) { throw new Error(`no ${BATTERY_ROW} value within ${BATTERY_WAIT_MS / 1000} s`); }
		step('battery', `${battery.value}${battery.unit ? ` ${battery.unit}` : ''}${VERBOSE ? ` (snapshots heard: ${snapshots})` : ''}`);
	} catch (error) {
		failed = true;
		step('FAILED', describe(error));
	} finally {
		telemetry?.dispose();
		if (brickId) {
			await client.request('bricks/disconnect', { brick: brickId })
				.then((result) => step('disconnected', result.stillHeldBy.length > 0 ? `still held by ${result.stillHeldBy.join(', ')}` : 'nobody holds it now'))
				.catch((error) => { failed = true; step('disconnect FAILED', describe(error)); });
		}
		client.dispose();
	}
	step(failed ? 'RESULT: FAIL' : 'RESULT: OK');
	process.exit(failed ? 1 : 0);
}

main().catch((error) => { step('FAILED', describe(error)); step('RESULT: FAIL'); process.exit(1); });
