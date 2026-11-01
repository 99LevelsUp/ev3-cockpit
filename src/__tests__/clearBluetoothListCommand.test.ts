/**
 * The "Clear a Brick's Bluetooth List" command (step-3 plan, U8): which bricks it offers, what
 * it asks before removing anything, and what its message says (R15, R16, R19).
 *
 * The brick layer is a fake that asks the command's confirmation and returns a prepared report;
 * `forgetBrick.test.ts` proves the reports themselves on the real brick layer.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, ChannelState, Transport, brickIdOf, makeBrickKey } from '../contracts';
import type { BrickKey, ForgetResidue } from '../contracts';
import type { ClearListReport } from '../runtime/forgetReport';
import type { BrickPickRow } from '../ui/brickPickRows';
import {
	clearBrickBluetoothList, clearConfirmation, clearDetails, clearNotification, clearPickRows,
} from '../ui/clearBluetoothList';

const CCC_MAC = '00:16:53:F0:0C:0C';
const ZED_MAC = '00:16:53:00:00:FF';
const UNP_MAC = '00:16:53:00:00:AA';
const NEW_MAC = '00:16:53:00:00:B0';
const bt = (mac: string): BrickKey => makeBrickKey(Transport.BT, mac);
const usb = (mac: string): BrickKey => makeBrickKey(Transport.USB, mac.replace(/:/g, ''));
const idOf = (mac: string): BrickId => brickIdOf(bt(mac));
const CCC = idOf(CCC_MAC);
const THIS_PC = 'PETR-PC';
const LABEL = 'CCC [001653F00C0C]';

const CCC_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\001653f00c0c';
const WINDOWS_RESIDUE: readonly ForgetResidue[] = [
	{
		location: CCC_KEY,
		reason: 'Windows keeps this key after unpairing; it is owned by SYSTEM and the cockpit does not change it.',
	},
	{
		location: 'Windows\' in-memory Bluetooth device record for 001653F00C0C',
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

/** CCC on a cable and paired; Zed paired and switched off; Unp on a cable, never paired; New only heard by an inquiry. */
function theDesk(): BrickEntry[] {
	return [
		entry(NEW_MAC, 'New', [{ key: bt(NEW_MAC), transport: Transport.BT, state: ChannelState.Available }],
			{ paired: false, remembered: false }),
		entry(ZED_MAC, 'Zed', [{ key: bt(ZED_MAC), transport: Transport.BT, state: ChannelState.Lost }],
			{ paired: true, remembered: true }),
		entry(UNP_MAC, 'Unp', [{ key: usb(UNP_MAC), transport: Transport.USB, state: ChannelState.Available }],
			{ paired: false, remembered: false }),
		entry(CCC_MAC, 'CCC', [
			{ key: usb(CCC_MAC), transport: Transport.USB, state: ChannelState.Connected },
			{ key: bt(CCC_MAC), transport: Transport.BT, state: ChannelState.Available },
		], { paired: true, remembered: true }),
	];
}

/** Three entries cleared over USB, this computer among them, its Bluetooth pairing removed. */
function report(overrides: Partial<ClearListReport> = {}): ClearListReport {
	return {
		brickId: CCC,
		over: usb(CCC_MAC),
		thisComputer: THIS_PC,
		paired: true,
		peers: ['OLD-PC', THIS_PC, 'Zed'],
		entries: [
			{ status: 'confirmed', name: 'OLD-PC' },
			{ status: 'confirmed', name: THIS_PC },
			{ status: 'confirmed', name: 'Zed' },
		],
		pairing: [{ status: 'removed', channel: bt(CCC_MAC) }],
		memory: { status: 'cleared' },
		residue: WINDOWS_RESIDUE,
		...overrides,
	};
}

const details = (r: ClearListReport): string => clearDetails(r, LABEL).join('\n');

