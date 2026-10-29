/**
 * Does telemetry actually interleave with the heartbeat, on a real brick?
 *
 * That is the claim 3.3 makes, and it is not a claim a unit test can settle: the fake
 * senders in the suite have no heartbeat to compete with and no serial link to be starved
 * on. So this drives the *shipped* objects — the real UsbTransportProvider, the real
 * SessionManager with its per-brick CommandQueue, and the real TelemetryService — and reads
 * their own counters afterwards. Nothing here reimplements any of them, which is the whole
 * point: a probe that builds its own frame sender proves something about the probe.
 *
 *   node telemetry-queue-probe.js [seconds]
 */

'use strict';

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
const { TelemetryService } = require(out('telemetry/telemetryService'));
const { TELEMETRY_CADENCE } = require(out('telemetry/telemetryConstants'));
const { Transport } = require(out('contracts/enums'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = Number(process.argv[2] ?? 10);
// Optional override. At a period the link cannot serve, this stops being a cadence check
// and becomes the back-pressure check: the interesting question is not whether telemetry
// runs, but whether it stands down rather than queueing when it out-runs the brick.
const tickOverride = process.argv[3] ? Number(process.argv[3]) : undefined;

async function main() {
	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider();
	registry.register(usb);

	const scan = await usb.discover();
	if (scan.items.length === 0) {
		console.error('No USB brick found. Is one plugged in and switched on?');
		process.exit(1);
	}
	const brick = scan.items[0];
	console.log(`Brick: ${brick.displayName ?? '(unnamed)'}  ${brick.brickKey}`);

	const sessions = new SessionManager({ providerRegistry: registry });
	const values = new Map();
	let errors = 0;
	let lastError;

	// Sampled while telemetry runs. Depth is what tells telemetry apart from a second
	// writer: the scheduler's one-frame-in-flight rule should keep at most one telemetry
	// entry queued, so depth stays at 0 or 1 with the heartbeat's occasional command on top.
	let maxDepth = 0;
	const heartbeatStates = new Set();

	try {
		await sessions.connect(brick.brickKey, Transport.USB, brick.displayName);
		console.log(`Connected. Link carries ${sessions.maxPacketBytes(brick.brickKey)} bytes.`);

		const service = new TelemetryService({
			host: sessions, providerRegistry: registry, tickPeriodMs: tickOverride,
		});
		service.onValues((event) => {
			for (const value of event.values) { values.set(value.rowId, value.value); }
		});
		service.onError((event) => { errors += 1; lastError = event.error; });

		sessions.setActiveBrick(brick.brickKey);
		const loop = service.loopFor(brick.brickKey);
		if (!loop) {
			console.error('No telemetry loop started for the active brick.');
			process.exit(1);
		}
		console.log(`Telemetry running at ${loop.tickPeriodMs} ms `
			+ `(USB cadence ${TELEMETRY_CADENCE[Transport.USB].foregroundMs} ms).`);

		const sampler = setInterval(() => {
			const resources = sessions['sessions'].get(brick.brickKey);
			if (!resources) { return; }
			maxDepth = Math.max(maxDepth, resources.commandQueue.depth);
			heartbeatStates.add(resources.entry.heartbeatState);
		}, 5);

		await wait(seconds * 1000);
		clearInterval(sampler);

		const stats = loop.stats;
		const session = sessions.getSession(brick.brickKey);

		console.log('\n─── after %d s ───', seconds);
		console.log('ticks           %d', stats.ticks);
		console.log('framesSent      %d', stats.framesSent);
		console.log('ticksSkipped    %d  (previous frame still outstanding)', stats.ticksSkipped);
		console.log('ticksEmpty      %d', stats.ticksEmpty);
		console.log('framesFailed    %d', stats.framesFailed);
		console.log('carriedOver     %d', stats.carriedOver);
		console.log('rows with values %d', values.size);
		console.log('max queue depth %d', maxDepth);
		console.log('heartbeat       %s -> %s',
			[...heartbeatStates].join(','), session?.connectionState);
		console.log('service errors  %d%s', errors, lastError ? ` (${lastError})` : '');

		const sample = [...values.entries()].slice(0, 8)
			.map(([id, v]) => `${id}=${typeof v === 'number' ? v.toFixed(2) : v}`);
		console.log('sample          %s', sample.join('  '));

		const verdict = [];
		if (stats.framesSent === 0) { verdict.push('NO FRAMES SENT'); }
		if (stats.framesFailed > 0) { verdict.push(`${stats.framesFailed} FRAMES FAILED`); }
		if (heartbeatStates.has('missed')) { verdict.push('HEARTBEAT MISSED'); }
		if (session?.connectionState !== 'connected') { verdict.push('SESSION NOT CONNECTED'); }
		if (maxDepth > 2) { verdict.push(`QUEUE DEPTH REACHED ${maxDepth}`); }
		console.log('\n%s', verdict.length === 0 ? 'PASS' : `FAIL: ${verdict.join('; ')}`);

		service.dispose();
	} finally {
		await sessions.disconnect(brick.brickKey).catch(() => {});
		sessions.dispose();
		registry.dispose();
	}
}

main().catch((error) => { console.error(error); process.exit(1); });
