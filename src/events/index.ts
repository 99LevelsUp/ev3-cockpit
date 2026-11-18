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

/** One subscription; its listener and `this` are dropped when it is removed, so nothing holds them. */
interface Subscription<T> {
	listener: ((e: T) => unknown) | undefined;
	thisArgs: unknown;
}

/** One fire being delivered: the listeners subscribed when it started, and how far it has got. */
interface Delivery<T> {
	readonly value: T;
	readonly to: readonly Subscription<T>[];
	next: number;
}

const NONE: Disposable = Object.freeze({ dispose: () => { /* nothing to release */ } });

/**
 * An event source that delivers as VS Code's `EventEmitter` does, so the core needs no `vscode`.
 * Observed on the real one (the emitter scenarios in the extension host): a listener that throws
 * does not stop the others; a listener added during a fire first hears the next one; a listener
 * removed during a fire, or every listener once the emitter is disposed, is not called again even
 * in that fire; and a fire from inside a listener first finishes the fire in progress, then
 * delivers its own event to every listener, all before it returns.
 */
export class EventEmitter<T> implements Disposable {
	private subscriptions: Subscription<T>[] = [];
	private disposed = false;
	/** The fire in progress, which a fire from inside a listener finishes first. */
	private delivery: Delivery<T> | undefined;

	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		if (this.disposed) { return NONE; }
		const subscription: Subscription<T> = { listener, thisArgs };
		this.subscriptions.push(subscription);
		// Cleared on the first dispose, so a handle kept after it holds neither the emitter nor the listener.
		let remove: (() => void) | undefined = () => this.remove(subscription);
		const handle: Disposable = {
			dispose: () => {
				remove?.();
				remove = undefined;
			},
		};
		disposables?.push(handle);
		return handle;
	};

	fire(data: T): void {
		if (this.disposed) { return; }
		if (this.delivery) { this.deliver(this.delivery); }
		const delivery: Delivery<T> = { value: data, to: this.subscriptions.slice(), next: 0 };
		this.delivery = delivery;
		try {
			this.deliver(delivery);
		} finally {
			if (this.delivery === delivery) { this.delivery = undefined; }
		}
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const subscription of this.subscriptions) { release(subscription); }
		this.subscriptions = [];
		this.delivery = undefined;
	}

	private remove(subscription: Subscription<T>): void {
		release(subscription);
		this.subscriptions = this.subscriptions.filter((s) => s !== subscription);
	}

	/** Calls the listeners this delivery has not reached yet, skipping any removed meanwhile. */
	private deliver(delivery: Delivery<T>): void {
		while (delivery.next < delivery.to.length) {
			const subscription = delivery.to[delivery.next++];
			const listener = subscription.listener;
			if (!listener || this.disposed) { continue; }
			try {
				listener.call(subscription.thisArgs, delivery.value);
			} catch (error) {
				reportListenerError(error);
			}
		}
	}
}

function release<T>(subscription: Subscription<T>): void {
	subscription.listener = undefined;
	subscription.thisArgs = undefined;
}

/** Hands a listener's error to the handler; a handler that throws in turn must not stop delivery. */
function reportListenerError(error: unknown): void {
	try {
		listenerErrorHandler(error);
	} catch (handlerError) {
		console.error('Event listener error handler failed:', handlerError);
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
