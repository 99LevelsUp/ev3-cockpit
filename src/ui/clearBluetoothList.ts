/**
 * The "Clear a Brick's Bluetooth List" command (step-3 plan, U8, KD7): pick a brick reachable
 * now, read its list, confirm every name it will remove, remove them all, and say entry by entry
 * what happened and what is left.
 *
 * Free of `vscode`, like `forgetBrick.ts`, whose builders render the parts the two reports share
 * (R19). It names where a record is and why it stays, never how to get around what protects it
 * (R6, KD3).
 */

import { BrickEntry, BrickId, ChannelState, Transport } from '../contracts';
import type { BrickManager } from '../runtime/brickManager';
import { brickLabel } from '../runtime/brickLabels';
import type { ClearListReport, ClearedEntry } from '../runtime/forgetReport';
import { compareBricks } from './brickOrder';
import type { BrickPickRow } from './brickPickRows';
import {
	BrickCommandDeps, MENU_SAVE_NOTE, memoryLines, over, pairingLines, plainPickRow, quoteNames, residueLines, sentence,
} from './forgetBrick';

/** The one action of the confirmation (R16). */
export const CLEAR_ACTION = 'Clear';

/**
 * The bricks whose list can be read now: connected or available on any channel, paired with
 * this computer or not (R15), in D5 order.
 *
 * An available Bluetooth channel counts only for a paired brick. One nobody has paired is a
 * sighting the cockpit does not connect over, the same rule the brick layer joins by.
 */
export function clearCandidates(list: readonly BrickEntry[]): BrickEntry[] {
	return list.filter((brick) => brick.channels.some((channel) => channel.state === ChannelState.Connected
		|| (channel.state === ChannelState.Available && (channel.transport !== Transport.BT || brick.paired))))
		.sort(compareBricks);
}

export function clearPickRows(list: readonly BrickEntry[], isSignedIn: (brickId: BrickId) => boolean): BrickPickRow[] {
	return clearCandidates(list).map((brick) => plainPickRow(brick, isSignedIn));
}

const entries = (count: number): string => `${count} ${count === 1 ? 'entry' : 'entries'}`;

/** The modal question: every name it will remove, and whether this computer is one (R16). */
export function clearConfirmation(
	label: string, names: readonly string[], includesThisComputer: boolean, thisComputer: string | undefined,
): { message: string; detail: string } {
	const detail = [`It will remove ${entries(names.length)}: ${quoteNames(names)}.`];
	if (thisComputer === undefined && includesThisComputer) {
		// Over Bluetooth alone, the brick layer finds this computer's entry by the brick's connected mark.
		detail.push('This computer\'s Bluetooth name is unknown, but the brick marks one of them as the entry that holds '
			+ 'its Bluetooth link to this computer: the brick will no longer know this computer, '
			+ 'and if this computer is paired with the brick, that pairing is removed too.');
	} else if (thisComputer === undefined) {
		detail.push('This computer\'s Bluetooth name is unknown, so nothing shows whether this computer is among them.');
	} else if (includesThisComputer && !names.includes(thisComputer)) {
		// Its current name is not on the list; the brick layer found its entry by the connected mark.
		detail.push(`No entry carries this computer's current name, "${thisComputer}", but the brick marks one of them `
			+ 'as the entry that holds its Bluetooth link to this computer: the brick will no longer know this computer, '
			+ 'and if this computer is paired with the brick, that pairing is removed too.');
	} else if (includesThisComputer) {
		detail.push(`This computer, "${thisComputer}", is among them: the brick will no longer know it, `
			+ 'and if this computer is paired with the brick, that pairing is removed too.');
	} else {
		detail.push(`This computer, "${thisComputer}", is not among them.`);
	}
	detail.push('Each computer or brick removed has to pair with this brick again before it can connect over Bluetooth.');
	return { message: `Clear the Bluetooth list of ${label}?`, detail: detail.join(' ') };
}

function entryLine(entry: ClearedEntry, thisComputer: string | undefined): string {
	const name = `"${entry.name}"${entry.name === thisComputer ? ' (this computer)' : ''}`;
	switch (entry.status) {
	case 'confirmed': return `  ${name}: removed; the list read back no longer holds it.`;
	case 'sent': return `  ${name}: removal sent, not confirmed. ${sentence(entry.detail)}`;
	case 'failed': return `  ${name}: not removed. ${sentence(entry.detail)}`;
	case 'not-removable': return `  ${name}: cannot be removed; the brick removes entries by name, and this one has none.`;
	}
}

