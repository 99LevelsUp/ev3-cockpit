/**
 * The daemon's questions for a person, answered in VS Code.
 *
 * The daemon asks before every dangerous action, and the question names the client whose request
 * raised it. A question raised by another client (the `ev3` command, an AI agent over MCP, an
 * add-on) says who asked; one raised by this window does not need to.
 *
 * - A cut transfer's open slot (`sweep`): a notification with Release; dismissed, `keep`.
 * - Bluetooth access on Linux (`bluetoothAccess`): a dialog with the command that would run.
 * - Anything else: a dialog with the daemon's own text and one action; anything but it is `no`.
 *
 * Only for this window's own requests is the person offered to answer the same question the same
 * way for the rest of the session: the daemon keeps a remembered answer for the asker's own
 * requests alone, so offering it on another client's question would promise what does not happen.
 *
 * Free of `vscode`: the extension hands it a notification and a modal dialog.
 */

import type { ClientKind, Question, QuestionReply, Requester } from '../../contract/generated';

export interface QuestionUi {
	/** A notification with actions; resolves with the one chosen, or undefined when dismissed. */
	notify(message: string, ...actions: string[]): PromiseLike<string | undefined>;
	/** A modal dialog with actions; resolves with the one chosen, or undefined when cancelled. */
	modal(message: string, detail: string, ...actions: string[]): PromiseLike<string | undefined>;
}

export const RELEASE_ACTION = 'Release';
export const ADD_ME_ACTION = 'Add me';

/** The extra action that answers the same way for this window's later requests too. */
export const rememberAction = (action: string): string => `${action} (don't ask again)`;

const KIND_LABEL: Record<ClientKind, string> = {
	vscode: 'VS Code',
	cli: 'the ev3 command',
	mcp: 'an AI agent over MCP',
	addon: 'an add-on',
};

/** `an agent (an AI agent over MCP)`: who asked, as a person reads it. */
export function describeRequester(requester: Requester): string {
	return `${requester.name} (${KIND_LABEL[requester.kind] ?? requester.kind})`;
}

const sameClient = (a: Requester, b: Requester): boolean => a.name === b.name && a.kind === b.kind;

/** The action a question's dialog offers. */
function actionOf(question: Question): string {
	switch (question.kind) {
	case 'sweep': return RELEASE_ACTION;
	case 'forget': return 'Forget';
	case 'clearBluetoothList': return 'Clear';
	case 'setting': return 'Allow';
	case 'restart': return 'Restart';
	case 'bluetoothAccess': return ADD_ME_ACTION;
	case 'bluetoothCheckAgain': return 'Check again';
	default: return 'Yes';
	}
}

/**
 * Shows a question and returns the person's answer.
 *
 * @param me This window, as its hello named it: a question its own request raised is shown
 * without a requester and offers to remember the answer.
 */
export async function answerQuestion(question: Question, ui: QuestionUi, me?: Requester): Promise<QuestionReply> {
	const details = (question.details ?? []).join('\n');
	const requester = 'requester' in question ? question.requester : undefined;
	const own = requester !== undefined && me !== undefined && sameClient(requester, me);
	const text = requester && !own ? `${describeRequester(requester)} asks: ${question.text}` : question.text;
	const action = actionOf(question);
	const actions = own ? [action, rememberAction(action)] : [action];
	const reply = (chosen: string | undefined, otherwise: 'no' | 'keep'): QuestionReply => {
		if (chosen === action) { return { answer: 'yes' }; }
		if (own && chosen === rememberAction(action)) { return { answer: 'yes', remember: true }; }
		return { answer: otherwise };
	};
	switch (question.kind) {
	case 'sweep':
		return reply(await ui.notify(text, ...actions), 'keep');
	case 'bluetoothAccess':
		return reply(await ui.modal(text, details ? `It runs: ${details}` : '', ...actions), 'no');
	default:
		return reply(await ui.modal(text, details, ...actions), 'no');
	}
}
