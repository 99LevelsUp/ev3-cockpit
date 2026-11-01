/**
 * The "Forget a Brick" command (step-3 plan, U5, KTD1): pick a brick this computer knows,
 * confirm, forget it across every layer, and say part by part what happened and what is left.
 *
 * Free of `vscode`, so the flow and its text can be tested; the command in `extension.ts` hands
 * it a picker, a modal confirmation, a progress notification and messages.
 *
 * The text is built from a `ForgetReport` by pure functions (KTD8). Each part has its own
 * builder so "Clear a Brick's Bluetooth List" (U8) can render its report of the same shape. The
 * fixed wording names no operating system (R12): the pairing refusal and the residue are the
 * provider's own words, printed as they came. It names where a record is and why it stays,
 * never how to get around what protects it (R6, R11, KD3).
 */

import { BrickEntry, BrickId, BrickKey } from '../contracts';
import type { BrickManager } from '../runtime/brickManager';
import { brickLabel, transportLabel } from '../runtime/brickLabels';
import type { RuntimeLog } from '../runtime/createRuntime';
import type { BrickSideOutcome, ForgetReport } from '../runtime/forgetReport';
import type { PresenceAggregator } from '../runtime/presenceAggregator';
import { compareBricks } from './brickOrder';
import { BrickPickRow, describeChannels } from './brickPickRows';

/** The one action of the confirmation (R2). */
export const FORGET_ACTION = 'Forget';

/**
 * Said whenever the brick's list changed, or may have: the firmware writes it to storage only
 * at an orderly shutdown (`c_bt.c` 422–426, 483–486).
 */
export const MENU_SAVE_NOTE = 'The brick saves its list only when it is switched off from its own menu.';
export const MENU_POWER_OFF_NOTE = `${MENU_SAVE_NOTE} `
	+ 'If its battery is pulled instead, the entry comes back, and it then blocks re-pairing with this computer.';

/** Why this computer's entry left on a brick matters, and what removes it (R11, KD7). */
export const LEFT_BEHIND_NOTE = 'It blocks re-pairing with this computer until it is removed. '
	+ '"Clear a Brick\'s Bluetooth List" removes it once the brick is reachable.';

/**
 * The bricks there is something to forget about: paired with this computer, or remembered
 * (R1, KD6). A brick only an inquiry heard has no pairing and no memory to remove. In D5 order.
 */
export function forgetCandidates(list: readonly BrickEntry[]): BrickEntry[] {
	return list.filter((brick) => brick.paired || brick.remembered).sort(compareBricks);
}

/**
 * The picker's rows: like the connect picker's, without its "new" mark, which says picking a
 * brick pairs it first and every brick here is known already.
 */
export function forgetPickRows(list: readonly BrickEntry[], isSignedIn: (brickId: BrickId) => boolean): BrickPickRow[] {
	return forgetCandidates(list).map((brick) => plainPickRow(brick, isSignedIn));
}

export function plainPickRow(brick: BrickEntry, isSignedIn: (brickId: BrickId) => boolean): BrickPickRow {
	return {
		label: `${isSignedIn(brick.brickId) ? '$(check) ' : ''}${brick.name.value}`,
		description: `${brick.name.confirmed ? '' : '(name unconfirmed) '}${describeChannels(brick)}`,
		detail: brick.brickId,
		brickId: brick.brickId,
	};
}