/** Why nothing changed on the brick. */
function skipLine(report: ClearListReport, skip: NonNullable<ClearListReport['skipped']>): string {
	const detail = skip.detail ? ` ${sentence(skip.detail)}` : '';
	switch (skip.reason) {
	case 'not-reachable':
		return `Nothing changed on the brick: no channel to it was connected, and none could be opened.${detail}`;
	case 'list-unreadable':
		return `Nothing changed on the brick: its Bluetooth list could not be read.${detail}`;
	case 'nothing-to-remove':
		return report.peers && report.peers.length > 0
			? 'Nothing changed on the brick: its Bluetooth list holds no entry with a name, and the brick removes entries by name.'
			: 'Nothing changed on the brick: its Bluetooth list is empty.';
	case 'radio-name-unknown':
		return 'Nothing changed on the brick. Only Bluetooth reaches it, and removing this computer\'s entry cuts that link, '
			+ 'so that entry has to go last; this computer\'s Bluetooth name is unknown, so nothing shows which entry it is. '
			+ 'Connect the brick with a USB cable and clear its list again.';
	case 'link-entry-unknown':
		return 'Nothing changed on the brick. Only Bluetooth reaches it, and removing this computer\'s entry cuts that link, '
			+ `so that entry has to go last; no entry carries this computer's Bluetooth name${report.thisComputer ? ` ("${report.thisComputer}")` : ''}, `
			+ 'and the brick does not mark exactly one entry connected, so nothing shows which entry it is. '
			+ 'Connect the brick with a USB cable and clear its list again.';
	case 'duplicate-link-entry':
		return 'Nothing changed on the brick. Only Bluetooth reaches it, and removing this computer\'s entry cuts that link, '
			+ 'so that entry has to go last; its list holds that entry\'s name more than once, and the brick removes '
			+ 'the first entry a name matches, which may be the one holding the link, so the other would never be removed. '
			+ 'Connect the brick with a USB cable and clear its list again.';
	}
}

/** This computer's pairing with the brick: acted on (KTD10), or why it was left alone (R18). */
function clearPairingLines(report: ClearListReport): string[] {
	if (report.pairing.length > 0) {
		return [...pairingLines(report), ...(report.memory ? memoryLines({ memory: report.memory }, 'its Bluetooth channel') : [])];
	}
	switch (report.pairingLeft) {
	case 'radio-name-unknown':
		return ['Pairing on this computer: left alone; this computer\'s Bluetooth name is unknown, '
			+ 'so nothing shows whether the brick listed it.'];
	case 'not-on-brick':
		return ['Pairing on this computer: left alone; no entry on the brick carried this computer\'s exact Bluetooth name.'];
	case 'not-removed':
		return ['Pairing on this computer: left alone; this computer\'s entry is still on the brick.'];
	case 'not-paired':
	case undefined:
		return ['Pairing on this computer: nothing to unpair; this computer is not paired with the brick.'];
	}
}

/** Every record the clear did not remove, with where it is and why it matters (R11, R19). */
function clearLeftBehindLines(report: ClearListReport): string[] {
	const lines: string[] = [];
	for (const entry of report.entries) {
		if (entry.status === 'confirmed') { continue; }
		if (entry.status === 'not-removable') {
			lines.push(`  On the brick: an entry without a name ("${entry.name}") is still in its Bluetooth list.`,
				'    The cockpit cannot remove it: the brick removes entries by name.');
			continue;
		}
		const mine = entry.name === report.thisComputer;
		lines.push(`  On the brick: "${entry.name}" ${entry.status === 'sent' ? 'may still be' : 'is still'} in its Bluetooth list.`,
			mine
				? '    It blocks re-pairing with this computer until it is removed.'
				: '    The computer or brick it names cannot pair with this brick again until it is removed.');
	}
	if (report.paired && report.pairingLeft === 'radio-name-unknown') {
		lines.push('  On this computer: its Bluetooth pairing with the brick.',
			'    Nothing shows whether this computer\'s entry was among those removed. If it was, the pairing is one-sided, '
				+ 'and connecting over Bluetooth fails until "Forget a Brick" removes it.');
	}
	if (report.paired && report.pairingLeft === 'not-on-brick') {
		// Only the current name was looked for: what an entry under an earlier one means depends on
		// whether any entry is left.
		const listEmptied = report.entries.every((entry) => entry.status === 'confirmed');
		lines.push('  On this computer: its Bluetooth pairing with the brick.',
			'    No entry on the brick carried this computer\'s current Bluetooth name, so the cockpit left the pairing alone. '
				+ (listEmptied
					? 'The list read back holds no entry now, so the brick does not know this computer, '
						+ 'and connecting over Bluetooth fails until "Forget a Brick" removes the pairing.'
					: 'An entry under an earlier name of this computer may still be on the brick; if one is, this computer '
						+ 'cannot pair with the brick again until that entry is removed.'));
	}
	lines.push(...residueLines(report.residue));
	return lines.length > 0 ? ['Left behind:', ...lines] : ['Left behind: nothing.'];
}

const went = (entry: ClearedEntry): boolean => entry.status === 'confirmed' || entry.status === 'sent';

/**
 * The menu power-off note (R11, R19), for what this clear removed: the removed entries come back
 * if the battery is pulled, and only this computer's own blocks re-pairing with this computer.
 */
function powerOffNote(report: ClearListReport): string {
	const mine = report.entries.some((entry) => went(entry) && entry.name === report.thisComputer);
	return `  ${MENU_SAVE_NOTE} If its battery is pulled instead, the removed entries come back`
		+ `${mine ? ', and this computer\'s then blocks re-pairing with this computer.' : '.'}`;
}

