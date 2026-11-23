/**
 * Minimal vscode module stub for unit tests running outside the extension host.
 *
 * Provides just enough of the vscode API surface to satisfy imports from
 * events/, contracts/, and runtime/ modules. `scripts/test-setup.mts` resolves `vscode` to this
 * file; Node runs it as TypeScript, and the compiled tests reach it through `require`.
 */

interface Disposed {
	dispose(): void;
}

type Listener<T> = (data: T) => void;

export class EventEmitter<T = unknown> {
	_listeners: Listener<T>[];
	_disposed: boolean;
	readonly event: (listener: Listener<T>) => Disposed;

	constructor() {
		this._listeners = [];
		this._disposed = false;
		this.event = (listener) => {
			if (this._disposed) { return { dispose() {} }; }
			this._listeners.push(listener);
			return {
				dispose: () => {
					const idx = this._listeners.indexOf(listener);
					if (idx >= 0) { this._listeners.splice(idx, 1); }
				},
			};
		};
	}

	fire(data: T): void {
		if (this._disposed) { return; }
		for (const listener of [...this._listeners]) {
			listener(data);
		}
	}

	dispose(): void {
		this._disposed = true;
		this._listeners.length = 0;
	}
}

export class Disposable {
	_callOnDispose: (() => void) | undefined;

	constructor(callOnDispose?: () => void) {
		this._callOnDispose = callOnDispose;
	}
	static from(...disposables: Disposed[]): Disposable {
		return new Disposable(() => {
			for (const d of disposables) { d.dispose(); }
		});
	}
	dispose(): void {
		if (this._callOnDispose) {
			this._callOnDispose();
			this._callOnDispose = undefined;
		}
	}
}
