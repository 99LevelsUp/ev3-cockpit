import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

async function withExtensionCommandsModule<T>(
	run: (mod: {
		createTreeFilterState: (getRefreshTree: () => (() => void)) => {
			getQuery: () => string;
			setQuery: (query: string) => Promise<void>;
		};
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;

	const executedCommands: Array<{ command: string; args: unknown[] }> = [];
	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return {
				commands: {
					executeCommand: async (command: string, ...args: unknown[]) => {
						executedCommands.push({ command, args });
					}
				}
			};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('../activation/extensionCommands') as {
			createTreeFilterState: (getRefreshTree: () => (() => void)) => {
				getQuery: () => string;
				setQuery: (query: string) => Promise<void>;
			};
		};
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

// --- createTreeFilterState ---

test('createTreeFilterState initial query is empty', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		const state = createTreeFilterState(() => () => {});
		assert.equal(state.getQuery(), '');
	});
});

test('createTreeFilterState setQuery updates the query', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		const state = createTreeFilterState(() => () => {});
		await state.setQuery('EV3 TCP');
		assert.equal(state.getQuery(), 'EV3 TCP');
	});
});

test('createTreeFilterState trims whitespace from query', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		const state = createTreeFilterState(() => () => {});
		await state.setQuery('  hello world  ');
		assert.equal(state.getQuery(), 'hello world');
	});
});

test('createTreeFilterState skips update when normalized query is unchanged', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		let refreshCount = 0;
		const state = createTreeFilterState(() => () => { refreshCount += 1; });
		await state.setQuery('test');
		assert.equal(refreshCount, 1);
		await state.setQuery('  test  ');
		assert.equal(refreshCount, 1);
	});
});

test('createTreeFilterState calls refreshTree on query change', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		let refreshCount = 0;
		const state = createTreeFilterState(() => () => { refreshCount += 1; });
		await state.setQuery('filter1');
		assert.equal(refreshCount, 1);
		await state.setQuery('filter2');
		assert.equal(refreshCount, 2);
	});
});

test('createTreeFilterState clearing query triggers refresh', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		let refreshCount = 0;
		const state = createTreeFilterState(() => () => { refreshCount += 1; });
		await state.setQuery('something');
		await state.setQuery('');
		assert.equal(refreshCount, 2);
		assert.equal(state.getQuery(), '');
	});
});

test('createTreeFilterState resolves getRefreshTree lazily', async () => {
	await withExtensionCommandsModule(async ({ createTreeFilterState }) => {
		const calls: string[] = [];
		let currentRefresher = () => { calls.push('first'); };
		const state = createTreeFilterState(() => currentRefresher);
		await state.setQuery('a');
		currentRefresher = () => { calls.push('second'); };
		await state.setQuery('b');
		assert.deepEqual(calls, ['first', 'second']);
	});
});