/** The output channel's account of a clear, entry by entry (KTD8, R19). */
export function clearDetails(report: ClearListReport, label: string): string[] {
	if (report.skipped) {
		return [
			`Did not clear the Bluetooth list of ${label}.`,
			skipLine(report, report.skipped),
			...(report.peers && report.peers.length > 0 ? [`  The brick's list held: ${quoteNames(report.peers)}.`] : []),
		];
	}
	return [
		`Clearing the Bluetooth list of ${label}${report.over ? ` ${over(report.over)}` : ''}:`,
		...(report.peers ? [`  The brick's list held: ${quoteNames(report.peers)}.`] : []),
		...report.entries.map((entry) => entryLine(entry, report.thisComputer)),
		...(report.entries.some(went) ? [powerOffNote(report)] : []),
		...clearPairingLines(report),
		...clearLeftBehindLines(report),
	];
}

/** The notification: what happened, in two or three short sentences; the details say the rest. */
export function clearNotification(report: ClearListReport, label: string): string {
	switch (report.skipped?.reason) {
	case 'not-reachable':
		return `EVƎ Cockpit: could not reach ${label}; nothing changed on the brick.`;
	case 'list-unreadable':
		return `EVƎ Cockpit: could not read the Bluetooth list of ${label}; nothing changed on the brick.`;
	case 'nothing-to-remove':
		return `EVƎ Cockpit: the Bluetooth list of ${label} holds nothing to remove.`;
	case 'radio-name-unknown':
		return `EVƎ Cockpit: nothing changed on ${label}. Over Bluetooth alone its list can be cleared only `
			+ 'when this computer\'s Bluetooth name is known; connect it with a USB cable.';
	case 'link-entry-unknown':
		return `EVƎ Cockpit: nothing changed on ${label}. Over Bluetooth alone its list can be cleared only `
			+ 'when the brick shows which entry is this computer\'s; connect it with a USB cable.';
	case 'duplicate-link-entry':
		return `EVƎ Cockpit: nothing changed on ${label}. Its list holds the name of this computer's entry more than once, `
			+ 'which over Bluetooth alone cannot be cleared; connect it with a USB cable.';
	case undefined:
		break;
	}
	const total = report.entries.length;
	const confirmed = report.entries.filter((entry) => entry.status === 'confirmed').length;
	const sent = report.entries.filter((entry) => entry.status === 'sent').length;
	const sentences = [confirmed === total
		? `EVƎ Cockpit: cleared the Bluetooth list of ${label}; removed ${entries(total)}.`
		: `EVƎ Cockpit: removed ${confirmed} of ${entries(total)} from the Bluetooth list of ${label}`
			+ `${sent > 0 ? `, and sent the removal of ${sent} more without confirmation` : ''}.`];
	if (report.pairing.length > 0) {
		sentences.push(report.pairing.every((p) => p.status === 'removed')
			? 'This computer was among them and is unpaired from the brick.'
			: 'This computer was among them, and it refused to unpair the brick.');
	}
	if (confirmed + sent > 0) { sentences.push('Switch the brick off from its menu to save the list.'); }
	return sentences.join(' ');
}

/** What the command needs besides the brick layer. */
export type ClearBrickBluetoothListDeps = BrickCommandDeps<Pick<BrickManager, 'clearBluetoothList' | 'isSignedIn'>>;

/**
 * Offers the bricks reachable now, reads the picked brick's list, asks before removing the
 * names it holds, removes them, and reports. Declined, it says nothing: nothing happened.
 */
export async function clearBrickBluetoothList(deps: ClearBrickBluetoothListDeps): Promise<void> {
	const { aggregator, bricks, log } = deps;
	const rows = clearPickRows(aggregator.getDiscoveryList(), (brickId) => bricks.isSignedIn(brickId));
	if (rows.length === 0) {
		deps.showInfo('EVƎ Cockpit: no brick is reachable now. A brick\'s Bluetooth list can be cleared while it is connected, '
			+ 'or available over a cable, the network or a Bluetooth pairing.');
		return;
	}
	const picked = await deps.pick(rows);
	if (!picked) { return; }

	const label = brickLabel(aggregator, picked.brickId);
	let report: ClearListReport | undefined;
	try {
		report = await deps.progress(`EVƎ Cockpit: clearing the Bluetooth list of ${label}`, () => bricks.clearBluetoothList(
			picked.brickId,
			(names, includesThisComputer, thisComputer) => {
				const { message, detail } = clearConfirmation(label, names, includesThisComputer, thisComputer);
				return deps.confirm(message, detail, CLEAR_ACTION);
			}));
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		log.error(`Clearing the Bluetooth list of ${label} failed:`, err);
		deps.showError(`EVƎ Cockpit: could not clear the Bluetooth list of ${label} — ${err.message}`);
		return;
	}
	if (!report) { return; }
	for (const line of clearDetails(report, label)) { log.info(line); }
	deps.showResult(clearNotification(report, label));
}
