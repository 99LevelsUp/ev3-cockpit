/**
 * What the cockpit sees when a brick arrives in each of the states a real one arrives in.
 *
 * The scenarios come from the owner's own description of the product's job: someone walks up
 * with a brick and picks it by name. Whether that works depends on what the host already
 * knows about the brick, and there are more answers than "paired or not":
 *
 *   fresh        Windows has no record at all — no pairing, no name cache entry.
 *   known        Seen before and still paired.
 *   unpaired     Seen before, pairing removed, the OS name cache still remembers it.
 *   returning    Paired, went out of range (radio off), came back.
 *   renamed      Any of the above with a new name on the same address.
 *
 * The `fresh` case cannot be produced from code: `BluetoothRemoveDevice` leaves the record
 * under `BTHPORT\Parameters\Devices` behind, and deleting that is a manual step on a key
 * `SYSTEM` owns. So this script *checks* for it and says plainly whether the state it is
 * about to measure is really fresh, rather than mislabelling a warm cache as a cold one.
 *
 * USB is the control channel. Both radios are connected at once, so the brick can be renamed
 * and have its Bluetooth switched on and off over the cable while Bluetooth is what is being
 * observed — no waiting for someone to press buttons, except for the pairing dialog, which
 * only a person at the brick can answer.
 *
 *   node scripts/bt-scenario-matrix.js [--only fresh,known,...] [--brick ccc]
 *
 * Writes one JSON line per cell to .review-out/bt-scenario-matrix.jsonl and a table to stdout.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const readline = require('readline');

const REPO = path.resolve(__dirname, '..');
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') { return path.join(REPO, 'src/test/vscodeStub.cjs'); }
	return originalResolve.call(this, request, ...rest);
};

const out = (dir) => path.join(REPO, 'out', dir);
const { ProviderRegistry, UsbTransportProvider, BtClassicDiscovery } = require(out('transports'));
const { scanForBricks, createHelperPairing } = require(out('transports/btPairingHelper'));
const { removeBluetoothDevice } = require(out('transports/windowsBluetooth'));
const { BT } = require(out('transports/transportConstants'));
const { SessionManager } = require(out('runtime/sessionManager'));
const { Transport } = require(out('contracts/enums'));

const HELPER = path.join(REPO, 'native', 'bin', 'bt-pairing-helper.exe');
const RESULTS = path.join(REPO, '.review-out', 'bt-scenario-matrix.jsonl');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: { info: () => {}, warn: () => {} } };

const argOf = (flag) => {
	const at = process.argv.indexOf(flag);
	return at >= 0 ? process.argv[at + 1] : undefined;
};
const only = (argOf('--only') ?? '').split(',').filter(Boolean);
const brickFilter = (argOf('--brick') ?? '').toLowerCase();
// The rename half doubles the runtime, and a run that is only after the naming behaviour
// does not need the plain half repeated.
const namingVariants = process.argv.includes('--no-rename') ? [[false, '']]
	: process.argv.includes('--only-rename') ? [[true, '2']]
	: [[false, ''], [true, '2']];

/**
 * How long to watch after an event before concluding nothing more will happen.
 *
 * Measured rather than guessed: switching a brick's radio off over USB took 18.7 s to show up
 * as a withdrawal, and switching it back on took 6.0 s to show up as an arrival. Anything
 * shorter than that would record "did not appear" for a brick that was on its way.
 */
const OBSERVE_MS = 30000;

// ── Host state ──────────────────────────────────────────────────────

function powershell(script) {
	return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}

/**
 * What Windows knows about this address, from the two places that disagree.
 *
 * The PnP node is the authority on whether a pairing exists; the registry record is a name
 * cache that outlives it. Reading only one of them is how a brick gets called "new" when the
 * host still remembers its name, which was the mistake this whole matrix exists to expose.
 */
function hostState(mac) {
	const flat = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
	const pnp = powershell(
		`$d = Get-PnpDevice | Where-Object { $_.InstanceId -match 'DEV_${flat}' };`
		+ ' if ($d) { $d.FriendlyName } else { \'\' }');
	const cached = powershell(
		'if (Test-Path \'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\'
		+ `${flat}') { 'yes' } else { 'no' }`);
	return { paired: pnp !== '', pairedAs: pnp || null, nameCached: cached === 'yes' };
}

