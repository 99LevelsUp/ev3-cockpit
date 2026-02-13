import * as vscode from 'vscode';

export interface MockCommandRegistrations {
	mockReset: vscode.Disposable;
	mockShowState: vscode.Disposable;
}

export function registerMockCommands(): MockCommandRegistrations {
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

	return { mockReset, mockShowState };
}
