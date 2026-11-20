/**
 * Questions for a person: the daemon asks the client that started an operation, and only that one.
 *
 * A client without a person — a script, `--json`, an agent — answers `keep`. A question nobody
 * answers in time, or whose client leaves, also counts as `keep`, never as `no`: `keep` leaves
 * things as they are, so a transfer debt is never dropped because nobody was there.
 */

import { randomBytes } from 'node:crypto';
import type { Endpoint } from '../client/connection';
import type { Question, QuestionAnswer, QuestionKind } from '../contract/models';

export const QUESTION_TIMEOUT_MS = 60_000;

export interface AskOptions {
	readonly kind: QuestionKind;
	readonly text: string;
	readonly brickId?: string;
	readonly details?: readonly string[];
	readonly timeoutMs?: number;
}

/** Asks a person through one client; resolves `keep` on silence, refusal or a closed connection. */
export async function ask(endpoint: Endpoint, options: AskOptions): Promise<QuestionAnswer> {
	if (endpoint.closed) { return 'keep'; }
	const timeoutMs = options.timeoutMs ?? QUESTION_TIMEOUT_MS;
	const question: Question = {
		questionId: randomBytes(6).toString('hex'),
		kind: options.kind,
		text: options.text,
		timeoutMs,
		...(options.brickId ? { brickId: options.brickId } : {}),
		...(options.details ? { details: options.details } : {}),
	};
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<QuestionAnswer>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			endpoint.notify('question/withdrawn', { questionId: question.questionId });
			resolve('keep');
		}, timeoutMs);
		timer.unref?.();
	});
	const answered = endpoint.request<{ answer?: unknown }>('question/ask', question, { signal: controller.signal })
		.then((reply): QuestionAnswer => (reply?.answer === 'yes' || reply?.answer === 'no' ? reply.answer : 'keep'))
		.catch((): QuestionAnswer => 'keep');
	try {
		return await Promise.race([answered, expired]);
	} finally {
		clearTimeout(timer);
	}
}