// ── Observation ─────────────────────────────────────────────────────

/**
 * Runs one scan and records everything it reports about one address.
 *
 * Keeps the arrival time because it is the only thing separating a cache pass from a live
 * inquiry: under about 100 ms the watcher is reading records, not listening to a radio.
 */
async function observe(mac, ms) {
	const want = mac.toLowerCase();
	const started = Date.now();
	const timeline = [];
	let present = false;

	const scan = scanForBricks({
		helperPath: HELPER,
		ouiFilter: BT.LEGO_OUI,
		inquirySeconds: Math.ceil(ms / 1000) + 5,
		timeoutSeconds: Math.ceil(ms / 1000) + 20,
		onChange: (bricks) => {
			const mine = bricks.find((b) => b.mac.toLowerCase() === want);
			if (mine && !present) {
				timeline.push({ event: 'appeared', atMs: Date.now() - started, name: mine.name, paired: mine.paired, signal: mine.signal });
				present = true;
			} else if (!mine && present) {
				timeline.push({ event: 'lost', atMs: Date.now() - started });
				present = false;
			}
		},
	});

	await wait(ms);
	scan.cancel();
	const finalList = await scan.done;
	const mine = finalList.find((b) => b.mac.toLowerCase() === want);

	const first = timeline.find((e) => e.event === 'appeared');
	return {
		seen: Boolean(mine),
		nameSeen: mine?.name ?? null,
		pairedSeen: mine?.paired ?? null,
		firstSeenMs: first?.atMs ?? null,
		source: classifyArrival(first?.atMs),
		timeline,
	};
}

/**
 * Where an arrival came from, judged by how long it took.
 *
 * Not a fussy distinction — it is the whole difference between "the host remembers this
 * brick" and "this brick is on and answering right now", and getting it wrong cost a day
 * earlier this week. Bluetooth inquiry cannot complete in under about 1.3 s by the standard's
 * own scan timing, and every genuine inquiry measured here landed between 4.7 s and 23.8 s.
 * Every cache hit measured landed under half a second. Nothing has ever been observed in
 * between, so the middle is reported as unknown rather than guessed at.
 */
function classifyArrival(atMs) {
	if (atMs === undefined || atMs === null) { return null; }
	if (atMs < 1000) { return 'cache'; }
	if (atMs < 3000) { return 'uncertain'; }
	return 'inquiry';
}

/** What the shipped discovery path reports, which is a different question to the scan. */
async function cockpitDiscovery(mac) {
	const discovery = new BtClassicDiscovery({});
	try {
		const devices = await discovery.discover();
		const mine = devices.find((d) => d.mac.toLowerCase() === mac.toLowerCase());
		return mine ? { listed: true, name: mine.name, authenticated: mine.authenticated } : { listed: false };
	} catch (error) {
		return { listed: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// ── Control channel (USB) ───────────────────────────────────────────

async function usbSetup() {
	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider(quiet);
	registry.register(usb);
	const sessions = new SessionManager({ providerRegistry: registry });
	const scan = await usb.discover();
	return { registry, usb, sessions, items: scan.items };
}

/**
 * Sends a command that the brick's Bluetooth stack can refuse while it is busy.
 *
 * `BtSetOnOff` fails for one reason only — the HCI socket is mid-operation — and a scan that
 * has just finished is exactly when that is true. Measured 04.09.2026: it errored right after
 * a 30 s scan and succeeded first try seconds later.
 */
async function sendWithRetry(sessions, brickKey, command, attempts = 5) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await sessions.send(brickKey, command);
		} catch (error) {
			if (attempt === attempts) { throw error; }
			await wait(3000);
		}
	}
	return undefined;
}

const macFromUsbKey = (brickKey) => {
	const hex = brickKey.split(':').pop();
	return (hex.match(/../g) ?? []).join(':').toUpperCase();
};

function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

// ── Scenarios ───────────────────────────────────────────────────────

/**
 * Each scenario puts the host and the brick into a named starting state, then hands back to
 * the caller to observe. Setup happens over USB wherever it can; anything that needs a person
 * says so and waits.
 */
