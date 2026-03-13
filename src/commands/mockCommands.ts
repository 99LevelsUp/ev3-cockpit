/**
 * VS Code commands for managing mock bricks (create, reset, inject faults).
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import type { BrickConnectionProfileStore } from '../device/brickConnectionProfiles';

/**
 * Disposable registrations returned by {@link registerMockCommands}.
 *
 * @remarks
 * Each property is a VS Code command disposable that should be pushed
 * into the extension context's subscriptions for proper lifecycle management.
 */
export interface MockCommandRegistrations {
	/** Resets mock transport state (requires reconnect to take effect). */
	mockReset: vscode.Disposable;
	/** Opens a document showing current mock transport status. */
	mockShowState: vscode.Disposable;
	/** Toggles the `ev3-cockpit.mock` workspace setting on/off. */
	mockToggleDiscovery: vscode.Disposable;
	/** Prompts the user to select and delete persisted brick connection profiles. */
	clearBrickProfiles: vscode.Disposable;
}

/**
 * External dependencies injected into {@link registerMockCommands}.
 */
export interface MockCommandDeps {
	/**
	 * Store for persisted brick connection profiles.
	 *
	 * @see {@link BrickConnectionProfileStore}
	 */
	profileStore: BrickConnectionProfileStore;
}

/**
 * Registers VS Code commands for mock transport management and brick profile maintenance.
 *
 * @remarks
 * Commands registered:
 * | Command ID | Action |
 * |---|---|
 * | `ev3-cockpit.mock.reset` | Shows info that mock state requires reconnect after reset |
 * | `ev3-cockpit.mock.showState` | Opens a virtual document showing transport mode and mock status |
 * | `ev3-cockpit.mock.toggleDiscovery` | Toggles `ev3-cockpit.mock` workspace setting |
 * | `ev3-cockpit.clearBrickProfiles` | Multi-select QuickPick to delete saved brick profiles |
 *
 * @param deps - External dependencies (profile store).
 * @returns Disposable registrations for all four commands.
 *
 * @example
 * ```ts
 * const registrations = registerMockCommands({ profileStore });
 * context.subscriptions.push(
 *   registrations.mockReset,
 *   registrations.mockShowState,
 *   registrations.mockToggleDiscovery,
 *   registrations.clearBrickProfiles
 * );
 * ```
 *
 * @see {@link MockCommandDeps}
 * @see {@link MockCommandRegistrations}
 */
export function registerMockCommands(deps: MockCommandDeps): MockCommandRegistrations {
	// --- Command: mock.reset — placeholder until MockWorld is wired ---
	const mockReset = vscode.commands.registerCommand('ev3-cockpit.mock.reset', async () => {
		// MockWorld reset will be wired when MockWorld is accessible from extension context.
		// For now, show info that mock mode requires reconnect after reset.
		vscode.window.showInformationMessage(
			'EVƎ Mock: Reset requested. Disconnect and reconnect to reload mock state.'
		);
	});

	// --- Command: mock.showState — reads current config and opens a virtual document ---
	const mockShowState = vscode.commands.registerCommand('ev3-cockpit.mock.showState', async () => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get<string>('transport.mode', 'usb');
		const isMock = mode === 'mock';

		const lines: string[] = [
			`Transport mode: ${mode}`,
			`Mock active: ${isMock ? 'YES' : 'NO'}`,
			'',
			isMock
				? 'Mock transport is active. The extension simulates an EVƎ brick with virtual sensors, motors, and filesystem.'
				: 'Mock transport is not active. Set ev3-cockpit.transport.mode to "mock" to enable.'
		];

		const doc = await vscode.workspace.openTextDocument({
			content: lines.join('\n'),
			language: 'plaintext'
		});
		await vscode.window.showTextDocument(doc, { preview: true });
	});

	// --- Command: mock.toggleDiscovery — flips the workspace-level mock flag ---
	const mockToggleDiscovery = vscode.commands.registerCommand('ev3-cockpit.mock.toggleDiscovery', async () => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const current = cfg.get<boolean>('mock', false);
		await cfg.update('mock', !current, vscode.ConfigurationTarget.Workspace);
	});

	// --- Command: clearBrickProfiles — multi-select deletion of persisted profiles ---
	const clearBrickProfiles = vscode.commands.registerCommand('ev3-cockpit.clearBrickProfiles', async () => {
		const profiles = deps.profileStore.list();
		if (profiles.length === 0) {
			vscode.window.showInformationMessage('No saved brick profiles to clear.');
			return;
		}

		const items = profiles.map(profile => ({
			label: profile.displayName,
			description: `${profile.transport.mode} • ${profile.brickId}`,
			profile
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select brick profiles to delete (Esc to cancel)',
			canPickMany: true
		});

		if (!selected || selected.length === 0) {
			return;
		}

		const confirm = await vscode.window.showWarningMessage(
			`Delete ${selected.length} brick profile(s)?`,
			{ modal: true },
			'Delete'
		);

		if (confirm !== 'Delete') {
			return;
		}

		let deleted = 0;
		for (const item of selected) {
			const removed = await deps.profileStore.remove(item.profile.brickId);
			if (removed) {
				deleted += 1;
			}
		}

		vscode.window.showInformationMessage(`Deleted ${deleted} brick profile(s).`);
	});

	return { mockReset, mockShowState, mockToggleDiscovery, clearBrickProfiles };
}
