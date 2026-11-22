/**
 * The "Forget a Brick" command: which bricks it offers, that it asks first, and what its message
 * says the forget did and left behind.
 *
 * The brick layer is a fake that returns a prepared report in the daemon's contract shape.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import type { ContractBrick, ForgetReport, ForgetResidue, ForgetResult } from '../contract/generated';
import type { BrickPickRow } from '../vscode/ui/brickPickRows';
import { forgetBrick, forgetDetails, forgetNotification, forgetPickRows } from '../vscode/ui/forgetBrick';
import { contractBrick } from './contractBricks';

const CCC_MAC = '00:16:53:F0:0C:0C';
const ZED_MAC = '00:16:53:00:00:FF';
const REM_MAC = '00:16:53:00:00:AA';
const NEW_MAC = '00:16:53:00:00:B0';
/** Channel keys as the daemon writes them in a report. */
const bt = (mac: string): string => `bt:${mac}`;
const usb = (mac: string): string => `usb:${mac.replace(/:/g, '')}`;
const idOf = (mac: string): string => mac.replace(/:/g, '');
const CCC = idOf(CCC_MAC);

/** What the Windows provider returns for CCC, copied from `windowsResidue`. */
const CCC_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\001653f00c0c';
const WINDOWS_RESIDUE: ForgetResidue[] = [
	{
		location: CCC_KEY,
		reason: 'Windows keeps this key after unpairing; it is owned by SYSTEM and the cockpit does not change it.',
	},
	{
		location: 'Windows\' in-memory Bluetooth device record for 001653F00C0C',
		reason: 'Windows keeps it until it next restarts; until then a scan may still list the brick, unpaired.',
	},
];

/** Steps the message must never offer: it names where a record is, never how to get around what protects it. */
const FORBIDDEN = /takeown|icacls|ownership|permission|regedit|reboot|restart bthserv|elevat|\bacl\b/i;

/**
 * CCC on a cable and paired; Zed paired and switched off; Rem no longer paired, its Bluetooth
 * sighting lost; New only heard by an inquiry.
 */
function theDesk(): ContractBrick[] {
	return [
		contractBrick(idOf(NEW_MAC), 'New', { bt: 'available' }),
		contractBrick(idOf(ZED_MAC), 'Zed', { bt: 'lost', paired: true }),
		contractBrick(idOf(REM_MAC), 'Rem', { bt: 'lost' }),
		contractBrick(CCC, 'CCC', { usb: 'connected', bt: 'available', paired: true }),
	];
}

function report(overrides: Partial<ForgetReport> = {}): ForgetReport {
	return {
		brickId: CCC,
		brickSide: { status: 'confirmed', name: 'HOSTA', over: usb(CCC_MAC) },
		peers: ['HOSTA', 'Zed'],
		pairing: [{ status: 'removed', channel: bt(CCC_MAC) }],
		memory: { status: 'cleared' },
		residue: WINDOWS_RESIDUE,
		...overrides,
	};
}

const details = (r: ForgetReport): string => forgetDetails(r, 'CCC [001653F00C0C]').join('\n');

/** The command over a fake brick layer; records what it was asked and what it showed. */
function command(options: { list?: ContractBrick[]; pick?: string; confirm?: boolean; result?: ForgetResult } = {}) {
	let list = options.list ?? theDesk();
	const seen = {
		rows: undefined as readonly BrickPickRow[] | undefined,
		confirm: [] as string[],
		forgot: [] as string[],
		progress: [] as string[],
		info: [] as string[],
		results: [] as string[],
		errors: [] as string[],
		log: [] as string[],
	};
	const run = () => forgetBrick({
		list: {
			bricks: () => list,
			brick: (id) => list.find((b) => b.brickId === id),
		},
		bricks: {
			forget: async (id) => {
				seen.forgot.push(id);
				// The daemon drops the brick from the list before the forget returns.
				list = list.filter((b) => b.brickId !== id);
				return options.result ?? { forgotten: true, lines: [], report: report() };
			},
		},
		pick: async (rows) => {
			seen.rows = rows;
			return rows.find((r) => r.brickId === (options.pick ?? CCC));
		},
		confirm: async (message, detail, action) => {
			seen.confirm.push(message, detail, action);
			return options.confirm ?? true;
		},
		progress: async (title, task) => { seen.progress.push(title); return task(); },
		log: {
			info: (message: string) => seen.log.push(message),
			warn: (message: string) => seen.log.push(message),
			error: (message: string) => seen.log.push(message),
		},
		showInfo: (message) => seen.info.push(message),
		showResult: (message) => seen.results.push(message),
		showError: (message) => seen.errors.push(message),
	});
	return { run, seen };
}