const SCENARIOS = {
	fresh: {
		what: 'Windows has never met this brick: no pairing, no cached name',
		async setup({ mac, state }) {
			if (state.paired) { removeBluetoothDevice(mac); }
			const after = hostState(mac);
			if (after.nameCached) {
				return {
					skipped: true,
					why: 'The name cache record still exists. Delete HKLM:\\SYSTEM\\CurrentControlSet'
						+ `\\Services\\BTHPORT\\Parameters\\Devices\\${mac.replace(/:/g, '').toLowerCase()}`
						+ ' by hand (regedit as admin, take ownership) and re-run — otherwise this'
						+ ' measures the `unpaired` scenario wearing the wrong label.',
				};
			}
			return {};
		},
	},

	known: {
		what: 'Paired already, and still is',
		async setup({ mac, state, pair }) {
			if (!state.paired) {
				const paired = await pair(mac);
				if (!paired.ok) {
					return { skipped: true, why: `Pairing failed: ${paired.reason ?? 'no reason'}` };
				}
			}
			return hostState(mac).paired ? {} : { skipped: true, why: 'Pairing reported success but left no PnP node.' };
		},
	},

	unpaired: {
		what: 'Seen before, pairing removed, name cache left behind',
		async setup({ mac, state, pair }) {
			// Pair first when the host has no record, because otherwise this is not the
			// scenario it claims to be: what separates "unpaired" from "never seen" is the
			// name cache record, and only pairing creates one. Measured 04.09.2026 — CCC came
			// out of both scenarios with an identical host state, which is how the flaw showed.
			if (!state.paired && !state.nameCached) {
				const paired = await pair(mac);
				if (!paired.ok) {
					return { skipped: true, why: `Could not pair first: ${paired.reason ?? 'no reason'}` };
				}
			}
			removeBluetoothDevice(mac);
			const after = hostState(mac);
			return after.nameCached ? {} : {
				skipped: true,
				why: 'Unpairing removed the name cache record too, so this is indistinguishable '
					+ 'from `fresh` on this host — there is no `unpaired` state to measure.',
			};
		},
	},

	returning: {
		what: 'Paired, went out of range, came back',
		async setup({ mac, state, pair, send, brickKey }) {
			if (!state.paired) {
				const paired = await pair(mac);
				// A scenario that says "paired, then went out of range" cannot be measured on a
				// brick that never paired. Reporting it anyway would put a row in the results
				// describing something that did not happen.
				if (!paired.ok) {
					return { skipped: true, why: `Pairing failed: ${paired.reason ?? 'no reason'}` };
				}
			}
			await send(brickKey, { kind: 'brick:setBluetooth', on: false });
			// Long enough for the withdrawal to be observable: measured at 18.7 s.
			await wait(25000);
			await send(brickKey, { kind: 'brick:setBluetooth', on: true });
			await send(brickKey, { kind: 'brick:setBluetoothVisible', visible: true });
			return {};
		},
	},
};

