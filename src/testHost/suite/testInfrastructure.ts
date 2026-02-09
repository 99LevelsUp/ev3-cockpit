import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const EXTENSION_ID = 'ev3-cockpit.ev3-cockpit';

export async function waitForCondition(
	label: string,
	condition: () => boolean,
	timeoutMs = 10_000
): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timeout while waiting for condition: ${label}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
}

export function toSafeIdentifierForTest(input: string): string {
	const normalized = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized.length > 0 ? normalized : 'active';
}

export async function withWorkspaceSettings<T>(
	settings: Record<string, unknown>,
	run: () => Promise<T>
): Promise<T> {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	const previousValues = new Map<string, unknown>();
	const keys = Object.keys(settings);
	const applyOrder = [...keys].sort((a, b) => {
		if (a === 'transport.mode' && b !== 'transport.mode') {
			return 1;
		}
		if (b === 'transport.mode' && a !== 'transport.mode') {
			return -1;
		}
		return 0;
	});
	const restoreOrder = [...applyOrder].reverse();

	for (const key of keys) {
		const inspected = cfg.inspect(key);
		previousValues.set(key, inspected?.workspaceValue);
	}

	for (const key of applyOrder) {
		await cfg.update(key, settings[key], vscode.ConfigurationTarget.Workspace);
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 150));

	try {
		return await run();
	} finally {
		for (const key of restoreOrder) {
			await cfg.update(key, previousValues.get(key), vscode.ConfigurationTarget.Workspace);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
	}
}

export async function withReconnectPromptChoice<T>(
	choice: 'Reconnect all' | 'Later',
	run: () => Promise<T>
): Promise<{ result: T; promptCount: number }> {
	type ShowInformationMessageFn = (...args: any[]) => Thenable<any>;
	const windowAny = vscode.window as unknown as {
		showInformationMessage: ShowInformationMessageFn;
	};
	const windowRecord = vscode.window as unknown as Record<string, unknown>;
	const originalShowInformationMessage = windowAny.showInformationMessage;
	let promptCount = 0;
	const patchedShowInformationMessage = ((...args: any[]) => {
		const message = args[0];
		if (typeof message === 'string' && message.startsWith('Connection settings changed. Reconnect ')) {
			promptCount += 1;
			return Promise.resolve(choice);
		}
		return originalShowInformationMessage(...args);
	}) as ShowInformationMessageFn;
	const setShowInformationMessage = (fn: ShowInformationMessageFn): void => {
		try {
			windowAny.showInformationMessage = fn;
		} catch {
			// Fall back to defineProperty below.
		}
		if (windowAny.showInformationMessage === fn) {
			return;
		}
		Object.defineProperty(windowRecord, 'showInformationMessage', {
			value: fn,
			configurable: true,
			writable: true
		});
		if (windowAny.showInformationMessage !== fn) {
			throw new Error('Unable to patch vscode.window.showInformationMessage for host test.');
		}
	};

	setShowInformationMessage(patchedShowInformationMessage);
	const probe = await windowAny.showInformationMessage(
		'Connection settings changed. Reconnect 1 brick(s) now to apply them?',
		'Reconnect all',
		'Later'
	);
	if (probe !== choice) {
		throw new Error('Patched reconnect prompt did not return expected choice in host test.');
	}
	promptCount = 0;
	try {
		const result = await run();
		return {
			result,
			promptCount
		};
	} finally {
		setShowInformationMessage(originalShowInformationMessage);
	}
}

/**
 * Wraps a test body so that any `showInformationMessage` calls whose text
 * matches batch-result patterns (e.g. "Batch reconnect finished …") are
 * auto-dismissed with `undefined` (no choice selected).  Without this,
 * `presentBatchResult` hangs forever because no user clicks the notification.
 */
export async function withAutoDismissedBatchPrompts<T>(run: () => Promise<T>): Promise<T> {
	type ShowInformationMessageFn = (...args: any[]) => Thenable<any>;
	const windowAny = vscode.window as unknown as { showInformationMessage: ShowInformationMessageFn };
	const windowRecord = vscode.window as unknown as Record<string, unknown>;
	const original = windowAny.showInformationMessage;
	const patched: ShowInformationMessageFn = (...args: any[]) => {
		const message = args[0];
		if (typeof message === 'string' && /^Batch .+ finished:/i.test(message)) {
			return Promise.resolve(undefined);
		}
		if (typeof message === 'string' && message.startsWith('Connection settings changed. Reconnect ')) {
			return Promise.resolve('Later');
		}
		return original(...args);
	};
	const set = (fn: ShowInformationMessageFn): void => {
		try {
			windowAny.showInformationMessage = fn;
		} catch {
			// fall through
		}
		if (windowAny.showInformationMessage === fn) {
			return;
		}
		Object.defineProperty(windowRecord, 'showInformationMessage', {
			value: fn,
			configurable: true,
			writable: true
		});
	};
	set(patched);
	try {
		return await run();
	} finally {
		set(original);
	}
}

