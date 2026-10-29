/**
 * Which source tells the truth about a brick's name, and how soon after it changes?
 *
 *   node scripts/name-source-probe.js <brickName>
 *
 * The picker has to show the name that is on the brick, and the cockpit has shown stale names
 * from the Windows cache before. This renames one brick over USB (to <name>x), reads every
 * source the cockpit has, renames it back, and reads them again:
 *
 *   usb-info      `info` over the open USB session -- the brick itself, the reference
 *   usb-discover  the cockpit's USB discovery name (libusb product string, plus the provider's
 *                 own never-cleared memory of names it has read)
 *   usb-fresh     a brand-new USB provider's discovery, so no memory is involved
 *   bt-scan       the pairing helper's scan: Windows' paired-device records and live inquiry
 *   bt-info       `info` over a Bluetooth session
 *   tcp-beacon    the brick's UDP beacon, if it has a Wi-Fi dongle
 *
 * The scan also says whether paired bricks carry a signal strength at all, which decides
 * whether signal can order the list. Only `info` and `brick:setName` go to the brick; the
 * original name is restored in `finally` and read back.
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
	ProviderRegistry, UsbTransportProvider, BtTransportProvider, BtWinsockAdapter, BtConnectionQueue,
	TcpTransportProvider,
} = require(out('transports'));
const { SessionManager } = require(out('runtime/sessionManager'));
const { scanForBricks } = require(out('transports/btPairingHelper'));
const { BT } = require(out('transports/transportConstants'));
const { makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const HELPER = path.join(REPO, 'native', 'bin', 'bt-pairing-helper.exe');
const target = (process.argv[2] ?? '').toLowerCase();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { info: () => {}, warn: () => {} };

async function scanNames(seconds) {
	const seen = new Map();
	const updates = new Map();
	const scan = scanForBricks({
		helperPath: HELPER,
		ouiFilter: BT.LEGO_OUI,
		inquirySeconds: seconds,
		timeoutSeconds: seconds + 30,
		onChange: (bricks) => {
			for (const b of bricks) {
				const key = b.mac.toUpperCase();
				const prev = seen.get(key);
				if (prev && prev.signal !== b.signal) { updates.set(key, (updates.get(key) ?? 0) + 1); }
				seen.set(key, { ...b });
			}
		},
	});
	await scan.done;
	return [...seen.values()].map((b) => ({ ...b, signalUpdates: updates.get(b.mac.toUpperCase()) ?? 0 }));
}

async function tcpNames() {
	const tcp = new TcpTransportProvider({ useDiscovery: true, discoveryTimeoutMs: 6000 });
	try {
		const result = await tcp.discover();
		return result.items.map((i) => `${i.displayName} (${i.brickKey})`);
	} catch (error) {
		return [`discovery failed: ${(error && error.message) || error}`];
	} finally {
		tcp.dispose?.();
	}
}

async function freshUsbName(serialKey) {
	const usb = new UsbTransportProvider({ log: quiet });
	try {
		const result = await usb.discover();
		return result.items.find((i) => i.brickKey === serialKey)?.displayName ?? '(not listed)';
	} finally {
		usb.dispose?.();
	}
}

async function btInfo(mac) {
	const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
	const registry = new ProviderRegistry();
	const bt = new BtTransportProvider({
		backends: new Map([['winsock', (m) => new BtWinsockAdapter({ mac: m })]]),
		connectionQueue: queue,
	});
	registry.register(bt);
	const sessions = new SessionManager({ providerRegistry: registry });
	const key = makeBrickKey(Transport.BT, mac);
	try {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				await sessions.connect(key, Transport.BT, mac);
				const info = await sessions.send(key, { kind: 'info' });
				return `${info.displayName} (attempt ${attempt})`;
			} catch (error) {
				await sessions.disconnect(key).catch(() => {});
				if (attempt === 3) { return `no session: ${(error && error.message) || error}`; }
				await wait(2000);
			}
		}
	} finally {
		await sessions.disconnect(key).catch(() => {});
		sessions.dispose();
		registry.dispose();
		queue.dispose?.();
	}
	return '(unreachable)';
}

async function readAll(label, ctx) {
	console.log(`\n== ${label}`);
	const info = await ctx.sessions.send(ctx.usbKey, { kind: 'info' });
	console.log(`  usb-info      ${info.displayName}`);
	const listed = (await ctx.usb.discover()).items.find((i) => i.brickKey === ctx.usbKey);
	console.log(`  usb-discover  ${listed?.displayName ?? '(skipped: brick has a live USB session)'}`);

	// The fresh provider needs the device free; libusb skips a device another handle holds.
	await ctx.sessions.disconnect(ctx.usbKey);
	console.log(`  usb-fresh     ${await freshUsbName(ctx.usbKey)}`);
	const reopened = (await ctx.usb.discover()).items.find((i) => i.brickKey === ctx.usbKey);
	console.log(`  usb-discover  ${reopened?.displayName ?? '(not listed)'}  (same provider, session closed)`);

	const scanned = await scanNames(20);
	for (const b of scanned) {
		const mark = b.mac.toUpperCase() === ctx.mac ? '  <- this brick' : '';
		console.log(`  bt-scan       ${b.mac} ${JSON.stringify(b.name)} paired=${b.paired} signal=${b.signal} `
			+ `signalUpdates=${b.signalUpdates} firstSeen=${b.atMs}ms${mark}`);
	}
	console.log(`  bt-info       ${await btInfo(ctx.mac)}`);
	for (const line of await tcpNames()) { console.log(`  tcp-beacon    ${line}`); }

	await ctx.sessions.connect(ctx.usbKey, Transport.USB, ctx.name);
	return info.displayName;
}

async function main() {
	const usb = new UsbTransportProvider({ log: quiet });
	const registry = new ProviderRegistry();
	registry.register(usb);
	const sessions = new SessionManager({ providerRegistry: registry });

	const found = (await usb.discover()).items.find((i) => i.displayName.toLowerCase() === target);
	if (!target || !found) {
		console.error('Name a brick on USB.');
		process.exitCode = 1;
		return;
	}
	const hex = found.brickKey.split(':').pop();
	const ctx = {
		usb, sessions, usbKey: found.brickKey, name: found.displayName,
		mac: (hex.match(/../g) ?? []).join(':').toUpperCase(),
	};
	await sessions.connect(ctx.usbKey, Transport.USB, ctx.name);
	const original = (await sessions.send(ctx.usbKey, { kind: 'info' })).displayName;
	const renamed = `${original}x`;
	console.log(`Brick ${original}, MAC ${ctx.mac}. Will rename to ${renamed} and back.`);

	try {
		await readAll(`before -- the brick is called ${original}`, ctx);

		await sessions.send(ctx.usbKey, { kind: 'brick:setName', name: renamed });
		await wait(1000);
		await readAll(`after renaming to ${renamed}`, ctx);
	} finally {
		await sessions.connect(ctx.usbKey, Transport.USB, ctx.name).catch(() => {});
		await sessions.send(ctx.usbKey, { kind: 'brick:setName', name: original }).catch((e) =>
			console.log(`!! restore failed: ${(e && e.message) || e}`));
		await wait(1000);
		const back = await sessions.send(ctx.usbKey, { kind: 'info' }).catch(() => ({ displayName: '?' }));
		console.log(`\nrestored: ${back.displayName}${back.displayName === original ? '' : '  !! NOT RESTORED'}`);
	}

	await readAll(`after renaming back to ${original}`, ctx);
	await sessions.disconnect(ctx.usbKey).catch(() => {});
	sessions.dispose();
	registry.dispose();
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(process.exitCode ?? 0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