async function main() {
	fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
	const results = [];

	const { registry, usb, sessions, items } = await usbSetup();
	const bricks = items.filter((i) => !brickFilter || i.displayName.toLowerCase().includes(brickFilter));
	if (!bricks.length) {
		console.error('No brick on USB. The matrix needs the cable as its control channel.');
		process.exitCode = 1;
		return;
	}

	const pairDirect = createHelperPairing({ helperPath: HELPER, inquirySeconds: 45 });
	/**
	 * Pairing is the one step nobody can automate: the brick asks on its own display and waits
	 * for a physical press. So it announces itself, makes a noise, and blocks — a scenario that
	 * paired nothing because nobody was looking would be recorded as a discovery failure.
	 */
	const pair = async (mac) => {
		try { powershell('[console]::beep(880,400)'); } catch { /* no speaker, no matter */ }
		// Waits rather than announcing and racing ahead. The first run of this paired nothing
		// because the prompt scrolled past while nobody was standing at the brick, and the
		// scenario went on to measure an unpaired brick under a "paired" label.
		await ask(`\n  >>> PAIRING ${mac}. Go to the brick, then press Enter here.\n`
			+ '      When it asks: confirm "Connect?", then accept PIN 1234.\n  Ready? ');
		const result = await pairDirect(mac);
		console.log(`  <<< pairing: ${result.ok ? 'paired' : `failed — ${result.reason ?? 'no reason'}`}`);
		return result;
	};
	const names = new Map();

	try {
		for (const item of bricks) {
			const mac = macFromUsbKey(item.brickKey);
			await sessions.connect(item.brickKey, Transport.USB, item.displayName);
			const info = await sessions.send(item.brickKey, { kind: 'info' });
			names.set(item.brickKey, info.displayName);

			for (const [renamed, suffix] of namingVariants) {
				if (renamed) {
					await sessions.send(item.brickKey, { kind: 'brick:setName', name: `${info.displayName}${suffix}` });
					await wait(1000);
				}

				for (const [name, scenario] of Object.entries(SCENARIOS)) {
					if (only.length && !only.includes(name)) { continue; }

					const before = hostState(mac);
					const label = `${info.displayName}${renamed ? suffix : ''} / ${name}${renamed ? ' + renamed' : ''}`;
					console.log(`\n── ${label} ──`);
					console.log(`  ${scenario.what}`);
					console.log(`  before: paired=${before.paired}${before.pairedAs ? ` (${before.pairedAs})` : ''} nameCached=${before.nameCached}`);

					const setup = await scenario.setup({
						mac, state: before, pair, brickKey: item.brickKey,
						// The radio refuses while it is busy, which a scan makes routine.
						send: (key, command) => sendWithRetry(sessions, key, command),
					});

					let cell;
					if (setup.skipped) {
						console.log(`  SKIPPED: ${setup.why}`);
						cell = { brick: info.displayName, renamed, scenario: name, skipped: true, why: setup.why, before };
					} else {
						const seenOverBt = await observe(mac, OBSERVE_MS);
						const listed = await cockpitDiscovery(mac);
						const after = hostState(mac);
						cell = {
							brick: info.displayName, renamed, scenario: name,
							before, after, scan: seenOverBt, discovery: listed,
						};
						// The timeline, not a single verdict: a brick that appeared and then went
						// again is a different answer to one that never appeared, and one line
						// saying "seen=false at 454ms" reads as a contradiction rather than a
						// sequence.
						const story = seenOverBt.timeline.length
							? seenOverBt.timeline
								.map((e) => `${e.event}@${e.atMs}ms${e.event === 'appeared' ? ` (${classifyArrival(e.atMs)}${e.name ? `, "${e.name}"` : ''})` : ''}`)
								.join(' → ')
							: 'never appeared';
						console.log(`  scan: ${story}`);
						console.log(`  scan ended with the brick ${seenOverBt.seen ? 'present' : 'absent'}`);
						console.log(`  cockpit discover(): ${JSON.stringify(listed)}`);
					}

					results.push(cell);
					fs.appendFileSync(RESULTS, `${JSON.stringify(cell)}\n`);
				}
			}
		}
	} finally {
		console.log('\nRestoring bricks...');
		for (const [brickKey, original] of names) {
			try {
				await sendWithRetry(sessions, brickKey, { kind: 'brick:setName', name: original });
				await sendWithRetry(sessions, brickKey, { kind: 'brick:setBluetooth', on: true });
				await sendWithRetry(sessions, brickKey, { kind: 'brick:setBluetoothVisible', visible: true });
				console.log(`  ${brickKey} → ${original}, Bluetooth on and visible`);
			} catch (error) {
				console.error(`  ${brickKey} could not be restored: ${error instanceof Error ? error.message : String(error)}`);
			}
			await sessions.disconnect(brickKey).catch(() => { /* shutting down */ });
		}
		sessions.dispose();
		usb.dispose();
		registry.dispose();
	}

	console.log(`\n${results.length} cells written to ${path.relative(REPO, RESULTS)}`);
	for (const cell of results) {
		const state = cell.skipped
			? 'skipped'
			: `${cell.scan.firstSeenMs === null ? 'never appeared'
				: `first@${cell.scan.firstSeenMs}ms (${cell.scan.source})`}`
				+ `, ended ${cell.scan.seen ? 'present' : 'absent'}`
				+ `, name ${cell.scan.nameSeen ? JSON.stringify(cell.scan.nameSeen) : '—'}`
				+ `, discover(): ${cell.discovery.listed ? (cell.discovery.name || '(unnamed)') : 'absent'}`;
		console.log(`  ${cell.brick}${cell.renamed ? '2' : ''} / ${cell.scenario}: ${state}`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
