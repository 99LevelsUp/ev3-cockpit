/**
 * One lifetime for everything a provider starts (review of the ownership area, round 4).
 *
 * Three rounds of review found a dispose or a close that some operation outlived — a connect in
 * its clear-halt, a probe in its serial lookup, a connect waiting out the reconnect gap — each
 * fixed by a check someone remembered to write in one place. The scope makes it structural:
 * every public operation runs inside it and gets its signal; a dispose aborts that signal and
 * waits for every operation to settle, cleanup included; after a dispose nothing new starts.
 */

import { TransportError } from '../errors/CockpitError';

export class LifetimeScope {
	private readonly controller = new AbortController();
	private readonly running = new Set<Promise<unknown>>();
	private disposing?: Promise<void>;

	/** @param owner Named in the error a refused operation gets ("UsbTransportProvider"). */
	constructor(private readonly owner: string) {}

	/** Aborted once the scope is disposed. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get disposed(): boolean {
		return this.controller.signal.aborted;
	}

	/**
	 * Runs `operation` inside the scope.
	 *
	 * The operation checks `signal` after every wait (`signal.throwIfAborted()`) and cleans up what
	 * it owns when it throws; a dispose waits for exactly that.
	 *
	 * @throws {TransportError} At once, without running anything, after the scope is disposed.
	 */
	run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.disposed) {
			return Promise.reject(this.disposedError());
		}
		// Started at once, not a microtask later: callers that schedule around one another (the
		// discovery scheduler) see the same ordering as without the scope.
		let result: Promise<T>;
		try {
			result = operation(this.controller.signal);
		} catch (error) {
			result = Promise.reject(error);
		}
		this.running.add(result);
		const forget = (): void => { this.running.delete(result); };
		result.then(forget, forget);
		return result;
	}

	/** Aborts every operation and resolves once each has settled. Never rejects. */
	dispose(): Promise<void> {
		if (!this.disposing) {
			this.controller.abort(this.disposedError());
			this.disposing = this.settleAll();
		}
		return this.disposing;
	}

	private async settleAll(): Promise<void> {
		// Operations may start more operations' cleanup; wait until none is left.
		while (this.running.size > 0) {
			await Promise.allSettled([...this.running]);
		}
	}

	private disposedError(): TransportError {
		return new TransportError(`${this.owner} has been disposed.`);
	}
}

/**
 * Waits `ms`, or ends at once with the signal's reason when it aborts. The timer is unref'd: a
 * wait must not by itself keep the extension host's process alive.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
		timer.unref?.();
		const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
