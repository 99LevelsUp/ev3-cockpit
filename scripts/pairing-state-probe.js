/**
 * Both halves of each brick's Bluetooth pairing, side by side (step-4 plan, U10).
 *
 *   node scripts/pairing-state-probe.js [brickName]                     read only
 *   node scripts/pairing-state-probe.js <brickName> --remove-entry --yes  this computer off the brick
 *   node scripts/pairing-state-probe.js <brickName> --unpair-windows --yes  Windows' pairing off
 *
 * Read only by default. For every brick on USB (or the one whose name contains <brickName>) it
 * prints the brick's own list of paired devices, read over USB with the cockpit's commands,
 * and Windows' side for the same address twice over: the `fRemembered` / `fAuthenticated`
 * flags `BluetoothGetDeviceInfo` reports (what the cockpit's discovery reads), and whether the
 * WinRT paired-device selector lists it (what the pairing helper's bonded lookup reads,
 * `native/bt-pairing-helper/Program.cs` RunAsync). The plan's Definition of Done hangs on
 * whether those two agree. The WinRT read is a watcher on the paired selector, which answers
 * from Windows' records; it issues no inquiry.
 *
 * The two write modes make a one-sided pairing on purpose, one direction each, and need
 * `--yes` and a single brick:
 *   --remove-entry    removes this computer's entry (the radio name) from the brick's list over
 *                     USB and reads the list back; Windows stays paired ("windows-only").
 *   --unpair-windows  removes Windows' pairing with `BluetoothRemoveDevice`, the call the
 *                     cockpit's forget uses; the brick keeps its entry ("brick-only").
 *
 * Run it only while the cockpit is not connected to the brick: both hold the USB device. The
 * brick writes its list to `settings/nonvolbt` only at an orderly VM exit, so a battery pull
 * may bring a removed entry back.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
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
const {
	listBluetoothDevices, readBluetoothRadioName, removeBluetoothDevice,
} = require(out('transports/windowsBluetooth'));

const HELPER = path.join(REPO, 'native', 'bin', 'bt-pairing-helper.exe');
const args = process.argv.slice(2);
const target = (args.find((a) => !a.startsWith('--')) ?? '').toLowerCase();
const removeEntry = args.includes('--remove-entry');
const unpairWindows = args.includes('--unpair-windows');
const confirmed = args.includes('--yes');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The brick's list, names untrimmed, the way `BrickManager.readPeers` reads it. */
async function readPeers(sessions, key) {
	const count = await sessions.send(key, { kind: 'brick:bluetoothPeerCount' });
	const peers = [];
	for (let index = 0; index < count.count; index++) {
		const peer = await sessions.send(key, { kind: 'brick:bluetoothPeer', index });
		peers.push({ name: peer.name, connected: peer.connected, type: peer.type });
	}
	return peers;
}

/** Addresses the WinRT paired selector lists, as the helper's bonded lookup sees them. */
function winrtPaired() {
	const lines = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
	const selectors = lines(execFileSync(HELPER, ['--print-selectors'], { encoding: 'utf8' }));
	const aqs = selectors.find((s) => s.name === 'paired')?.aqs;
	if (!aqs) { throw new Error('The helper printed no paired selector.'); }
	const events = lines(execFileSync(
		HELPER, ['--watch-raw', '--aqs', aqs, '--inquiry-seconds', '3'], { encoding: 'utf8', timeout: 20000 },
	));
	const paired = new Map();
	for (const e of events) {
		if (e.type === 'rawAdded' && e.mac) { paired.set(e.mac.toLowerCase().replace(/[^0-9a-f]/g, ''), e); }
	}
	return paired;
}

function macOf(brickKey) {
	return (brickKey.split(':').pop() ?? '').toLowerCase();
}

