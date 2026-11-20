/**
 * Starts a bundled daemon on simulated bricks and checks that it answers the `ev3` command (U15).
 *
 *   node scripts/daemon-smoke.cjs                                   the bundles in out/
 *   node scripts/daemon-smoke.cjs --install-root .vsix-staging/darwin-arm64
 *                                                                   the daemon a staged VSIX carries
 *   node scripts/daemon-smoke.cjs --cli dist/npm/cockpit/out/cli.js another ev3 command
 *
 * The daemon runs on a channel of its own, with its state, key and socket in a temporary home, so
 * neither the user's daemon nor their files are touched. The check is that `ev3 status` reaches
 * this very daemon (its pid) at the installation's version: a command that found nobody would have
 * started a daemon of its own, without simulated bricks. The daemon is stopped at the end.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BUDGET_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function option(args, name) {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

async function main() {
	const args = process.argv.slice(2);
	const installRoot = path.resolve(option(args, '--install-root') ?? REPO);
	const daemonFile = path.join(installRoot, 'out', 'daemon.js');
	const cli = path.resolve(option(args, '--cli') ?? (fs.existsSync(path.join(installRoot, 'out', 'cli.js')) ? path.join(installRoot, 'out', 'cli.js') : path.join(REPO, 'out', 'cli.js')));
	for (const file of [daemonFile, cli, path.join(installRoot, 'package.json')]) {
		if (!fs.existsSync(file)) { throw new Error(`${file} is missing; build first (npm run bundle).`); }
	}
	const version = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8')).version;

	const channel = `ci-smoke-${process.pid}`;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-smoke-'));
	const env = {
		...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, XDG_RUNTIME_DIR: home, HOME: home, USERPROFILE: home,
		EV3_COCKPIT_CHANNEL: channel,
	};
	delete env.ELECTRON_RUN_AS_NODE;
	const ev3 = (...cliArgs) => spawnSync(process.execPath, [cli, ...cliArgs], { env, encoding: 'utf8', timeout: BUDGET_MS });

	const daemon = spawn(process.execPath, [daemonFile, '--install-root', installRoot, '--channel', channel, '--simulated'], {
		env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
	});
	let stderr = '';
	daemon.stderr.on('data', (chunk) => { stderr += String(chunk); });
	let exitCode;
	daemon.once('exit', (code) => { exitCode = code; });
	const logFile = ev3('daemon', 'log').stdout.trim();
	const logTail = () => { try { return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-15).join('\n'); } catch { return '(no log)'; } };

	try {
		// Ready once it says it serves; asking earlier would make the command start a daemon itself.
		const until = Date.now() + BUDGET_MS;
		for (;;) {
			if (exitCode !== undefined) { throw new Error(`The daemon exited with code ${exitCode}.\n${stderr}\n${logTail()}`); }
			if (fs.existsSync(logFile) && /serving on/.test(fs.readFileSync(logFile, 'utf8'))) { break; }
			if (Date.now() > until) { throw new Error(`The daemon did not serve within ${BUDGET_MS / 1000} s.\n${stderr}\n${logTail()}`); }
			await sleep(200);
		}
		const answer = ev3('--json', 'status');
		if (answer.status !== 0) { throw new Error(`ev3 status failed (exit ${answer.status}):\n${answer.stdout}${answer.stderr}`); }
		const status = JSON.parse(answer.stdout);
		if (status.pid !== daemon.pid) { throw new Error(`ev3 status reached pid ${status.pid}, not the daemon started here (${daemon.pid}).`); }
		if (status.version !== version) { throw new Error(`The daemon says version ${status.version}; the installation is ${version}.`); }
		console.log(`Daemon ${status.version} (pid ${status.pid}, Node ${status.runtime.node}) from ${daemonFile} answered ev3 status on channel ${channel}.`);
	} finally {
		if (exitCode === undefined) {
			const exited = new Promise((resolve) => daemon.once('exit', resolve));
			daemon.kill();
			await Promise.race([exited, sleep(5_000)]);
		}
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
