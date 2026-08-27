/**
 * Watches one brick through the session layer while a person does something physical to it.
 *
 * The matrix covers what can be checked without anyone touching the hardware. This covers
 * what cannot: powering a brick off, unplugging a cable, walking out of Bluetooth range.
 * Those are ordinary events for this product and none of them can be simulated honestly — a
 * mock that goes away goes away politely, and the failures worth catching are the impolite
 * ones, where a handle stays open and the OS keeps answering for a device that has gone.
 *
 * It drives `SessionManager`, not a transport provider directly. A first version watched the
 * provider, and it answered only half the question: it saw a power-off instantly and
 * precisely (`LIBUSB_TRANSFER_NO_DEVICE`), and then reported the brick as still gone after it
 * had booted again — because reconnect lives in the session layer, and nothing was driving
 * it. Watching a layer below the one that owns recovery cannot show recovery.
 *
 *   node scripts/hardware-scenario.js watch <brickName> [--seconds 900]
 *
 * Run it, then do the physical thing. It prints state changes as they happen.
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
const {
	ProviderRegistry, UsbTransportProvider, TcpTransportProvider, BtTransportProvider,
	BtSppBackend,
} = require(out('transports'));
const { SessionManager } = require(out('runtime/sessionManager'));
const { DiscoveryScheduler } = require(out('runtime/discoveryScheduler'));
const { Transport, PresenceState } = require(out('contracts/enums'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: { info: () => {}, warn: () => {} } };

const args = process.argv.slice(2);
const target = (args[1] ?? '').toLowerCase();
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 900;

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const say = (msg) => process.stdout.write(`${stamp()}  ${msg}\n`);

/**
 * Asks the brick for something small, through the session's own queue.
 *
 * Going through `SessionManager.send` rather than the provider is the point: the command
 * shares the queue with the heartbeat, so a probe cannot pass while the session that is
 * supposed to be managing the link has already given up on it.
 */
async function probe(sessions, key) {
	try {
		const response = await sessions.send(key, { kind: 'battery' }, { timeoutMs: 3000 });
		return { alive: true, detail: `battery ${response.level}%` };
	} catch (error) {
		return { alive: false, detail: error?.message || String(error) };
	}
}

async function findBrick(providers, name) {
	for (const { label, provider, transport } of providers) {
		let scan = { items: [] };
		try { scan = await provider.discover(); } catch { /* transport down */ }
		const item = scan.items.find((i) => i.displayName.toLowerCase().includes(name)
			|| i.brickKey.toLowerCase().includes(name));
		if (item) { return { label, provider, item, transport }; }
	}
	return undefined;
}

async function main() {
	if (args[0] !== 'watch' || !target) {
		process.stdout.write('usage: node scripts/hardware-scenario.js watch <brickName> '
			+ '[--seconds 900]\n');
		return 2;
	}

	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider(quiet);
	const tcp = new TcpTransportProvider(quiet);
	const btBackend = new BtSppBackend();
	const bt = new BtTransportProvider({
		discoverDevices: btBackend.discover,
		backends: new Map([['spp', btBackend.adapterFor]]),
	});
	registry.register(usb); registry.register(tcp); registry.register(bt);

	const sessions = new SessionManager({ providerRegistry: registry });

	// The session layer's own account of what is happening, which is the thing under test.
	sessions.onSessionStateChange((event) => {
		say(`session: ${event.previousState} -> ${event.newState}`);
	});

	// Discovery has to be running, exactly as it is in the extension. Without it a scenario
	// measures a session with no idea whether its brick is back — which is what the first
	// power-cycle run did, and it made an 80-second wait look like the design rather than
	// like a missing wire.
	const scheduler = new DiscoveryScheduler(registry);
	scheduler.onPresenceChanged((event) => {
		say(`presence: ${event.item.displayName} ${event.previousState ?? 'new'} -> ${event.currentState}`);
		if (event.currentState === PresenceState.Available) {
			sessions.notifyBrickAvailable(event.brickKey);
		}
	});

	try {
		const found = await findBrick([
			{ label: 'USB', provider: usb, transport: Transport.USB },
			{ label: 'TCP', provider: tcp, transport: Transport.TCP },
			{ label: 'BT ', provider: bt, transport: Transport.BT },
		], target);

		if (!found) {
			process.stdout.write(`no brick matching "${target}" on any transport\n`);
			return 1;
		}

		const { label, item, transport } = found;
		say(`found ${item.displayName} on ${label}`);
		await sessions.connect(item.brickKey, transport, item.displayName);
		scheduler.start();
		say('connected, discovery running. watching — do the physical thing now.');

		let lastAlive = null;
		let lastChangeAt = Date.now();
		const timeline = [];

		while (Date.now() - started < seconds * 1000) {
			const result = await probe(sessions, item.brickKey);
			if (result.alive !== lastAlive) {
				const heldFor = (Date.now() - lastChangeAt) / 1000;
				if (lastAlive === null) {
					say(`link: ${result.alive ? 'answering' : 'not answering'} — ${result.detail}`);
				} else {
					timeline.push({ to: result.alive, atMs: Date.now() - started, heldFor });
					say(`link: ${result.alive ? 'ANSWERING again' : 'STOPPED answering'}`
						+ `  (previous state held ${heldFor.toFixed(1)} s)`);
					say(`      ${result.detail}`);
				}
				lastAlive = result.alive;
				lastChangeAt = Date.now();
			}
			await wait(400);
		}

		process.stdout.write('\n-- timeline --\n');
		if (!timeline.length) { process.stdout.write('  no state change observed\n'); }
		for (const t of timeline) {
			process.stdout.write(`  ${(t.atMs / 1000).toFixed(1)}s  `
				+ `${t.to ? 'came back' : 'went away'} after ${t.heldFor.toFixed(1)} s\n`);
		}
		return 0;
	} finally {
		scheduler.dispose();
		sessions.dispose();
		usb.dispose(); tcp.dispose(); bt.dispose(); registry.dispose();
	}
}

main().then((code) => process.exit(code ?? 0), (e) => { console.error(e); process.exit(1); });
