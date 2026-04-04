import * as vscode from 'vscode';

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
