/**
 * One end of a contract connection: JSON-RPC 2.0 framed the way LSP frames it, over any duplex
 * stream — a named pipe, a unix socket, or a pair of streams in a test.
 *
 * Built on `vscode-jsonrpc`, with three things it does not do on its own:
 * - when the stream closes, every pending request fails at once with `daemon_unavailable`
 *   instead of waiting forever;
 * - a message larger than the cap closes the connection, so a broken or hostile peer cannot make
 *   this process buffer without limit;
 * - a cancelled request is answered with the contract's own `cancelled` error.
 *
 * Both the daemon and its clients use it.
 */

import { Duplex, Transform, TransformCallback } from 'node:stream';
import {
	CancellationToken, CancellationTokenSource, createMessageConnection, MessageConnection, ProgressType, ResponseError,
	StreamMessageReader, StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
	ErrorKind, WireErrorCode, WireErrorData, errorKindOf, wireErrorNumber,
} from '../contract/errors';

/** A message larger than this closes the connection. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/** An error that crossed the wire, or one this side raises with a contract code. */
/** A refusal a person can lift: `command` is what they can run. */
export function needsPerson(message: string, command: string): ContractError {
	return new ContractError(WireErrorCode.NeedsPerson, message, { command, kind: 'NeedsPersonError' });
}

export class ContractError extends Error {
	readonly code: WireErrorCode;
	readonly kind: ErrorKind;
	readonly data: WireErrorData;

	constructor(code: WireErrorCode, message: string, extra: Partial<Omit<WireErrorData, 'code'>> = {}) {
		super(message);
		this.name = 'ContractError';
		this.code = code;
		this.kind = extra.kind ?? 'Unknown';
		this.data = { ...extra, code, kind: this.kind };
	}
}

/** What a request handler gets besides its parameters. */
export interface RequestContext {
	/** Aborts when the caller cancels or the connection closes. */
	readonly signal: AbortSignal;
	/** Reports progress, when the caller asked for it. */
	progress(value: unknown): void;
}

export type RequestHandler = (params: unknown, context: RequestContext) => unknown;

export interface RequestOptions {
	readonly signal?: AbortSignal;
	readonly onProgress?: (value: unknown) => void;
}

export interface Endpoint {
	request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T>;
	notify(method: string, params?: unknown): void;
	onRequest(method: string, handler: RequestHandler): void;
	/** Handles every request no `onRequest` handler took; the method name comes first. */
	onAnyRequest(handler: (method: string, params: unknown) => unknown): void;
	onNotification(method: string, handler: (params: unknown) => void): void;
	/** Called once, when the connection closes for any reason. */
	onClose(listener: () => void): void;
	readonly closed: boolean;
	close(): void;
}

export interface EndpointOptions {
	readonly maxMessageBytes?: number;
	/** Told when a message over the cap closed the connection. */
	readonly onOversize?: (bytes: number) => void;
}

/** The parameter a progress-reporting request carries its token in. */
const PROGRESS_TOKEN = '__progressToken';
const PROGRESS = new ProgressType<unknown>();

/**
 * Passes framed messages through and closes the stream on one whose declared length is over the
 * cap, before its body is read.
 */
class FrameGuard extends Transform {
	private header = '';
	private bodyLeft = 0;

	constructor(private readonly max: number, private readonly onOversize: (bytes: number) => void) {
		super();
	}

	override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
		let offset = 0;
		while (offset < chunk.length) {
			if (this.bodyLeft > 0) {
				const take = Math.min(this.bodyLeft, chunk.length - offset);
				this.push(chunk.subarray(offset, offset + take));
				this.bodyLeft -= take;
				offset += take;
				continue;
			}
			const end = chunk.indexOf('\r\n\r\n', offset, 'latin1');
			const slice = chunk.subarray(offset, end < 0 ? chunk.length : end + 4);
			this.header += slice.toString('latin1');
			offset += slice.length;
			if (end < 0) {
				if (this.header.length > 8192) { done(new Error('a message header was too long')); return; }
				continue;
			}
			const match = /Content-Length:\s*(\d+)/i.exec(this.header);
			const length = match ? Number(match[1]) : Number.NaN;
			if (!Number.isFinite(length)) { done(new Error('a message had no length')); return; }
			if (length > this.max) {
				this.onOversize(length);
				done(new Error(`a message of ${length} bytes is over the ${this.max}-byte limit`));
				return;
			}
			this.push(Buffer.from(this.header, 'latin1'));
			this.header = '';
			this.bodyLeft = length;
		}
		done();
	}
}

/** The error a handler's failure becomes on the wire. */
function toResponseError(error: unknown): ResponseError<WireErrorData> {
	if (error instanceof ResponseError) { return error as ResponseError<WireErrorData>; }
	if (error instanceof ContractError) {
		return new ResponseError(wireErrorNumber(error.code), error.message, error.data);
	}
	const known = error as { code?: unknown; name?: unknown; message?: unknown };
	const codes = Object.values(WireErrorCode) as string[];
	const code = typeof known?.code === 'string' && codes.includes(known.code)
		? known.code as WireErrorCode
		: WireErrorCode.Internal;
	const message = typeof known?.message === 'string' ? known.message : String(error);
	const kind = errorKindOf(typeof known?.name === 'string' ? known.name : undefined);
	return new ResponseError(wireErrorNumber(code), message, { code, kind });
}