describe('Forget a Brick — which bricks it offers', () => {
	it('offers paired bricks, a switched-off one too, in the owner\'s order, and none that is not paired', async () => {
		const c = command();
		await c.run();
		assert.deepEqual(c.seen.rows?.map((r) => r.brickId), [CCC, idOf(ZED_MAC)]);
		assert.ok(c.seen.rows?.every((r) => !/\bnew\b/.test(r.description)),
			'a brick offered for forgetting was marked new');
		assert.match(c.seen.rows?.[0].label ?? '', /CCC$/);
	});

	it('rows show each channel the way the connect picker does', () => {
		const rows = forgetPickRows(theDesk());
		assert.deepEqual(rows.map((r) => r.description), [
			'USB connected · BT available',
			'BT not heard',
		]);
		assert.equal(rows[0].label, '$(check) CCC');
		assert.equal(rows[0].detail, CCC);
	});

	it('says there is nothing to forget, and opens no picker, when no brick is paired', async () => {
		const c = command({ list: theDesk().filter((b) => !b.paired) });
		await c.run();
		assert.equal(c.seen.rows, undefined, 'the picker opened');
		assert.equal(c.seen.info.length, 1);
		assert.match(c.seen.info[0], /^EVƎ Cockpit: /);
		assert.deepEqual(c.seen.forgot, []);
	});
});

describe('Forget a Brick — asking first', () => {
	it('names the brick, says it will be disconnected and unpaired, and offers one Forget action', async () => {
		const c = command();
		await c.run();
		const [message, detail, action] = c.seen.confirm;
		assert.match(message, /CCC \[001653F00C0C\]/);
		assert.match(`${message} ${detail}`, /disconnected/);
		assert.match(`${message} ${detail}`, /unpaired/);
		assert.equal(action, 'Forget');
	});

	it('calls nothing when the user declines', async () => {
		const c = command({ confirm: false });
		await c.run();
		assert.equal(c.seen.confirm.length, 3, 'nobody was asked');
		assert.deepEqual(c.seen.forgot, []);
		assert.deepEqual(c.seen.progress, []);
		assert.deepEqual(c.seen.results, []);
	});

	it('forgets the picked brick under a progress notification, and names it after it left the list', async () => {
		const c = command();
		await c.run();
		assert.deepEqual(c.seen.forgot, [CCC]);
		assert.equal(c.seen.progress.length, 1);
		assert.match(c.seen.progress[0], /CCC/);
		assert.equal(c.seen.results.length, 1);
		assert.match(c.seen.results[0], /^EVƎ Cockpit: forgot CCC \[001653F00C0C\]/);
		// The details reach the output channel even if nobody presses "Show details": the brick
		// is no longer offered, so the forget cannot be run again to see them.
		assert.ok(c.seen.log.some((line) => line.includes(CCC_KEY)), 'the details were not written to the log');
	});

	it('says what failed when the forget itself throws', async () => {
		const c = command();
		const failing = forgetBrick({
			list: { bricks: () => theDesk(), brick: () => undefined },
			bricks: { forget: async () => { throw new Error('boom'); } },
			pick: async (rows) => rows[0],
			confirm: async () => true,
			progress: async (_title, task) => task(),
			log: { info: () => {}, warn: () => {}, error: () => {} },
			showInfo: (m) => c.seen.info.push(m),
			showResult: (m) => c.seen.results.push(m),
			showError: (m) => c.seen.errors.push(m),
		});
		await failing;
		assert.equal(c.seen.errors.length, 1);
		assert.match(c.seen.errors[0], /boom/);
		assert.deepEqual(c.seen.results, []);
	});
});

describe('Forget a Brick — without a report, the daemon\'s own lines', () => {
	it('writes the daemon\'s lines to the log and says the brick was forgotten', async () => {
		const c = command({ result: { forgotten: true, lines: ['Pairing on this computer (BT): removed.'] } });
		await c.run();
		assert.deepEqual(c.seen.results, ['EVƎ Cockpit: forgot CCC [001653F00C0C].']);
		assert.ok(c.seen.log.includes('Pairing on this computer (BT): removed.'));
	});
});

