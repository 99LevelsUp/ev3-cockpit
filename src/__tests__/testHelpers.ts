export interface FakeMemento {
	values: Record<string, unknown>;
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
}

export function createFakeMemento(initial: Record<string, unknown> = {}): FakeMemento {
	return {
		values: { ...initial },
		get<T>(key: string): T | undefined {
			return this.values[key] as T | undefined;
		},
		update(key: string, value: unknown): Promise<void> {
			this.values[key] = value;
			return Promise.resolve();
		}
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeDisposable {
	public constructor(private readonly disposer: () => void) {}
	public dispose(): void {
		this.disposer();
	}
}

export class FakeEventEmitter<T> {
	public readonly event = (_listener: (event: T) => unknown) => new FakeDisposable(() => undefined);
	public fire(_event: T): void {}
}

export class FakeTreeItem {
	public id?: string;
	public description?: string;
	public tooltip?: string;
	public contextValue?: string;
	public iconPath?: unknown;
	public resourceUri?: { toString: () => string };
	public command?: { command: string; title: string; arguments?: unknown[] };
	public constructor(
		public label: string,
		public collapsibleState: number
	) {}
}

export class FakeThemeIcon {
	public constructor(public readonly id: string) {}
}

export const FakeTreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const FakeUri = { parse: (value: string) => ({ toString: () => value }) };

export function createVscodeMock() {
	return {
		Disposable: FakeDisposable,
		EventEmitter: FakeEventEmitter,
		TreeItem: FakeTreeItem,
		ThemeIcon: FakeThemeIcon,
		TreeItemCollapsibleState: FakeTreeItemCollapsibleState,
		Uri: FakeUri
	};
}
