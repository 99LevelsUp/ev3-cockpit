/**
 * The "Forget a Brick" command (step-3 plan, U5): which bricks it offers, that it asks first,
 * and what its message says the forget did and left behind (R1, R2, R10, R11).
 *
 * The brick layer is a fake that returns a prepared report; `forgetBrick.test.ts` proves the
 * reports themselves on the real brick layer.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, ChannelState, Transport, brickIdOf, makeBrickKey } from '../contracts';
import type { BrickKey, ForgetResidue } from '../contracts';
import type { ForgetReport } from '../runtime/forgetReport';
import type { BrickPickRow } from '../ui/brickPickRows';
import { forgetBrick, forgetDetails, forgetNotification, forgetPickRows } from '../ui/forgetBrick';

const CCC_MAC = '00:16:53:42:D9:F2';
const ZED_MAC = '00:16:53:00:00:FF';
const REM_MAC = '00:16:53:00:00:AA';
const NEW_MAC = '00:16:53:00:00:B0';
const bt = (mac: string): BrickKey => makeBrickKey(Transport.BT, mac);
const usb = (mac: string): BrickKey => makeBrickKey(Transport.USB, mac.replace(/:/g, ''));
const idOf = (mac: string): BrickId => brickIdOf(bt(mac));
const CCC = idOf(CCC_MAC);

/** What the Windows provider returns for CCC, copied from `windowsResidue`. */
const CCC_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\00165342d9f2';
const WINDOWS_RESIDUE: readonly ForgetResidue[] = [
	{
		location: CCC_KEY,
		reason: 'Windows keeps this key after unpairing; it is owned by SYSTEM and the cockpit does not change it.',
	},
	{
		location: 'Windows\' in-memory Bluetooth device record for 00165342D9F2',
		reason: 'Windows keeps it until it next restarts; until then a scan may still list the brick, unpaired.',
	},
];

/** Steps the message must never offer (R6, R11, KD3). */
const FORBIDDEN = /takeown|icacls|ownership|permission|regedit|reboot|restart bthserv|elevat|\bacl\b/i;

function entry(
	mac: string, name: string,
	channels: readonly { key: BrickKey; transport: Transport; state: ChannelState }[],
	flags: { paired: boolean; remembered: boolean },
): BrickEntry {
	return {
		brickId: idOf(mac),
		name: { value: name, source: 'brick', confirmed: true },
		channels: channels.map((c, i) => ({ brickKey: c.key, transport: c.transport, priority: 10 - i, state: c.state, lastSeenAt: 1 })),
		paired: flags.paired,
		remembered: flags.remembered,
		favorite: false,
		lastSeenAt: 1,
	};
}

/** CCC on a cable and paired; Zed paired and switched off; Rem only remembered; New only heard by an inquiry. */
function theDesk(): BrickEntry[] {
	return [
		entry(NEW_MAC, 'New', [{ key: bt(NEW_MAC), transport: Transport.BT, state: ChannelState.Available }],
			{ paired: false, remembered: false }),
		entry(ZED_MAC, 'Zed', [{ key: bt(ZED_MAC), transport: Transport.BT, state: ChannelState.Lost }],
			{ paired: true, remembered: true }),
		entry(REM_MAC, 'Rem', [{ key: bt(REM_MAC), transport: Transport.BT, state: ChannelState.Lost }],
			{ paired: false, remembered: true }),
		entry(CCC_MAC, 'CCC', [
			{ key: usb(CCC_MAC), transport: Transport.USB, state: ChannelState.Connected },
			{ key: bt(CCC_MAC), transport: Transport.BT, state: ChannelState.Available },
		], { paired: true, remembered: true }),
	];
}

function report(overrides: Partial<ForgetReport> = {}): ForgetReport {
	return {
		brickId: CCC,
		brickSide: { status: 'confirmed', name: 'PETR-PC', over: usb(CCC_MAC) },
		peers: ['PETR-PC', 'Zed'],
		pairing: [{ status: 'removed', channel: bt(CCC_MAC) }],
		memory: { status: 'cleared' },
		residue: WINDOWS_RESIDUE,
		...overrides,
	};
}

const details = (r: ForgetReport): string => forgetDetails(r, 'CCC [00165342D9F2]').join('\n');