describe('Forget a Brick — what the message says', () => {
	it('confirmed over USB and unpaired: names the exact key with the brick\'s address, and the menu power-off', () => {
		const text = details(report());
		assert.match(text, /memory: cleared/i);
		assert.match(text, /\(BT\): removed/);
		assert.match(text, /"HOSTA"/);
		assert.match(text, /over USB/);
		assert.ok(text.includes(CCC_KEY), 'the registry path is not named exactly');
		assert.ok(text.includes(WINDOWS_RESIDUE[0].reason), 'the key\'s reason is not given verbatim');
		assert.ok(text.includes(WINDOWS_RESIDUE[1].location) && text.includes(WINDOWS_RESIDUE[1].reason),
			'the in-memory record is not named');
		assert.match(text, /switched off from its own menu/);
		assert.match(text, /battery/);
		assert.doesNotMatch(text, /Clear a Brick's Bluetooth List/,
			'a confirmed removal still sent the user to clear the list');
		assert.doesNotMatch(text, /00:16:53/, 'an address was written with separators');

		const note = forgetNotification(report(), 'CCC [001653F00C0C]');
		assert.match(note, /^EVƎ Cockpit: forgot CCC \[001653F00C0C\]\./);
		assert.ok(note.split(/(?<=\.) /).length <= 3, `the notification is longer than three sentences: ${note}`);
	});

	it('unreachable: nothing changed on the brick, this computer\'s entry is left behind and blocks re-pairing', () => {
		const r = report({ brickSide: { status: 'skipped', reason: 'not-reachable' }, peers: undefined });
		const text = details(r);
		assert.match(text, /nothing changed on the brick/i);
		assert.match(text, /not reachable/);
		assert.match(text, /On the brick: this computer's entry/);
		assert.match(text, /blocks re-pairing with this computer/);
		assert.match(text, /"Clear a Brick's Bluetooth List" removes it once the brick is reachable/);
		assert.doesNotMatch(text, /switched off from its own menu/, 'a list that did not change needs no saving');
		assert.match(forgetNotification(r, 'CCC'), /Nothing changed on the brick/);
	});

	it('unreachable: says whether a channel was tried, and what opening it said', () => {
		// 01.11.2026: "none could be opened" was shown when nothing had been tried.
		const untried = details(report({ brickSide: { status: 'skipped', reason: 'not-reachable' }, peers: undefined }));
		assert.match(untried, /no channel to it was connected or available/);
		assert.doesNotMatch(untried, /could not be opened/);
		const failed = details(report({
			brickSide: { status: 'skipped', reason: 'not-reachable', detail: 'BT connect failed: no answer' }, peers: undefined,
		}));
		assert.match(failed, /a channel to it could not be opened\. BT connect failed: no answer/);
	});

	it('no exact match: lists the names the brick holds, quoted as they are', () => {
		const r = report({ brickSide: { status: 'skipped', reason: 'no-match' }, peers: ['OLD-PC', 'Zed '] });
		const text = details(r);
		assert.match(text, /"OLD-PC", "Zed "/);
		assert.match(text, /exact/);
		assert.match(text, /Clear a Brick's Bluetooth List/);
	});

	it('one of two entries under this computer\'s name removed: says one remains, and that it blocks re-pairing', () => {
		const r = report({
			brickSide: { status: 'confirmed', name: 'HOSTA', over: usb(CCC_MAC), remaining: 1 },
			peers: ['HOSTA', 'HOSTA'],
		});
		const text = details(r);
		assert.match(text, /still holds 1 more entry named "HOSTA"/);
		assert.match(text, /switched off from its own menu/);
		assert.match(text, /On the brick: 1 more entry under this computer's name/);
		assert.match(text, /blocks re-pairing with this computer/);
		assert.match(forgetNotification(r, 'CCC'), /still lists this computer/);
	});

	it('sent over the Bluetooth link it cut: not confirmed, needs the menu power-off, and may still be on the brick', () => {
		const r = report({ brickSide: { status: 'sent', name: 'HOSTA', over: bt(CCC_MAC), detail: 'The link closed.' } });
		const text = details(r);
		assert.match(text, /not confirmed/);
		assert.match(text, /over BT/);
		assert.match(text, /The link closed\./);
		assert.match(text, /switched off from its own menu/);
		assert.match(text, /On the brick: this computer's entry/);
		assert.match(text, /blocks re-pairing with this computer/);
	});

	it('a refused unpair carries the operating system\'s reason verbatim; a USB-only brick names no key', () => {
		const refused = details(report({
			pairing: [{ status: 'refused', channel: bt(CCC_MAC), reason: 'Windows refused to remove the pairing (error 5).' }],
		}));
		assert.match(refused, /\(BT\): refused/);
		assert.ok(refused.includes('Windows refused to remove the pairing (error 5).'));

		const usbOnly = details(report({ pairing: [], residue: [] }));
		assert.match(usbOnly, /nothing to unpair/);
		assert.doesNotMatch(usbOnly, /BTHPORT/);
	});

	it('a memory that was not fully cleared says so, and why', () => {
		const r = report({ memory: { status: 'failed', detail: 'scheduler: busy' } });
		assert.match(details(r), /not fully cleared.*scheduler: busy/);
		assert.match(forgetNotification(r, 'CCC'), /memory/);
	});

	it('never tells the user to take ownership, change permissions, elevate, edit the registry or reboot', () => {
		const reports: ForgetReport[] = [
			report(),
			report({ brickSide: { status: 'skipped', reason: 'not-reachable' }, peers: undefined }),
			report({ brickSide: { status: 'skipped', reason: 'no-match' }, peers: ['OLD-PC'] }),
			report({ brickSide: { status: 'skipped', reason: 'radio-name-unknown' }, peers: undefined }),
			report({ brickSide: { status: 'skipped', reason: 'list-unreadable', detail: 'timeout' }, peers: undefined }),
			report({ brickSide: { status: 'skipped', reason: 'error', detail: 'boom' } }),
			report({ brickSide: { status: 'sent', name: 'HOSTA', over: bt(CCC_MAC), detail: 'closed' } }),
			report({ brickSide: { status: 'failed', name: 'HOSTA', over: usb(CCC_MAC), detail: 'still listed' } }),
			report({ pairing: [{ status: 'refused', channel: bt(CCC_MAC), reason: 'error 5' }], memory: { status: 'failed', detail: 'x' } }),
		];
		for (const r of reports) {
			assert.doesNotMatch(details(r), FORBIDDEN);
			assert.doesNotMatch(forgetNotification(r, 'CCC'), FORBIDDEN);
		}
	});
});
