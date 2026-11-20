/** Winning the channel, and the key's privacy. */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AlreadyRunningError, ensurePrivateDir, listenOnChannel } from '../daemon/channel';
import { KeyHost, ensureKey, readKey, systemKeyHost } from '../daemon/key';
import { daemonPaths } from '../daemon/paths';
import { currentUserSid } from '../daemon/systemTools';

const unixOnly = process.platform === 'win32' ? 'Unix sockets only' : false;
const windowsOnly = process.platform === 'win32' ? false : 'Windows only';

function tempPaths(name: string) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-chan-'));
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const channel = `t-${name}-${randomBytes(3).toString('hex')}`;
	const paths = daemonPaths({
		platform: process.platform,
		env: { LOCALAPPDATA: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: undefined },
		homedir: home,
		...(uid !== undefined ? { uid } : {}),
		...(process.platform === 'win32' ? { userSid: `S-1-5-21-test-${randomBytes(4).toString('hex')}` } : {}),
		channel,
	});
	// The real /tmp fallback is shared; tests use their own directory under the temp home.
	const socketDir = paths.socketDir ? path.join(home, 'sock') : undefined;
	return {
		home,
		paths: socketDir ? { ...paths, socketDir, channel: path.join(socketDir, 'd.sock') } : paths,
	};
}

describe('winning the channel', () => {
	it('lets exactly one of two daemons started at once serve', async () => {
		const { paths } = tempPaths('two');
		const results = await Promise.allSettled([
			listenOnChannel(paths, (s) => s.end()),
			listenOnChannel(paths, (s) => s.end()),
		]);
		const won = results.filter((r) => r.status === 'fulfilled');
		const lost = results.filter((r) => r.status === 'rejected');
		assert.equal(won.length, 1);
		assert.equal(lost.length, 1);
		assert.ok((lost[0] as PromiseRejectedResult).reason instanceof AlreadyRunningError);
		await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof listenOnChannel>>>).value.close();
	});

	it('replaces a socket a killed daemon left behind, but not a live one', { skip: unixOnly }, async () => {
		const { paths } = tempPaths('stale');
		ensurePrivateDir(paths.socketDir!, { platform: process.platform, uid: process.getuid?.() });
		fs.writeFileSync(paths.channel, '');
		const first = await listenOnChannel(paths, (s) => s.end());
		first.releaseStartLock();
		await assert.rejects(listenOnChannel(paths, (s) => s.end()), AlreadyRunningError);
		await first.close();
	});

	it('refuses a socket directory others can open', { skip: unixOnly }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-wide-'));
		fs.chmodSync(dir, 0o755);
		assert.throws(() => ensurePrivateDir(dir, { platform: process.platform, uid: process.getuid?.() }), /other users/);
	});

	it('refuses a socket directory that belongs to another user', { skip: unixOnly }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-other-'));
		fs.chmodSync(dir, 0o700);
		assert.throws(() => ensurePrivateDir(dir, { platform: process.platform, uid: (process.getuid?.() ?? 0) + 1 }), /another user/);
	});

	it('serves connections once it has won', async () => {
		const { paths } = tempPaths('serve');
		const listening = await listenOnChannel(paths, (socket) => socket.end('hi'));
		const said = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(paths.channel);
			let data = '';
			socket.on('data', (d) => { data += String(d); });
			socket.on('end', () => resolve(data));
			socket.on('error', reject);
		});
		assert.equal(said, 'hi');
		await listening.close();
	});
});

describe('the key', () => {
	it('is created once, 32 bytes, and read back the same', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-key-'));
		const file = path.join(dir, 'k', 'key');
		const first = ensureKey(file);
		const again = ensureKey(file);
		assert.equal(first.length, 32);
		assert.deepEqual(again, first);
	});

	it('is refused when others can read it (Unix mode)', { skip: unixOnly }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-key-'));
		const file = path.join(dir, 'key');
		ensureKey(file);
		fs.chmodSync(file, 0o644);
		assert.throws(() => readKey(file), /can be read by others/);
	});

	it('is refused when another account can read it (Windows ACL)', { skip: windowsOnly }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-key-'));
		const file = path.join(dir, 'key');
		ensureKey(file);
		const host: KeyHost = { ...systemKeyHost(), othersWithAccess: () => ['Everyone'] };
		assert.throws(() => readKey(file, host), /can be read by Everyone/);
		// The real check passes on the file the cockpit made.
		assert.equal(readKey(file).length, 32);
	});

	it('reads the user SID on Windows', { skip: windowsOnly }, () => {
		assert.match(currentUserSid(), /^S-1-5-/);
	});
});
