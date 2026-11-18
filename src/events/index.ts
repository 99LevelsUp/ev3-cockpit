import * as vscode from 'vscode';

/** Anything that can be released. */
export interface Disposable {
	dispose(): void;
}

/**
 * Subscribes a listener; the returned disposable unsubscribes it. VS Code's `Event` call shape, so a
 * core event can be handed to a VS Code API that expects one.
 */
export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

/** Where a listener's error goes: the console, unless a host installs its own handler. */
let listenerErrorHandler: (error: unknown) => void = (error) => console.error('Event listener failed:', error);

/**
 * Replaces what happens to an error a listener throws, and returns the handler it replaced. The
 * error never reaches the code that fired the event, and the other listeners still run.
 */
export function setListenerErrorHandler(handler: (error: unknown) => void): (error: unknown) => void {
	const previous = listenerErrorHandler;
	listenerErrorHandler = handler;
	return previous;
}

interface Subscription<T> {
	readonly listener: (e: T) => unknown;
	readonly thisArgs: unknown;
	removed: boolean;
}

const NONE: Disposable = Object.freeze({ dispose: () => { /* nothing to release */ } });

/**
 * An event source that delivers as VS Code's `EventEmitter` does, so the core needs no `vscode`.
 * Observed on the real one (the emitter scenarios in the extension host): a listener that throws
 * does not stop the others; a listener added during a fire first hears the next one; a listener
 * removed during a fire, or every listener once the emitter is disposed, is not called again even
 * in that fire; and a fire from inside a listener is delivered after the current fire has reached
 * every listener, not in the middle of it.
 */
export class EventEmitter<T> implements Disposable {
	private subscriptions: Subscription<T>[] = [];
	private disposed = false;
	/** Fires waiting while a delivery runs, in order. */
	private readonly pending: T[] = [];
	private delivering = false;

	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		if (this.disposed) { return NONE; }
		const subscription: Subscription<T> = { listener, thisArgs, removed: false };
		this.subscriptions.push(subscription);
		const handle: Disposable = {
			dispose: () => {
				if (subscription.removed) { return; }
				subscription.removed = true;
				this.subscriptions = this.subscriptions.filter((s) => s !== subscription);
			},
		};
		disposables?.push(handle);
		return handle;
	};

	fire(data: T): void {
		if (this.disposed) { return; }
		this.pending.push(data);
		if (this.delivering) { return; }
		this.delivering = true;
		try {
			while (this.pending.length > 0 && !this.disposed) {
				const next = this.pending.shift() as T;
				for (const subscription of this.subscriptions.slice()) {
					if (subscription.removed || this.disposed) { continue; }
					try {
						subscription.listener.call(subscription.thisArgs, next);
					} catch (error) {
						listenerErrorHandler(error);
					}
				}
			}
		} finally {
			this.delivering = false;
			this.pending.length = 0;
		}
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const subscription of this.subscriptions) { subscription.removed = true; }
		this.subscriptions = [];
		this.pending.length = 0;
	}
}

/** A typed event source that wraps vscode.EventEmitter. */
export interface TypedEvent<T> extends vscode.Disposable {
    readonly event: vscode.Event<T>;
    fire(data: T): void;
}

export function createTypedEvent<T>(): TypedEvent<T> {
	const emitter = new vscode.EventEmitter<T>();
	return {
		event: emitter.event,
		fire: (data: T) => emitter.fire(data),
		dispose: () => emitter.dispose(),
	};
}

/**
 * Collects disposables and releases them all in reverse order on dispose().
 * Use in activate() to register services, then push the registry itself into
 * context.subscriptions.
 */
export class DisposableStore implements vscode.Disposable {
	private readonly items: vscode.Disposable[] = [];

	add<T extends vscode.Disposable>(item: T): T {
		this.items.push(item);
		return item;
	}

	dispose(): void {
		const toDispose = this.items.splice(0);
		for (let i = toDispose.length - 1; i >= 0; i--) {
			toDispose[i].dispose();
		}
	}
}
