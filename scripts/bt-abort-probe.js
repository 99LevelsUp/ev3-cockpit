/**
 * Does an abortive close cancel a pending RFCOMM connect, and does the stuck state clear with
 * time? (Follow-up to scripts/bt-threadpool-probe.js, 29.10.2026.)
 *
 *   node scripts/bt-abort-probe.js <MAC> [--graceful]
 *
 * With the non-blocking connect, a process no longer hangs, but after four abandoned connects
 * Windows answers every further connect in that process with WSA 10048. This replays the same
 * trigger (reconnect with no gap after a clean close) through the cockpit's own Winsock
 * bindings, and abandons a connect at its 15 s deadline either with SO_LINGER {1, 0} before
 * closesocket (default) or with a plain closesocket (--graceful). After the attempts it waits
 * 60 s and 120 s and tries once more each time. Only connects; nothing is sent to the brick.
 */

'use strict';

const path = require('path');
const REPO = path.resolve(__dirname, '..');
const out = (dir) => path.join(REPO, 'out', dir);
const W = require(out('transports/windowsWinsock'));
const koffi = require('koffi');

const mac = (process.argv[2] ?? '').toUpperCase();
const graceful = process.argv.includes('--graceful');
const DEADLINE_MS = 15000;
const ATTEMPTS = 10;
const SOL_SOCKET = 0xffff;
const SO_LINGER = 0x0080;

const api = W.loadWinsock2();
const lib = koffi.load('ws2_32.dll');
const setsockopt = lib.func('int __stdcall setsockopt(uintptr, int, int, const uint16*, int)');
const t0 = Date.now();
const log = (line) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${line}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abandon(socket) {
	if (!graceful) { setsockopt(socket, SOL_SOCKET, SO_LINGER, [1, 0], 4); }
	api.closesocket(socket);
}

async function attempt() {
	const at = Date.now();
	const socket = api.socket(W.AF_BTH, W.SOCK_STREAM, W.BTHPROTO_RFCOMM);
	api.setNonBlocking(socket, true);
	const started = api.connect(socket, {
		addressFamily: W.AF_BTH, btAddr: W.macToBtAddr(mac), serviceClassId: new Uint8Array(16), port: W.EV3_RFCOMM_CHANNEL,
	});
	if (started === W.SOCKET_ERROR) {
		const code = api.lastError();
		if (code !== W.WSAEWOULDBLOCK) { api.closesocket(socket); return `FAIL ${Date.now() - at} ms WSA ${code}`; }
		for (;;) {
			const state = api.connectState(socket);
			if (state === 'connected') { break; }
			if (state === 'failed') {
				const code2 = api.socketError(socket);
				api.closesocket(socket);
				return `FAIL ${Date.now() - at} ms WSA ${code2}`;
			}
			if (Date.now() - at >= DEADLINE_MS) { abandon(socket); return `TIMEOUT ${Date.now() - at} ms (${graceful ? 'plain close' : 'abortive close'})`; }
			await wait(50);
		}
	}
	api.closesocket(socket);
	return `open ${Date.now() - at} ms`;
}

async function main() {
	log(`${mac}, ${graceful ? 'plain closesocket' : 'SO_LINGER {1,0} then closesocket'} on abandon`);
	for (let n = 1; n <= ATTEMPTS; n += 1) { log(`attempt ${n}: ${await attempt()}`); }
	for (const pause of [60, 120]) {
		await wait(pause * 1000);
		log(`after another ${pause} s: ${await attempt()}`);
	}
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
