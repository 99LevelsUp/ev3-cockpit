/**
 * Asking the person at the terminal.
 *
 * The daemon decides what needs a person's yes (forgetting a brick, clearing its Bluetooth list,
 * switching access mode to `full`, a restart) and asks this terminal when the request is its own.
 * A person is there only when both stdin and stdout are a terminal and the output is not `--json`.
 * Git Bash's mintty, a pipe, a script and an agent's shell tool are not a terminal: there the
 * command registers no question handler, so every question goes unanswered and the daemon refuses
 * the action, naming the command a person can run.
 */

import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Question, QuestionAnswer } from '../contract/generated';
import type { QuestionContext } from '../client/nativeClient';

export interface PersonIo {
	readonly input: Readable;
	readonly output: Writable;
	/** Both input and output are a terminal. */
	readonly isTTY: boolean;
}

export class Confirmer {
	constructor(private readonly io: PersonIo, private readonly json: boolean, private readonly ownName?: string) {}

	/** A person can be asked here. */
	get canAsk(): boolean {
		return this.io.isTTY && !this.json;
	}

	/** Shows the question and reads one line; only `y` or `yes` is a yes. A withdrawn question reads nothing more. */
	ask(text: string, details: readonly string[] = [], signal?: AbortSignal): Promise<QuestionAnswer> {
		if (signal?.aborted) { return Promise.resolve('keep'); }
		for (const detail of details) { this.io.output.write(`  ${detail}\n`); }
		return new Promise((resolve) => {
			const rl = readline.createInterface({ input: this.io.input, output: this.io.output, terminal: false });
			let settled = false;
			const settle = (answer: QuestionAnswer): void => {
				if (settled) { return; }
				settled = true;
				signal?.removeEventListener('abort', onAbort);
				rl.close();
				resolve(answer);
			};
			const onAbort = (): void => {
				this.io.output.write('\nThe question was withdrawn.\n');
				settle('keep');
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			rl.once('close', () => settle('no'));
			rl.question(`${text} [y/N] `, (answer) => settle(/^\s*y(es)?\s*$/i.test(answer) ? 'yes' : 'no'));
		});
	}

	/** Answers a question the daemon asks this terminal, saying who asked when it was another client. */
	answer(question: Question, context?: QuestionContext): Promise<QuestionAnswer> {
		if (!this.canAsk) { return Promise.resolve('keep'); }
		const details = [...(question.details ?? [])];
		if ('requester' in question && question.requester.name !== this.ownName) {
			details.push(`Asked for ${question.requester.name} (${question.requester.kind}).`);
		}
		return this.ask(question.text, details, context?.signal);
	}
}