export function sameFsPath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const normalized = path.normalize(value);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	return normalize(left) === normalize(right);
}

export function sameWorkspaceFolders(
	left: readonly vscode.WorkspaceFolder[] | undefined,
	right: readonly vscode.WorkspaceFolder[] | undefined
): boolean {
	const leftFolders = left ?? [];
	const rightFolders = right ?? [];
	if (leftFolders.length !== rightFolders.length) {
		return false;
	}
	for (let index = 0; index < leftFolders.length; index += 1) {
		if (!sameFsPath(leftFolders[index].uri.fsPath, rightFolders[index].uri.fsPath)) {
			return false;
		}
	}
	return true;
}

export async function withTemporaryWorkspaceFolder<T>(
	prepare: (workspaceFsPath: string) => Promise<void>,
	run: (workspaceUri: vscode.Uri) => Promise<T>
): Promise<T> {
	const originalFolders = vscode.workspace.workspaceFolders ?? [];
	const tempRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-host-workspace-'));
	const tempRootUri = vscode.Uri.file(tempRootPath);

	await prepare(tempRootPath);

	let replaced = false;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		replaced =
			vscode.workspace.updateWorkspaceFolders(0, originalFolders.length, {
				uri: tempRootUri,
				name: path.basename(tempRootPath)
			}) ?? false;
		if (replaced) {
			break;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 120));
	}
	assert.equal(replaced, true, 'Expected temporary workspace folder update to succeed.');
	await waitForCondition(
		'temporary workspace folder active',
		() => {
			const folders = vscode.workspace.workspaceFolders;
			return !!folders && folders.length === 1 && sameFsPath(folders[0].uri.fsPath, tempRootPath);
		},
		5_000
	);

	try {
		return await run(tempRootUri);
	} finally {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			if (sameWorkspaceFolders(vscode.workspace.workspaceFolders, originalFolders)) {
				break;
			}

			const currentFolders = vscode.workspace.workspaceFolders ?? [];
			vscode.workspace.updateWorkspaceFolders(
				0,
				currentFolders.length,
				...originalFolders.map((folder) => ({
					uri: folder.uri,
					name: folder.name
				}))
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 150));
		}
		await fs.rm(tempRootPath, {
			recursive: true,
			force: true
		});
	}
}

export const CASE_TIMEOUT_MS = 30_000;

export async function runCase(name: string, fn: () => Promise<void>): Promise<boolean> {
	const start = Date.now();
	try {
		await Promise.race([
			fn(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Test case timeout after ${CASE_TIMEOUT_MS}ms`)), CASE_TIMEOUT_MS)
			)
		]);
		const elapsed = (Date.now() - start).toFixed(1);
		console.log(`✔ ${name} (${elapsed}ms)`);
		return true;
	} catch (error) {
		const elapsed = (Date.now() - start).toFixed(1);
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		console.error(`✗ ${name} (${elapsed}ms)\n  ${message}`);
		return false;
	}
}

/**
 * Baseline workspace settings. Any test-specific overrides are applied via
 * `withWorkspaceSettings` and restored in its `finally` block.  However, some
 * tests mutate additional keys inside their body (e.g. `connectWithPort` changes
 * `transport.tcp.port`).  When a test fails mid-flight those keys may survive in
 * the workspace `settings.json`.  Resetting to this baseline at suite start
 * guarantees a clean slate regardless of previous-run leftovers.
 */
export const BASELINE_WORKSPACE_SETTINGS: Record<string, unknown> = {
	'transport.timeoutMs': 200,
	'transport.mode': 'mock',
};

/**
 * Keys that tests may set but are NOT part of the baseline.
 * They must be explicitly removed (set to `undefined`) so that previous-run
 * leftovers do not pollute the current run.
 */
export const WORKSPACE_SETTINGS_KEYS_TO_CLEAR: string[] = [
	'transport.tcp.host',
	'transport.tcp.port',
	'transport.tcp.useDiscovery',
	'transport.tcp.discoveryPort',
	'transport.tcp.discoveryTimeoutMs',
	'transport.tcp.handshakeTimeoutMs',
	'deploy.includeGlobs',
];

export async function resetWorkspaceSettings(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	for (const key of WORKSPACE_SETTINGS_KEYS_TO_CLEAR) {
		await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
	}
	for (const [key, value] of Object.entries(BASELINE_WORKSPACE_SETTINGS)) {
		await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 200));
}
