#!/usr/bin/env node
'use strict';
// Measures whether a cockpit daemon can run on VS Code's own Node.
//
// It starts a VS Code copy from .vscode-test with a throwaway extension. That
// extension spawns a detached child on VS Code's executable with
// ELECTRON_RUN_AS_NODE=1, the way the real extension will start the daemon.
// The child loads the native modules from a copied "extension folder", listens
// on a pipe or socket and writes a heartbeat. The script then closes VS Code and
// checks three things:
//   1. the child keeps running after VS Code is gone;
//   2. the copied extension folder can be renamed while the child runs
//      (what an extension update does);
//   3. the VS Code install folder can be renamed while the child runs
//      (what a VS Code update does).
// It also checks whether two processes can both bind the bricks' UDP beacon
// port, which a second daemon on the same computer would need.
//
// Usage:
//   node scripts/daemon-runtime-check.cjs [--vscode <path to Code.exe or code>]
// Internal:
//   node scripts/daemon-runtime-check.cjs child <work dir>

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const NATIVES = ['usb', 'node-hid', '@serialport/bindings-cpp', 'koffi'];
const BEACON_PORT = 3015;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- child: what the daemon would be -------------------------------------

function runChild(work) {
    const out = path.join(work, 'heartbeat.json');
    const extRoot = path.join(work, 'ext');
    const loaded = {};
    for (const name of NATIVES) {
        try {
            require(require.resolve(name, { paths: [extRoot] }));
            loaded[name] = 'ok';
        } catch (error) {
            loaded[name] = String(error && error.message ? error.message : error).split('\n')[0];
        }
    }
    const channel = process.platform === 'win32'
        ? `\\\\.\\pipe\\ev3-cockpit-runtime-check-${process.pid}`
        : path.join(work, 'runtime-check.sock');
    const server = net.createServer((socket) => socket.end('ok\n'));
    server.listen(channel);
    const started = Date.now();
    const write = () => {
        fs.writeFileSync(out, JSON.stringify({
            pid: process.pid,
            ppid: process.ppid,
            node: process.versions.node,
            electron: process.versions.electron || null,
            modules: process.versions.modules,
            napi: process.versions.napi,
            electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
            execPath: process.execPath,
            channel,
            loaded,
            aliveMs: Date.now() - started,
            at: new Date().toISOString(),
        }, null, 2));
    };
    write();
    const timer = setInterval(write, 500);
    const stopFile = path.join(work, 'stop');
    const watch = setInterval(() => {
        if (fs.existsSync(stopFile)) {
            clearInterval(timer);
            clearInterval(watch);
            server.close();
            process.exit(0);
        }
    }, 200);
}

// --- driver --------------------------------------------------------------

function findVsCode(explicit) {
    if (explicit) return explicit;
    const base = path.join(REPO, '.vscode-test');
    const dirs = fs.existsSync(base)
        ? fs.readdirSync(base).filter((d) => d.startsWith('vscode-')).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }))
        : [];
    for (const dir of dirs.reverse()) {
        const exe = process.platform === 'win32'
            ? path.join(base, dir, 'Code.exe')
            : path.join(base, dir, 'code');
        if (fs.existsSync(exe)) return exe;
    }
    throw new Error('no VS Code copy under .vscode-test; run the host tests once or pass --vscode');
}

function copyNatives(extRoot) {
    const target = path.join(extRoot, 'node_modules');
    fs.mkdirSync(target, { recursive: true });
    const seen = new Set();
    const copy = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        const from = path.join(REPO, 'node_modules', name);
        if (!fs.existsSync(from)) return;
        fs.cpSync(from, path.join(target, name), { recursive: true });
        const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copy(dep);
    };
    for (const name of NATIVES) copy(name);
}

function writeLauncherExtension(dir, work) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'ev3-runtime-check',
        version: '0.0.1',
        publisher: 'check',
        engines: { vscode: '^1.95.0' },
        main: './extension.js',
        activationEvents: ['onStartupFinished'],
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'extension.js'), `
'use strict';
const { spawn } = require('child_process');
const vscode = require('vscode');
exports.activate = function () {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [${JSON.stringify(__filename)}, 'child', ${JSON.stringify(work)}], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
    });
    child.unref();
    // Quit VS Code the way a user does, so whatever VS Code does to its
    // children on exit is what gets measured.
    setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 4000);
};
exports.deactivate = function () {};
`);
}