/** The command over a fake brick layer; records what it was asked and what it showed. */
function command(options: { list?: BrickEntry[]; pick?: BrickId; confirm?: boolean; result?: ForgetReport } = {}) {
	let list = options.list ?? theDesk();
	const seen = {
		rows: undefined as readonly BrickPickRow[] | undefined,
		confirm: [] as string[],
		forgot: [] as BrickId[],
		progress: [] as string[],
		info: [] as string[],
		results: [] as string[],
		errors: [] as string[],
		log: [] as string[],
	};
	const run = () => forgetBrick({
		aggregator: {
			getDiscoveryList: () => list,
			getBrick: (id) => list.find((b) => b.brickId === id),
		},
		bricks: {
			isSignedIn: (id) => id === CCC,
			forget: async (id) => {
				seen.forgot.push(id);
				// The real forget drops the brick from the list before it returns.
				list = list.filter((b) => b.brickId !== id);
				return options.result ?? report();
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
			debug: () => {},
		},
		showInfo: (message) => seen.info.push(message),
		showResult: (message) => seen.results.push(message),
		showError: (message) => seen.errors.push(message),
	});
	return { run, seen };
}

describe('Forget a Brick — which bricks it offers (R1, KD6)', () => {
	it('offers paired and remembered bricks, a switched-off one too, in D5 order, and not one only an inquiry heard', async () => {
		const c = command();
		await c.run();
		assert.deepEqual(c.seen.rows?.map((r) => r.brickId), [CCC, idOf(ZED_MAC), idOf(REM_MAC)]);
		assert.ok(c.seen.rows?.every((r) => !/\bnew\b/.test(r.description)),
			'a brick offered for forgetting was marked new');
		assert.match(c.seen.rows?.[0].label ?? '', /CCC$/);
	});

	it('rows show each channel the way the connect picker does', () => {
		const rows = forgetPickRows(theDesk(), (id) => id === CCC);
		assert.deepEqual(rows.map((r) => r.description), [
			'USB connected · BT available',
			'BT not heard',
			'BT not heard',
		]);
		assert.equal(rows[0].label, '$(check) CCC');
		assert.equal(rows[0].detail, CCC);
	});

	it('says there is nothing to forget, and opens no picker, when no brick is paired or remembered', async () => {
		const c = command({ list: theDesk().filter((b) => b.name.value === 'New') });
		await c.run();
		assert.equal(c.seen.rows, undefined, 'the picker opened');
		assert.equal(c.seen.info.length, 1);
		assert.match(c.seen.info[0], /^EVƎ Cockpit: /);
		assert.deepEqual(c.seen.forgot, []);
	});
});

describe('Forget a Brick — asking first (R2)', () => {
	it('names the brick, says it will be disconnected and unpaired, and offers one Forget action', async () => {
		const c = command();
		await c.run();
		const [message, detail, action] = c.seen.confirm;
		assert.match(message, /CCC \[00165342D9F2\]/);
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
		assert.match(c.seen.results[0], /^EVƎ Cockpit: forgot CCC \[00165342D9F2\]/);
		// The details reach the output channel even if nobody presses "Show details": the brick
		// is no longer offered, so the forget cannot be run again to see them.
		assert.ok(c.seen.log.some((line) => line.includes(CCC_KEY)), 'the details were not written to the log');
	});

	it('says what failed when the forget itself throws', async () => {
		const c = command();
		const failing = forgetBrick({
			aggregator: { getDiscoveryList: () => theDesk(), getBrick: () => undefined },
			bricks: { isSignedIn: () => false, forget: async () => { throw new Error('boom'); } },
			pick: async (rows) => rows[0],
			confirm: async () => true,
			progress: async (_title, task) => task(),
			log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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

describe('Forget a Brick — what the message says (R10, R11, KTD8)', () => {
	it('confirmed over USB and unpaired: names the exact key with the brick\'s address, and the menu power-off', () => {
		const text = details(report());
		assert.match(text, /memory: cleared/i);
		assert.match(text, /\(BT\): removed/);
		assert.match(text, /"PETR-PC"/);
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

		const note = forgetNotification(report(), 'CCC [00165342D9F2]');
		assert.match(note, /^EVƎ Cockpit: forgot CCC \[00165342D9F2\]\./);
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

	it('no exact match: lists the names the brick holds, quoted as they are', () => {
		const r = report({ brickSide: { status: 'skipped', reason: 'no-match' }, peers: ['OLD-PC', 'Zed '] });
		const text = details(r);
		assert.match(text, /"OLD-PC", "Zed "/);
		assert.match(text, /exact/);
		assert.match(text, /Clear a Brick's Bluetooth List/);
	});

	it('one of two entries under this computer\'s name removed: says one remains, and that it blocks re-pairing', () => {
		const r = report({
			brickSide: { status: 'confirmed', name: 'PETR-PC', over: usb(CCC_MAC), remaining: 1 },
			peers: ['PETR-PC', 'PETR-PC'],
		});
		const text = details(r);
		assert.match(text, /still holds 1 more entry named "PETR-PC"/);
		assert.match(text, /switched off from its own menu/);
		assert.match(text, /On the brick: 1 more entry under this computer's name/);
		assert.match(text, /blocks re-pairing with this computer/);
		assert.match(forgetNotification(r, 'CCC'), /still lists this computer/);
	});

	it('sent over the Bluetooth link it cut: not confirmed, needs the menu power-off, and may still be on the brick', () => {
		const r = report({ brickSide: { status: 'sent', name: 'PETR-PC', over: bt(CCC_MAC), detail: 'The link closed.' } });
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
			report({ brickSide: { status: 'sent', name: 'PETR-PC', over: bt(CCC_MAC), detail: 'closed' } }),
			report({ brickSide: { status: 'failed', name: 'PETR-PC', over: usb(CCC_MAC), detail: 'still listed' } }),
			report({ pairing: [{ status: 'refused', channel: bt(CCC_MAC), reason: 'error 5' }], memory: { status: 'failed', detail: 'x' } }),
		];
		for (const r of reports) {
			assert.doesNotMatch(details(r), FORBIDDEN);
			assert.doesNotMatch(forgetNotification(r, 'CCC'), FORBIDDEN);
		}
	});
});