/** The error a failed request rejects with on this side. */
function fromWire(error: unknown, closed: boolean): Error {
	if (error instanceof ResponseError) {
		const data = error.data as Partial<WireErrorData> | undefined;
		if (data && typeof data.code === 'string') {
			const { code, ...rest } = data;
			return new ContractError(code, error.message, rest);
		}
		if (closed) { return new ContractError(WireErrorCode.DaemonUnavailable, 'The connection closed before the answer came.'); }
		return new ContractError(WireErrorCode.InvalidRequest, error.message);
	}
	if (closed) { return new ContractError(WireErrorCode.DaemonUnavailable, 'The connection closed before the answer came.'); }
	return error instanceof Error ? error : new Error(String(error));
}

let nextProgressToken = 0;

export function createEndpoint(stream: Duplex, options: EndpointOptions = {}): Endpoint {
	const max = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
	const guard = new FrameGuard(max, (bytes) => options.onOversize?.(bytes));
	stream.pipe(guard);
	const connection: MessageConnection = createMessageConnection(
		new StreamMessageReader(guard),
		new StreamMessageWriter(stream),
	);
	let closed = false;
	const closeListeners: Array<() => void> = [];
	const inFlight = new Set<AbortController>();

	const shutdown = (): void => {
		if (closed) { return; }
		closed = true;
		for (const controller of inFlight) { controller.abort(); }
		inFlight.clear();
		// Disposing rejects every pending request at once.
		connection.dispose();
		stream.destroy();
		for (const listener of closeListeners.splice(0)) {
			try { listener(); } catch { /* a listener's own failure */ }
		}
	};
	guard.on('error', shutdown);
	stream.on('error', shutdown);
	stream.on('close', shutdown);
	stream.on('end', shutdown);
	connection.onClose(shutdown);
	connection.onError(() => { /* the stream's close follows */ });
	connection.listen();

	return {
		get closed() { return closed; },
		async request<T>(method: string, params?: unknown, requestOptions: RequestOptions = {}): Promise<T> {
			if (closed) { throw new ContractError(WireErrorCode.DaemonUnavailable, 'The connection is closed.'); }
			const source = new CancellationTokenSource();
			const abort = (): void => source.cancel();
			if (requestOptions.signal?.aborted) {
				throw new ContractError(WireErrorCode.Cancelled, `${method} was cancelled before it was sent.`);
			}
			requestOptions.signal?.addEventListener('abort', abort, { once: true });
			let progress: { dispose(): void } | undefined;
			let sent = params;
			if (requestOptions.onProgress) {
				const token = `p${++nextProgressToken}`;
				progress = connection.onProgress(PROGRESS, token, requestOptions.onProgress);
				sent = { ...(params as object | undefined), [PROGRESS_TOKEN]: token };
			}
			try {
				return await connection.sendRequest<T>(method, sent, source.token);
			} catch (error) {
				throw fromWire(error, closed);
			} finally {
				requestOptions.signal?.removeEventListener('abort', abort);
				progress?.dispose();
				source.dispose();
			}
		},
		notify(method: string, params?: unknown): void {
			if (closed) { return; }
			void connection.sendNotification(method, params).catch(() => { /* closing */ });
		},
		onRequest(method: string, handler: RequestHandler): void {
			connection.onRequest(method, async (params: unknown, token: CancellationToken) => {
				const controller = new AbortController();
				inFlight.add(controller);
				const cancel = token.onCancellationRequested(() => controller.abort());
				const token$ = (params as Record<string, unknown> | undefined)?.[PROGRESS_TOKEN];
				const clean = token$ === undefined ? params : (() => {
					const rest = { ...(params as Record<string, unknown>) };
					delete rest[PROGRESS_TOKEN];
					return rest;
				})();
				const context: RequestContext = {
					signal: controller.signal,
					progress: (value) => {
						if (typeof token$ === 'string' && !closed) {
							void connection.sendProgress(PROGRESS, token$, value).catch(() => { /* closing */ });
						}
					},
				};
				try {
					const result = await handler(clean, context);
					if (controller.signal.aborted) {
						throw new ContractError(WireErrorCode.Cancelled, `${method} was cancelled.`);
					}
					return result === undefined ? null : result;
				} catch (error) {
					if (controller.signal.aborted && !(error instanceof ContractError)) {
						throw toResponseError(new ContractError(WireErrorCode.Cancelled, `${method} was cancelled.`));
					}
					throw toResponseError(error);
				} finally {
					cancel.dispose();
					inFlight.delete(controller);
				}
			});
		},
		onAnyRequest(handler: (method: string, params: unknown) => unknown): void {
			connection.onRequest(async (method: string, params: unknown) => {
				try {
					const result = await handler(method, params);
					return result === undefined ? null : result;
				} catch (error) {
					throw toResponseError(error);
				}
			});
		},
		onNotification(method: string, handler: (params: unknown) => void): void {
			connection.onNotification(method, (params: unknown) => {
				try { handler(params); } catch { /* a handler's own failure */ }
			});
		},
		onClose(listener: () => void): void {
			if (closed) { queueMicrotask(listener); return; }
			closeListeners.push(listener);
		},
		close: shutdown,
	};
}
