/**
 * Checks that the three settings commands actually land on a brick.
 *
 * They were written from the firmware source (`c_com.c`) and their bytecode is pinned by unit
 * tests, but neither of those is the firmware. A wrong subcode or a missing hardware selector
 * fails the same way here: the brick answers OK and changes nothing. So this reads the name
 * back after writing it, which is the only evidence that counts.
 *
 *   node scripts/brick-settings-probe.js <brickName>
 *
 * Renames the brick to <name>-probe, reads it back, then restores the original name. It does
 * not touch Bluetooth: switching the radio off over USB is the harness's job, and doing it
 * here would leave a brick that cannot be reached over BT if the script died halfway.
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
const { Transport } = require(out('contracts/enums'));

const { scanForBricks } = require(out('transports/btPairingHelper'));
const { BT } = require(out('transports/transportConstants'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (process.argv[2] ?? '').toLowerCase();
const btMode = process.argv.includes('--bt');
const HELPER = path.join(REPO, 'native', 'bin', 'bt-pairing-helper.exe');

/**
 * How long a brick keeps answering Bluetooth inquiries after being told to stop.
 *
 * Worth measuring rather than assuming: the presence aggregator's own timeout has to sit
 * above whatever this turns out to be, or a brick that has just gone quiet will be reported
 * as present for a while after it is not.
 */
async function measureBluetoothToggle(sessions, brickKey, mac) {
	// One scan runs across the whole experiment and the radio is toggled underneath it.
	//
	// The first shape of this asked "is the brick in the list" after each toggle, and that
	// question cannot answer this: the watcher's cache pass returns known devices in
	// milliseconds whether or not their radio is on, so a brick with Bluetooth switched off
	// still appears. What does mean something is `deviceLost` — the watcher withdrawing a
	// device it can no longer hear — and that only arrives while a scan is open.
	const want = mac.toLowerCase();
	const events = [];
	const started = Date.now();
	let seen = new Set();

	const scan = scanForBricks({
		helperPath: HELPER,
		ouiFilter: BT.LEGO_OUI,
		inquirySeconds: 120,
		timeoutSeconds: 180,
		onChange: (bricks) => {
			const now = new Set(bricks.map((b) => b.mac.toLowerCase()));
			if (now.has(want) && !seen.has(want)) {
				events.push({ event: 'appeared', atMs: Date.now() - started });
			}
			if (!now.has(want) && seen.has(want)) {
				events.push({ event: 'lost', atMs: Date.now() - started });
			}
			seen = now;
		},
	});

	const settle = async (ms) => { await wait(ms); };

	await settle(8000);
	console.log(`after 8s of scanning, brick present: ${seen.has(want)}`);

	console.log('switching Bluetooth off over USB...');
	await sessions.send(brickKey, { kind: 'brick:setBluetooth', on: false });
	const offAt = Date.now() - started;
	await settle(45000);

	console.log('switching Bluetooth back on...');
	await sessions.send(brickKey, { kind: 'brick:setBluetooth', on: true });
	await sessions.send(brickKey, { kind: 'brick:setBluetoothVisible', visible: true });
	const onAt = Date.now() - started;
	await settle(30000);

	scan.cancel();
	await scan.done;

	console.log(JSON.stringify({ switchedOffAtMs: offAt, switchedOnAtMs: onAt, events }, null, 2));
	const lost = events.find((e) => e.event === 'lost' && e.atMs > offAt);
	console.log(lost
		? `Bluetooth off was observable ${lost.atMs - offAt} ms after the command.`
		: 'The brick never dropped out of the list — either the command did nothing, or the '
			+ 'watcher keeps reporting a device it has stopped hearing.');
}

async function main() {
	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider({ log: { info: () => {}, warn: () => {} } });
	registry.register(usb);
	const sessions = new SessionManager({ providerRegistry: registry });

	const scan = await usb.discover();
	const found = scan.items.find(
		(item) => !target || item.displayName.toLowerCase().includes(target)
	);
	if (!found) {
		console.error(`No USB brick${target ? ` matching "${target}"` : ''}. Seen: `
			+ scan.items.map((i) => i.displayName).join(', ') || '(nothing)');
		process.exitCode = 1;
		return;
	}

	console.log(`Using ${found.displayName} (${found.brickKey})`);
	await sessions.connect(found.brickKey, Transport.USB, found.displayName);

	try {
		if (btMode) {
			// The USB serial and the Bluetooth address are the same bytes spelled differently.
			const hex = found.brickKey.split(':').pop();
			const mac = (hex.match(/../g) ?? []).join(':').toUpperCase();
			await measureBluetoothToggle(sessions, found.brickKey, mac);
			return;
		}

		const before = await sessions.send(found.brickKey, { kind: 'info' });
		console.log(`name before: ${JSON.stringify(before.displayName)}`);

		const probeName = `${before.displayName}-probe`;
		await sessions.send(found.brickKey, { kind: 'brick:setName', name: probeName });
		// The firmware writes a file and calls sethostname before it answers, but the read
		// below is a separate round trip either way; a short settle keeps the check honest
		// rather than racing the write.
		await wait(500);

		const after = await sessions.send(found.brickKey, { kind: 'info' });
		console.log(`name after:  ${JSON.stringify(after.displayName)}`);

		if (after.displayName === probeName) {
			console.log('PASS — the rename reached the brick.');
		} else {
			console.log(`FAIL — expected ${JSON.stringify(probeName)}, brick still says `
				+ `${JSON.stringify(after.displayName)}. The command was accepted and ignored, `
				+ 'which is how a wrong subcode or argument shape fails.');
			process.exitCode = 1;
		}

		await sessions.send(found.brickKey, { kind: 'brick:setName', name: before.displayName });
		await wait(500);
		const restored = await sessions.send(found.brickKey, { kind: 'info' });
		console.log(`name restored to: ${JSON.stringify(restored.displayName)}`);
	} finally {
		await sessions.disconnect(found.brickKey).catch(() => { /* shutting down anyway */ });
		sessions.dispose();
		registry.dispose();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
