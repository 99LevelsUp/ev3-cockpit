/**
 * Starts a native daemon as an installed client would and checks that it serves a recorded brick.
 *
 *   node scripts/daemon-smoke.cjs                                   the development build
 *                                                                   (npm run daemon:build)
 *   node scripts/daemon-smoke.cjs --daemon-dir .vsix-staging/linux-x64
 *                                                                   the daemon a staged VSIX or npm
 *                                                                   platform package carries
 *   node scripts/daemon-smoke.cjs --scenario <name>                 another recording of daemon/fixtures/link
 *
 * It needs the compiled client library (`npm run compile`). The client takes the daemon from the
 * folder's manifest (`packagedDaemon`), so it copies the binary into a private folder, checks the
 * copy's SHA-256 and starts that copy: what an installed extension or `ev3` command does. The daemon
 * runs on a test channel of its own with its state root in a temporary home, in matched replay of a
 * recording of brick AAA, so neither the user's daemon, their files nor any hardware is touched.
 *
 * The checks: the daemon reports the package.json version, the build kind and SHA-256 its manifest
 * records and the client's contract version; it connects AAA from the recording, and its status
 * lists it. The daemon is stopped at the end.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BUDGET_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function option(args, name) {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

function check(condition, message) {
	if (!condition) { throw new Error(message); }
}

async function main() {
	const args = process.argv.slice(2);
	const compiled = path.join(REPO, 'out', 'client', 'index.js');
	check(fs.existsSync(compiled), `${compiled} is missing; compile first (npm run compile).`);
	const client = require(compiled);
	const { readChannelRecord } = require(path.join(REPO, 'out', 'client', 'channel.js'));

	const daemonDir = option(args, '--daemon-dir');
	const launch = daemonDir ? client.packagedDaemon(path.resolve(daemonDir)) : client.developmentDaemon(REPO);
	const scenario = option(args, '--scenario') ?? 'usb-connect-commands-aaa';
	const fixtures = path.join(REPO, 'daemon', 'fixtures', 'link', scenario);
	check(fs.existsSync(fixtures), `${fixtures} is missing.`);
	const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
	check(launch.version === version, `The manifest of ${launch.binary} records version ${launch.version}; package.json is ${version}.`);

	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-smoke-'));
	const stateRoot = client.nativeStateRoot({ env: { LOCALAPPDATA: home, XDG_STATE_HOME: home }, homedir: home });
	const channel = `smoke-${process.pid}`;
	const files = client.nativeChannelFiles(stateRoot, channel);
	let cockpit;
	try {
		cockpit = await client.NativeCockpitClient.connect({
			name: 'daemon smoke', kind: 'cli', version, buildKind: launch.buildKind, daemon: launch,
			channel, stateRoot, daemonArgs: ['--mode', 'replay', '--fixtures', fixtures], reconnect: false,
		});
		const daemon = cockpit.daemon;
		check(daemon.version === version, `The daemon reports version ${daemon.version}; package.json is ${version}.`);
		check(daemon.buildKind === launch.buildKind, `The daemon reports a ${daemon.buildKind} build; its manifest records ${launch.buildKind}.`);
		check(daemon.buildId === launch.sha256, `The daemon's build id is ${daemon.buildId}; its manifest records SHA-256 ${launch.sha256}.`);
		check(daemon.contractVersion === client.nativeContract.CONTRACT_VERSION,
			`The daemon speaks contract ${daemon.contractVersion}; the client ${client.nativeContract.CONTRACT_VERSION}.`);
		check(daemon.mode === 'replay', `The daemon runs in ${daemon.mode} mode, not replay.`);

		// By its id: before it connects, a brick may carry its USB descriptor's name, not its own.
		let usb;
		for (const until = Date.now() + BUDGET_MS; !usb; await sleep(200)) {
			const { bricks } = await cockpit.request('bricks/list', {});
			usb = bricks.find((b) => b.channels.some((c) => c.transport === 'usb'));
			check(usb || Date.now() < until, `No USB brick appeared within ${BUDGET_MS / 1000} s.`);
		}
		const brick = await cockpit.request('bricks/connect', { brick: usb.brickId });
		check(brick.connected === true, `${usb.brickId} did not connect: ${JSON.stringify(brick)}`);
		const status = await cockpit.request('daemon/status', {});
		check(status.bricks.some((b) => b.name === 'AAA'), `The daemon's status does not list AAA: ${JSON.stringify(status.bricks)}`);
		console.log(`Daemon ${daemon.version} (${daemon.buildKind}, SHA-256 ${daemon.buildId}, pid ${daemon.pid}) from ${launch.binary} served AAA from ${scenario} on channel ${channel}.`);
	} catch (error) {
		// The log names the exchange a replay could not match, which is how a stale recording shows.
		try {
			const log = fs.readFileSync(path.join(files.dir, 'daemon.log'), 'utf8').trimEnd().split('\n').slice(-20).join('\n');
			console.error(`The end of the daemon's log:\n${log}`);
		} catch { /* no log */ }
		throw error;
	} finally {
		if (cockpit) { cockpit.dispose(); }
		const until = Date.now() + 5_000;
		while (Date.now() < until) {
			let pid;
			try { pid = readChannelRecord(fs.readFileSync(files.channelFile, 'utf8'))?.pid; } catch { /* none */ }
			if (pid === undefined) { break; }
			try { process.kill(pid); } catch { /* gone */ }
			try { fs.rmSync(files.channelFile, { force: true }); } catch { /* the daemon may still hold it */ }
			await sleep(200);
		}
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	}
}

const timer = setTimeout(() => { console.error(`The smoke did not finish within ${BUDGET_MS / 1000} s.`); process.exit(1); }, BUDGET_MS * 2);
timer.unref();
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
