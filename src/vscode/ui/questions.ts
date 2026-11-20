/**
 * The daemon's questions for a person, answered in VS Code (KTD8).
 *
 * - A cut transfer's open slot (`sweep`): a notification with Release; dismissed, `keep`.
 * - A development daemon asking to borrow a brick (`brickLoan`): a dialog naming the brick and who
 *   asks; anything but Lend keeps the brick.
 * - Bluetooth access on Linux (`bluetoothAccess`): a dialog with the command that would run.
 * - Anything else: a dialog with the daemon's own text.
 *
 * Free of `vscode`: the extension hands it a notification and a modal dialog.
 */

import type { Question, QuestionAnswer } from '../../contract/models';

export interface QuestionUi {
	/** A notification with actions; resolves with the one chosen, or undefined when dismissed. */
	notify(message: string, ...actions: string[]): PromiseLike<string | undefined>;
	/** A modal dialog with actions; resolves with the one chosen, or undefined when cancelled. */
	modal(message: string, detail: string, ...actions: string[]): PromiseLike<string | undefined>;
}

export const RELEASE_ACTION = 'Release';
export const LEND_ACTION = 'Lend';
export const ADD_ME_ACTION = 'Add me';

export async function answerQuestion(question: Question, ui: QuestionUi): Promise<QuestionAnswer> {
	const details = (question.details ?? []).join('\n');
	switch (question.kind) {
	case 'sweep':
		return (await ui.notify(question.text, RELEASE_ACTION)) === RELEASE_ACTION ? 'yes' : 'keep';
	case 'brickLoan':
		return (await ui.modal(question.text, details, LEND_ACTION)) === LEND_ACTION ? 'yes' : 'no';
	case 'bluetoothAccess':
		return (await ui.modal(question.text, details ? `It runs: ${details}` : '', ADD_ME_ACTION)) === ADD_ME_ACTION ? 'yes' : 'no';
	case 'forget':
		return (await ui.modal(question.text, details, 'Forget')) === 'Forget' ? 'yes' : 'no';
	case 'clearBluetoothList':
		return (await ui.modal(question.text, details, 'Clear')) === 'Clear' ? 'yes' : 'no';
	default:
		return (await ui.modal(question.text, details, 'Yes')) === 'Yes' ? 'yes' : 'no';
	}
}
