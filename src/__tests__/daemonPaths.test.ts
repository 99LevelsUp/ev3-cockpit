/** Where the daemon's channel, key, state and log go on each system, and its system tools. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_SOCKET_PATH, checkChannelName, daemonPaths } from '../daemon/paths';
import { windowsSystemTool } from '../daemon/systemTools';

describe('daemon paths', () => {
	it('on Windows: a pipe named from the user SID, state under LOCALAPPDATA', () => {
		const p = daemonPaths({
			platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u', userSid: 'S-1-5-21-1-2-3-1001',
		});
		assert.match(p.channel, /^\\\\\.\\pipe\\ev3-cockpit-[0-9a-f]{16}$/);
		assert.equal(p.keyFile, 'C:\\Users\\u\\AppData\\Local\\ev3-cockpit\\key');
		assert.equal(p.logFile, 'C:\\Users\\u\\AppData\\Local\\ev3-cockpit\\logs\\daemon.log');
		assert.equal(p.socketDir, undefined);
	});

	it('gives another user another pipe, and a channel its own pipe and state', () => {
		const base = { platform: 'win32' as const, env: { LOCALAPPDATA: 'C:\\L' }, homedir: 'C:\\h' };
		const a = daemonPaths({ ...base, userSid: 'S-1-5-21-1' });
		const b = daemonPaths({ ...base, userSid: 'S-1-5-21-2' });
		const dev = daemonPaths({ ...base, userSid: 'S-1-5-21-1', channel: 'dev-x' });
		assert.notEqual(a.channel, b.channel);
		assert.equal(dev.channel, `${a.channel}-dev-x`);
		assert.equal(dev.keyFile, a.keyFile);
		assert.notEqual(dev.stateDir, a.stateDir);
		assert.match(dev.logFile, /daemon-dev-x\.log$/);
	});

	it('on Linux with XDG_RUNTIME_DIR: a socket there, state under XDG_STATE_HOME', () => {
		const p = daemonPaths({
			platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000', XDG_STATE_HOME: '/home/u/.st' }, homedir: '/home/u', uid: 1000,
		});
		assert.equal(p.channel, '/run/user/1000/ev3-cockpit/daemon.sock');
		assert.equal(p.socketDir, '/run/user/1000/ev3-cockpit');
		assert.equal(p.stateDir, '/home/u/.st/ev3-cockpit');
	});

	it('on Linux without XDG_RUNTIME_DIR: a socket in /tmp per user, state under ~/.local/state', () => {
		const p = daemonPaths({ platform: 'linux', env: {}, homedir: '/home/u', uid: 1000 });
		assert.equal(p.channel, '/tmp/ev3-cockpit-1000/daemon.sock');
		assert.equal(p.stateDir, '/home/u/.local/state/ev3-cockpit');
	});

	it('on macOS: state under Application Support, logs under Library/Logs', () => {
		const p = daemonPaths({ platform: 'darwin', env: {}, homedir: '/Users/u', uid: 501 });
		assert.equal(p.stateDir, '/Users/u/Library/Application Support/ev3-cockpit');
		assert.equal(p.logFile, '/Users/u/Library/Logs/ev3-cockpit/daemon.log');
		assert.equal(p.channel, '/tmp/ev3-cockpit-501/daemon.sock');
	});

	it('falls back to /tmp when the runtime directory makes the socket path too long', () => {
		const long = `/run/user/1000/${'x'.repeat(90)}`;
		const p = daemonPaths({ platform: 'linux', env: { XDG_RUNTIME_DIR: long }, homedir: '/home/u', uid: 1000, channel: 'dev-abc' });
		assert.ok(Buffer.byteLength(p.channel) <= MAX_SOCKET_PATH);
		assert.equal(p.channel, '/tmp/ev3-cockpit-1000/daemon-dev-abc.sock');
	});

	it('refuses a channel name that could escape its directory', () => {
		assert.throws(() => checkChannelName('../x'));
		assert.throws(() => checkChannelName('Dev'));
		assert.equal(checkChannelName('dev-1'), 'dev-1');
	});

	it('names Windows system tools by their full path, never by bare name', () => {
		const tool = windowsSystemTool('icacls', { SystemRoot: 'C:\\Windows' });
		assert.equal(tool, 'C:\\Windows\\System32\\icacls.exe');
		// No daemon source starts icacls or whoami by its bare name.
		const dir = path.resolve(__dirname, '..', '..', 'src', 'daemon');
		for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
			const text = fs.readFileSync(path.join(dir, file), 'utf8');
			assert.doesNotMatch(text, /spawn(Sync)?\(\s*['"](icacls|whoami)/, `${file} starts a system tool by bare name`);
		}
	});
});