async function main() {
	if ((removeEntry || unpairWindows) && (!confirmed || !target || (removeEntry && unpairWindows))) {
		console.error('A write mode needs one brick name, one mode and --yes.');
		process.exitCode = 2;
		return;
	}

	const radioName = readBluetoothRadioName();
	console.log(`this computer's radio name: ${JSON.stringify(radioName)}`);

	const windows = new Map(listBluetoothDevices({ returnUnknown: true }).map((d) => [d.mac, d]));
	let bonded;
	try {
		bonded = winrtPaired();
	} catch (error) {
		console.log(`WinRT paired selector: not read (${error.message})`);
	}

	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider({ log: { info: () => {}, warn: () => {} } });
	registry.register(usb);
	const sessions = new SessionManager({ providerRegistry: registry });

	try {
		const scan = await usb.discover();
		const bricks = scan.items.filter((item) => !target || item.displayName.toLowerCase().includes(target));
		if (bricks.length === 0 || ((removeEntry || unpairWindows) && bricks.length !== 1)) {
			console.error(`Expected ${removeEntry || unpairWindows ? 'exactly one' : 'a'} USB brick`
				+ `${target ? ` matching "${target}"` : ''}. Seen: ${scan.items.map((i) => i.displayName).join(', ') || '(nothing)'}`);
			process.exitCode = 1;
			return;
		}

		for (const brick of bricks) {
			const mac = macOf(brick.brickKey);
			console.log(`\n=== ${brick.displayName}  ${mac}`);
			await sessions.connect(brick.brickKey, Transport.USB, brick.displayName);
			try {
				let peers = await readPeers(sessions, brick.brickKey);
				const onBrick = radioName !== undefined && peers.some((p) => p.name === radioName);
				console.log(`brick's list (${peers.length}): ${JSON.stringify(peers)}`);

				const w = windows.get(mac);
				const remembered = w?.remembered === true;
				console.log(`Windows (BluetoothGetDeviceInfo): ${w
					? `remembered=${w.remembered} authenticated=${w.authenticated} connected=${w.connected} name=${JSON.stringify(w.name)}`
					: 'not listed'}`);
				const inWinrt = bonded ? bonded.has(mac) : undefined;
				console.log(`Windows (WinRT paired selector): ${inWinrt === undefined ? 'not read' : inWinrt}`);
				if (inWinrt !== undefined && inWinrt !== remembered) {
					console.log('  DISAGREE: fRemembered and the bonded lookup differ (plan Definition of Done).');
				}
				const state = remembered === onBrick
					? (onBrick ? 'paired on both sides' : 'paired on neither side')
					: (remembered ? 'ONE-SIDED windows-only' : 'ONE-SIDED brick-only');
				console.log(`verdict (fRemembered vs. this computer's entry): ${state}`);

				if (removeEntry) {
					if (!radioName || !onBrick) {
						console.log('nothing to remove: the brick does not list this computer\'s radio name.');
					} else {
						await sessions.send(brick.brickKey, { kind: 'brick:removeBluetoothPeer', name: radioName });
						await wait(500);
						peers = await readPeers(sessions, brick.brickKey);
						console.log(`after removal (${peers.length}): ${JSON.stringify(peers)}`);
						console.log(peers.some((p) => p.name === radioName)
							? 'FAIL: the list read back still holds the entry.'
							: 'removed: the list read back no longer holds this computer.');
					}
				}
			} finally {
				await sessions.disconnect(brick.brickKey).catch(() => { /* shutting down anyway */ });
			}

			if (unpairWindows) {
				const result = removeBluetoothDevice(mac);
				console.log(`BluetoothRemoveDevice(${mac}): ${result.ok ? 'ok' : `failed: ${result.reason}`}`);
				const after = listBluetoothDevices({ returnUnknown: true }).find((d) => d.mac === mac);
				console.log(`Windows after: ${after ? `remembered=${after.remembered} authenticated=${after.authenticated}` : 'not listed'}`);
			}
		}
	} finally {
		sessions.dispose();
		registry.dispose();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
