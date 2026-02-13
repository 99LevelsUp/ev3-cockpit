import * as vscode from 'vscode';
import type { BrickConnectionProfileStore } from '../device/brickConnectionProfiles';

export interface MockCommandRegistrations {
	mockReset: vscode.Disposable;
	mockShowState: vscode.Disposable;
	clearBrickProfiles: vscode.Disposable;
}

export interface MockCommandDeps {
	profileStore: BrickConnectionProfileStore;
}

export function registerMockCommands(deps: MockCommandDeps): MockCommandRegistrations {
	const mockReset = vscode.commands.registerCommand('ev3-cockpit.mock.reset', async () => {
		// MockWorld reset will be wired when MockWorld is accessible from extension context.
		// For now, show info that mock mode requires reconnect after reset.
		vscode.window.showInformationMessage(
			'EV3 Mock: Reset requested. Disconnect and reconnect to reload mock state.'
		);
	});

	const mockShowState = vscode.commands.registerCommand('ev3-cockpit.mock.showState', async () => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get<string>('transport.mode', 'usb');
		const isMock = mode === 'mock';

		const lines: string[] = [
			`Transport mode: ${mode}`,
			`Mock active: ${isMock ? 'YES' : 'NO'}`,
			'',
			isMock
				? 'Mock transport is active. The extension simulates an EV3 brick with virtual sensors, motors, and filesystem.'
				: 'Mock transport is not active. Set ev3-cockpit.transport.mode to "mock" to enable.'
		];

		const doc = await vscode.workspace.openTextDocument({
			content: lines.join('\n'),
			language: 'plaintext'
		});
		await vscode.window.showTextDocument(doc, { preview: true });
	});

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

	return { mockReset, mockShowState, clearBrickProfiles };
}
