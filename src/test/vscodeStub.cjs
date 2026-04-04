/**
 * Minimal vscode module stub for unit tests running outside the extension host.
 *
 * Provides just enough of the vscode API surface to satisfy imports from
 * events/, contracts/, and runtime/ modules.
 */
'use strict';

class EventEmitter {
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

	fire(data) {
		if (this._disposed) { return; }
		for (const listener of [...this._listeners]) {
			listener(data);
		}
	}

	dispose() {
		this._disposed = true;
		this._listeners.length = 0;
	}
}

class Disposable {
	constructor(callOnDispose) {
		this._callOnDispose = callOnDispose;
	}
	static from(...disposables) {
		return new Disposable(() => {
			for (const d of disposables) { d.dispose(); }
		});
	}
	dispose() {
		if (this._callOnDispose) {
			this._callOnDispose();
			this._callOnDispose = undefined;
		}
	}
}

module.exports = { EventEmitter, Disposable };
