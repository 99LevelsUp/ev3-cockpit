/**
 * Asking the person at the terminal.
 *
 * A person is there only when both stdin and stdout are a terminal and the output is not `--json`.
 * Git Bash's mintty, a pipe, a script and an agent's shell tool are not a terminal: there the
 * command never waits for an answer. What needs a person's yes — switching access mode to `full`,
 * restarting the daemon — is refused with a message saying a person has to run and confirm it, and
 * every question the daemon asks (forgetting a brick, clearing its Bluetooth list) is answered
 * `keep`, which leaves things as they are.
 */

import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import type { Question, QuestionAnswer } from '../contract/models';

export interface PersonIo {
	readonly input: Readable;
	readonly output: Writable;
	/** Both input and output are a terminal. */
	readonly isTTY: boolean;
}

/** What to ask before an action, and what to say when nobody can be asked. */
export interface Confirmation {
	readonly text: string;
	readonly details?: readonly string[];
	/** Why the action needs a person, shown when there is none. */
	readonly refusal: string;
	/** The command the person should run. */
	readonly command: string;
}

/** The refusal for a setting only a person may change. */
export function settingRefusal(command: string): string {
	return `This needs a person's confirmation: run ${command} yourself in an interactive terminal, or use EVƎ: Settings in VS Code.`;
}

/** The refusal for anything else only a person may do. */
export function terminalRefusal(command: string): string {
	return `This needs a person's confirmation: a person has to run ${command} in an interactive terminal and confirm it.`;
}

export class Confirmer {
	constructor(private readonly io: PersonIo, private readonly json: boolean) {}

	/** A person can be asked here. */
	get canAsk(): boolean {
		return this.io.isTTY && !this.json;
	}

	/** Shows the question and reads one line; only `y` or `yes` is a yes. */
	ask(text: string, details: readonly string[] = []): Promise<boolean> {
		for (const detail of details) { this.io.output.write(`  ${detail}\n`); }
		return new Promise((resolve) => {
			const rl = readline.createInterface({ input: this.io.input, output: this.io.output, terminal: false });
			let answered = false;
			rl.once('close', () => { if (!answered) { resolve(false); } });
			rl.question(`${text} [y/N] `, (answer) => {
				answered = true;
				rl.close();
				resolve(/^\s*y(es)?\s*$/i.test(answer));
			});
		});
	}

	/**
	 * Asks before an action only a person may take. Resolves whether the person said yes; with
	 * nobody to ask, throws `needs_person` without reading anything.
	 */
	async confirm(confirmation: Confirmation): Promise<boolean> {
		if (!this.canAsk) {
			throw new ContractError(WireErrorCode.NeedsPerson, confirmation.refusal, { command: confirmation.command, kind: 'NeedsPersonError' });
		}
		return this.ask(confirmation.text, confirmation.details);
	}

	/** Answers a question the daemon asks for a person; with nobody to ask, `keep`. */
	async answer(question: Question): Promise<QuestionAnswer> {
		if (!this.canAsk) { return 'keep'; }
		return (await this.ask(question.text, question.details)) ? 'yes' : 'no';
	}
}