function readBeat(work) {
    try {
        return JSON.parse(fs.readFileSync(path.join(work, 'heartbeat.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function tryRename(dir) {
    const moved = `${dir}.moved`;
    try {
        fs.renameSync(dir, moved);
    } catch (error) {
        return { renamed: false, error: error.code || String(error) };
    }
    fs.renameSync(moved, dir);
    return { renamed: true };
}

async function closeVsCode(proc) {
    if (process.platform === 'win32') {
        // Without /F taskkill asks the windows to close, as the user would.
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T'], { stdio: 'ignore' });
    } else {
        proc.kill('SIGTERM');
    }
    for (let i = 0; i < 40; i++) {
        if (!alive(proc.pid)) return true;
        await sleep(250);
    }
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        proc.kill('SIGKILL');
    }
    return false;
}

async function checkBeaconPort() {
    const bind = () => new Promise((resolve) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.once('error', (error) => resolve({ socket: undefined, error: error.code || String(error) }));
        socket.bind(BEACON_PORT, () => resolve({ socket }));
    });
    const first = await bind();
    const second = await bind();
    const result = { first: first.socket ? 'bound' : first.error, second: second.socket ? 'bound' : second.error };
    if (first.socket && second.socket) {
        const got = { first: false, second: false };
        first.socket.on('message', () => { got.first = true; });
        second.socket.on('message', () => { got.second = true; });
        const sender = dgram.createSocket('udp4');
        await new Promise((resolve) => sender.bind(0, resolve));
        sender.setBroadcast(true);
        const msg = Buffer.from('Serial-Number: 001653000000\r\nPort: 5555\r\nName: CHECK\r\nProtocol: EV3\r\n');
        sender.send(msg, BEACON_PORT, '255.255.255.255');
        sender.send(msg, BEACON_PORT, '127.0.0.1');
        await sleep(500);
        sender.close();
        result.broadcastReceived = got;
    }
    first.socket?.close();
    second.socket?.close();
    return result;
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === 'child') {
        runChild(args[1]);
        return;
    }
    const vscodeArg = args.indexOf('--vscode');
    const exe = findVsCode(vscodeArg >= 0 ? args[vscodeArg + 1] : undefined);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-runtime-check-'));
    const extRoot = path.join(work, 'ext');
    const launcher = path.join(work, 'launcher');
    copyNatives(extRoot);
    writeLauncherExtension(launcher, work);

    const report = { vscode: exe, platform: `${process.platform}-${process.arch}`, work };
    const code = spawn(exe, [
        '--extensionDevelopmentPath', launcher,
        '--user-data-dir', path.join(work, 'user-data'),
        '--extensions-dir', path.join(work, 'extensions'),
        '--disable-workspace-trust',
        '--skip-welcome',
        '--new-window',
    ], { stdio: 'ignore', detached: false });

    let beat;
    for (let i = 0; i < 120 && !beat; i++) {
        await sleep(500);
        beat = readBeat(work);
    }
    if (!beat) {
        report.error = 'the extension never started the child';
        await closeVsCode(code);
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = 1;
        return;
    }
    report.child = beat;
    // The launcher quits VS Code after a few seconds; wait for that exit.
    let exited = false;
    code.once('exit', () => { exited = true; });
    for (let i = 0; i < 80 && !exited; i++) await sleep(250);
    report.vscodeQuitByCommand = exited;
    if (!exited) report.forcedClose = !(await closeVsCode(code));
    await sleep(5000);
    const after = readBeat(work);
    const childAlive = alive(beat.pid) && !!after && after.aliveMs > beat.aliveMs + 4000;
    report.childAliveAfterClose = childAlive;
    report.childAfter = after && { aliveMs: after.aliveMs, ppid: after.ppid };
    if (childAlive) {
        report.extensionFolderRename = tryRename(extRoot);
        report.vscodeFolderRename = tryRename(path.dirname(exe));
    } else {
        report.renameSkipped = 'the child is not running, so a rename proves nothing';
    }
    report.beaconPort = await checkBeaconPort();
    fs.writeFileSync(path.join(work, 'stop'), '');
    await sleep(1000);
    report.childStopped = !alive(beat.pid);
    console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