/** The command over a fake brick layer that asks with `names` and returns `result`. */
function command(options: { names?: string[]; confirm?: boolean; result?: ClearListReport } = {}) {
	const seen = {
		rows: undefined as readonly BrickPickRow[] | undefined,
		confirm: [] as string[],
		cleared: [] as BrickId[],
		info: [] as string[],
		results: [] as string[],
		errors: [] as string[],
		log: [] as string[],
	};
	const run = () => clearBrickBluetoothList({
		aggregator: {
			getDiscoveryList: () => theDesk(),
			getBrick: (id) => theDesk().find((b) => b.brickId === id),
		},
		bricks: {
			isSignedIn: (id) => id === CCC,
			clearBluetoothList: async (id, confirm) => {
				seen.cleared.push(id);
				const names = options.names ?? ['OLD-PC', THIS_PC, 'Zed'];
				if (!await confirm(names, names.includes(THIS_PC), THIS_PC)) { return undefined; }
				return options.result ?? report();
			},
		},
		pick: async (rows) => { seen.rows = rows; return rows.find((r) => r.brickId === CCC); },
		confirm: async (message, detail, action) => {
			seen.confirm.push(message, detail, action);
			return options.confirm ?? true;
		},
		progress: async (_title, task) => task(),
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

describe('Clear a Brick\'s Bluetooth List — which bricks it offers (R15)', () => {
	it('offers bricks reachable now, an unpaired one on a cable too, and not a paired one switched off', () => {
		const rows = clearPickRows(theDesk(), (id) => id === CCC);
		assert.deepEqual(rows.map((r) => r.brickId), [CCC, idOf(UNP_MAC)]);
		assert.ok(!rows.some((r) => r.brickId === idOf(ZED_MAC)), 'a switched-off brick was offered');
		assert.ok(!rows.some((r) => r.brickId === idOf(NEW_MAC)),
			'a brick only an inquiry heard was offered; nothing can connect to it to read its list');
		assert.equal(rows[0].label, '$(check) CCC');
		assert.ok(rows.every((r) => !/\bnew\b/.test(r.description)));
	});

	it('says there is nothing to clear, and opens no picker, when no brick is reachable', async () => {
		const seen: string[] = [];
		await clearBrickBluetoothList({
			aggregator: { getDiscoveryList: () => theDesk().filter((b) => b.name.value === 'Zed'), getBrick: () => undefined },
			bricks: { isSignedIn: () => false, clearBluetoothList: async () => { throw new Error('called'); } },
			pick: async () => { throw new Error('the picker opened'); },
			confirm: async () => true,
			progress: async (_title, task) => task(),
			log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			showInfo: (m) => seen.push(m),
			showResult: () => {},
			showError: (m) => seen.push(m),
		});
		assert.equal(seen.length, 1);
		assert.match(seen[0], /^EVƎ Cockpit: no brick is reachable/);
	});
});

describe('Clear a Brick\'s Bluetooth List — asking first (R16)', () => {
	it('shows every name it will remove, says this computer is among them, and offers one Clear action', async () => {
		const c = command();
		await c.run();
		const [message, detail, action] = c.seen.confirm;
		assert.match(message, /CCC \[001653F00C0C\]/);
		assert.match(detail, /"OLD-PC", "PETR-PC", "Zed"/);
		assert.match(detail, /This computer, "PETR-PC", is among them/);
		assert.equal(action, 'Clear');
	});

	it('says when this computer is not among them, and when its name is unknown', () => {
		assert.match(clearConfirmation(LABEL, ['OLD-PC'], false, THIS_PC).detail, /"PETR-PC", is not among them/);
		assert.match(clearConfirmation(LABEL, ['OLD-PC'], false, undefined).detail, /name is unknown/);
		// Over Bluetooth alone, the entry the brick marks connected stands in for the unknown name.
		const linked = clearConfirmation(LABEL, ['OLD-PC'], true, undefined).detail;
		assert.match(linked, /holds its Bluetooth link to this computer/);
		assert.match(linked, /pairing is removed too/);
		assert.doesNotMatch(linked, /nothing shows whether/);
	});

	it('shows nothing and logs nothing when the user declines', async () => {
		const c = command({ confirm: false });
		await c.run();
		assert.deepEqual(c.seen.cleared, [CCC]);
		assert.deepEqual(c.seen.results, []);
		assert.deepEqual(c.seen.log, []);
	});

	it('writes the details to the log and shows the outcome', async () => {
		const c = command();
		await c.run();
		assert.equal(c.seen.results.length, 1);
		assert.match(c.seen.results[0], /^EVƎ Cockpit: cleared the Bluetooth list of CCC \[001653F00C0C\]/);
		assert.ok(c.seen.log.some((line) => line.includes(CCC_KEY)), 'the details were not written to the log');
	});
});

describe('Clear a Brick\'s Bluetooth List — what the message says (R19)', () => {
	it('three entries over USB, this computer among them, unpaired: every entry, the key, and the menu power-off', () => {
		const text = details(report());
		assert.match(text, /over USB/);
		assert.match(text, /"OLD-PC": removed/);
		assert.match(text, /"PETR-PC" \(this computer\): removed/);
		assert.match(text, /"Zed": removed/);
		assert.match(text, /\(BT\): removed/);
		assert.match(text, /memory of its Bluetooth channel: cleared/);
		assert.ok(text.includes(CCC_KEY));
		assert.match(text, /switched off from its own menu\. If its battery is pulled instead, the removed entries come back, and this computer's then blocks re-pairing with this computer\./);

		const note = clearNotification(report(), LABEL);
		assert.match(note, /removed 3 entries/);
		assert.match(note, /unpaired/);
		assert.match(note, /menu/);
		assert.ok(note.split(/(?<=\.) /).length <= 3, `the notification is longer than three sentences: ${note}`);
	});

	it('sent over the Bluetooth link it cut: not confirmed, and this computer\'s entry may still be on the brick', () => {
		const r = report({
			over: bt(CCC_MAC),
			entries: [
				{ status: 'sent', name: THIS_PC, detail: 'BT reply timed out' },
				{ status: 'confirmed', name: 'OLD-PC' },
				{ status: 'confirmed', name: 'Zed' },
			],
		});
		const text = details(r);
		assert.match(text, /"PETR-PC" \(this computer\): removal sent, not confirmed\. BT reply timed out\./);
		assert.match(text, /On the brick: "PETR-PC" may still be in its Bluetooth list/);
		assert.match(text, /blocks re-pairing with this computer/);
		assert.match(text, /switched off from its own menu/);
		assert.match(clearNotification(r, LABEL), /removed 2 of 3 entries.*sent the removal of 1 more without confirmation/);
	});

	it('an entry the brick kept and one without a name are named as left behind', () => {
		const r = report({
			entries: [
				{ status: 'confirmed', name: 'OLD-PC' },
				{ status: 'failed', name: 'STUCK', detail: 'The list read back still holds it.' },
				{ status: 'not-removable', name: '', reason: 'blank-name' },
			],
			pairing: [], pairingLeft: 'not-on-brick', memory: undefined, residue: [],
		});
		const text = details(r);
		assert.match(text, /"STUCK": not removed\. The list read back still holds it\./);
		assert.match(text, /On the brick: "STUCK" is still in its Bluetooth list/);
		assert.match(text, /"": cannot be removed/);
		assert.match(text, /an entry without a name/);
		assert.match(text, /Pairing on this computer: left alone; no entry on the brick carried this computer's exact Bluetooth name/);
		assert.doesNotMatch(text, /BTHPORT/);
		// The pairing it left is one-sided now, and only this computer's own entry blocks re-pairing with it.
		assert.match(text, /On this computer: its Bluetooth pairing with the brick\.\n.*does not know this computer/);
		assert.match(text, /the removed entries come back\./);
		assert.doesNotMatch(text, /blocks re-pairing with this computer/);
	});

	it('a brick that could not be reached: nothing changed', () => {
		const r: ClearListReport = { brickId: CCC, paired: false, skipped: { reason: 'not-reachable' }, entries: [], pairing: [], residue: [] };
		assert.match(details(r), /Nothing changed on the brick/);
		assert.match(clearNotification(r, LABEL), /nothing changed/);
	});

	it('never tells the user to take ownership, change permissions, elevate, edit the registry or reboot', () => {
		const reports: ClearListReport[] = [
			report(),
			report({ pairing: [{ status: 'refused', channel: bt(CCC_MAC), reason: 'error 5' }], memory: { status: 'failed', detail: 'x' } }),
			report({ pairing: [], pairingLeft: 'radio-name-unknown', thisComputer: undefined, memory: undefined, residue: [] }),
			report({ entries: [{ status: 'failed', name: 'X', detail: 'still listed' }], pairing: [], pairingLeft: 'not-removed' }),
			{ brickId: CCC, paired: false, skipped: { reason: 'radio-name-unknown' }, peers: ['A'], entries: [], pairing: [], residue: [] },
			{ brickId: CCC, paired: false, skipped: { reason: 'list-unreadable', detail: 'timeout' }, entries: [], pairing: [], residue: [] },
			{ brickId: CCC, paired: false, skipped: { reason: 'nothing-to-remove' }, peers: [], entries: [], pairing: [], residue: [] },
		];
		for (const r of reports) {
			assert.doesNotMatch(details(r), FORBIDDEN);
			assert.doesNotMatch(clearNotification(r, LABEL), FORBIDDEN);
		}
		assert.doesNotMatch(clearConfirmation(LABEL, ['A'], true, THIS_PC).detail, FORBIDDEN);
	});
});