/** Ends `text` with a full stop unless it already ends a sentence. */
export function sentence(text: string): string {
	const trimmed = text.trim();
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Peer names as they are stored: quoted, so a trailing space shows (the match is exact). */
export function quoteNames(names: readonly string[]): string {
	return names.map((name) => `"${name}"`).join(', ');
}

/** "over USB", "over BT": the channel something went over. */
export const over = (key: BrickKey): string => `over ${transportLabel(key)}`;

/** The cockpit's own memory of the brick (R10); `of` names the part of it, when not all of it. */
export function memoryLines(report: Pick<ForgetReport, 'memory'>, of = ''): string[] {
	const memory = `The cockpit's memory${of ? ` of ${of}` : ''}`;
	return report.memory.status === 'cleared'
		? [`${memory}: cleared.`]
		: [`${memory}: not fully cleared — ${sentence(report.memory.detail)}`];
}

/** This computer's pairing, one line per channel that had one (R5, R10). */
export function pairingLines(report: Pick<ForgetReport, 'pairing'>): string[] {
	if (report.pairing.length === 0) {
		return ['Pairing on this computer: nothing to unpair; the brick has no Bluetooth pairing.'];
	}
	return report.pairing.map((outcome) => outcome.status === 'removed'
		? `Pairing on this computer (${transportLabel(outcome.channel)}): removed.`
		: `Pairing on this computer (${transportLabel(outcome.channel)}): refused — ${sentence(outcome.reason)}`);
}

/** Why nothing was done on the brick (R8). */
function skipReason(side: Extract<BrickSideOutcome, { status: 'skipped' }>): string {
	const detail = side.detail ? ` ${sentence(side.detail)}` : '';
	switch (side.reason) {
	case 'radio-name-unknown':
		return 'This computer\'s Bluetooth name is unknown, and the brick lists computers only by name.' + detail;
	case 'not-reachable':
		return 'The brick was not reachable: no channel to it was connected, and none could be opened.' + detail;
	case 'list-unreadable':
		return 'Its Bluetooth list could not be read.' + detail;
	case 'no-match':
		return 'No entry on it carries this computer\'s exact Bluetooth name.' + detail;
	case 'error':
		return `Something failed.${detail}`;
	}
}

/** This computer's entry on the brick's own Bluetooth list (R7–R9, R10). */
export function brickSideLines(report: ForgetReport): string[] {
	const side = report.brickSide;
	const lines: string[] = [];
	switch (side.status) {
	case 'confirmed':
		lines.push(side.remaining
			? `The brick's Bluetooth list: removed one of this computer's entries "${side.name}" ${over(side.over)}; `
				+ `the list read back still holds ${moreEntries(side.remaining)} named "${side.name}".`
			: `The brick's Bluetooth list: removed this computer's entry "${side.name}" ${over(side.over)}; `
				+ 'the list read back no longer holds it.');
		break;
	case 'sent':
		lines.push(`The brick's Bluetooth list: sent the removal of this computer's entry "${side.name}" ${over(side.over)}, `
			+ `not confirmed. ${sentence(side.detail)}`);
		break;
	case 'failed':
		lines.push(`The brick's Bluetooth list: removing this computer's entry "${side.name}" ${over(side.over)} failed. `
			+ sentence(side.detail));
		break;
	case 'skipped':
		lines.push(`The brick's Bluetooth list: nothing changed on the brick. ${skipReason(side)}`);
		break;
	}
	if (report.peers) {
		lines.push(report.peers.length > 0
			? `  The brick's list held: ${quoteNames(report.peers)}.`
			: '  The brick\'s list was empty.');
	}
	if (side.status === 'confirmed' || side.status === 'sent') {
		lines.push(`  ${MENU_POWER_OFF_NOTE}`);
	}
	if (side.status === 'skipped' && side.reason === 'no-match' && report.peers && report.peers.length > 0) {
		lines.push('  An entry under an earlier name of this computer blocks re-pairing with this computer the same way. '
			+ '"Clear a Brick\'s Bluetooth List" removes every entry, whatever its name.');
	}
	return lines;
}

/** "1 more entry", "2 more entries". */
const moreEntries = (count: number): string => `${count} more ${count === 1 ? 'entry' : 'entries'}`;

/**
 * This computer's entry on the brick, when it may still be there: the removal was not run,
 * failed, or was sent without proof (R11), or removed one of several entries under the name. A
 * list read without this computer's name has no such entry, so `no-match` adds none.
 */
function brickEntryLeftBehind(side: BrickSideOutcome): string | undefined {
	switch (side.status) {
	case 'confirmed':
		return side.remaining
			? `On the brick: ${moreEntries(side.remaining)} under this computer's name in the brick's Bluetooth list.`
			: undefined;
	case 'failed': return 'On the brick: this computer\'s entry in the brick\'s Bluetooth list is still there.';
	case 'sent': return 'On the brick: this computer\'s entry in the brick\'s Bluetooth list may still be there.';
	case 'skipped':
		return side.reason === 'no-match'
			? undefined
			: 'On the brick: this computer\'s entry in the brick\'s Bluetooth list, if it has one.';
	}
}

/** Every record the forget could not remove, with its exact location and why it stays (R11). */
export function leftBehindLines(report: ForgetReport): string[] {
	const lines: string[] = [];
	const onBrick = brickEntryLeftBehind(report.brickSide);
	if (onBrick) {
		lines.push(`  ${onBrick}`, `    ${LEFT_BEHIND_NOTE}`);
	}
	lines.push(...residueLines(report.residue));
	return lines.length > 0 ? ['Left behind:', ...lines] : ['Left behind: nothing.'];
}

/** The records a provider said it left, each with where it is and why it stays, as the provider gave them (R11, R12). */
export function residueLines(residue: ForgetReport['residue']): string[] {
	return residue.flatMap((record) => [`  ${record.location}`, `    ${record.reason}`]);
}

/** The output channel's account of a forget, part by part (KTD8). */
export function forgetDetails(report: ForgetReport, label: string): string[] {
	return [
		`Forgot ${label}.`,
		...memoryLines(report),
		...pairingLines(report),
		...brickSideLines(report),
		...leftBehindLines(report),
	];
}

/** The notification: what happened, in two or three short sentences; the details say the rest. */
export function forgetNotification(report: ForgetReport, label: string): string {
	const sentences = [report.memory.status === 'cleared'
		? `EVƎ Cockpit: forgot ${label}.`
		: `EVƎ Cockpit: forgot ${label}, but did not fully clear its memory.`];
	if (report.pairing.length > 0) {
		sentences.push(report.pairing.every((p) => p.status === 'removed')
			? 'Unpaired from this computer.'
			: 'This computer refused to unpair it.');
	}
	const side = report.brickSide;
	switch (side.status) {
	case 'confirmed':
		sentences.push(side.remaining
			? 'Removed one of its entries from the brick\'s list; the brick still lists this computer.'
			: 'Removed from the brick\'s list; switch the brick off from its menu to save that.');
		break;
	case 'sent':
		sentences.push('Removal sent to the brick, not confirmed.');
		break;
	case 'failed':
		sentences.push('The brick still lists this computer.');
		break;
	case 'skipped':
		sentences.push(side.reason === 'no-match'
			? 'The brick does not list this computer by its name.'
			: 'Nothing changed on the brick.');
		break;
	}
	return sentences.join(' ');
}

/** What a brick command needs besides the brick layer, whose part it uses is `B`. */
export interface BrickCommandDeps<B> {
	readonly aggregator: Pick<PresenceAggregator, 'getDiscoveryList' | 'getBrick'>;
	readonly bricks: B;
	/** Shows the rows and resolves with the one picked, or undefined when dismissed. */
	readonly pick: (rows: readonly BrickPickRow[]) => PromiseLike<BrickPickRow | undefined>;
	/** A modal question with one action; resolves true only when that action was chosen. */
	readonly confirm: (message: string, detail: string, action: string) => PromiseLike<boolean>;
	/** A notification that stays up while `task` runs. */
	readonly progress: <T>(title: string, task: () => Promise<T>) => PromiseLike<T>;
	readonly log: RuntimeLog;
	readonly showInfo: (message: string) => void;
	/** The outcome, with a way to the details already written to the log. */
	readonly showResult: (message: string) => void;
	readonly showError: (message: string) => void;
}

/** What the command needs besides the brick layer. */
export type ForgetBrickDeps = BrickCommandDeps<Pick<BrickManager, 'forget' | 'isSignedIn'>>;

/**
 * Offers the bricks this computer knows, asks before forgetting the one picked, forgets it, and
 * reports. The details go to the log whether or not anyone opens them: once forgotten, the brick
 * is no longer offered, so the forget cannot be run again to see them.
 */
export async function forgetBrick(deps: ForgetBrickDeps): Promise<void> {
	const { aggregator, bricks, log } = deps;
	const rows = forgetPickRows(aggregator.getDiscoveryList(), (brickId) => bricks.isSignedIn(brickId));
	if (rows.length === 0) {
		deps.showInfo('EVƎ Cockpit: no brick to forget. Only bricks this computer is paired with or remembers can be forgotten.');
		return;
	}
	const picked = await deps.pick(rows);
	if (!picked) { return; }

	// Named now: once forgotten, the brick is gone from the list its name comes from.
	const label = brickLabel(aggregator, picked.brickId);
	const agreed = await deps.confirm(
		`Forget ${label}?`,
		'It will be disconnected and unpaired from this computer, and EVƎ Cockpit will forget it. '
			+ 'If the brick is reachable, this computer is also removed from the brick\'s own Bluetooth list.',
		FORGET_ACTION,
	);
	if (!agreed) { return; }

	let report: ForgetReport;
	try {
		report = await deps.progress(`EVƎ Cockpit: forgetting ${label}`, () => bricks.forget(picked.brickId));
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		log.error(`Forgetting ${label} failed:`, err);
		deps.showError(`EVƎ Cockpit: could not forget ${label} — ${err.message}`);
		return;
	}
	for (const line of forgetDetails(report, label)) { log.info(line); }
	deps.showResult(forgetNotification(report, label));
}
