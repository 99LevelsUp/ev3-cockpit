import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "ev3io" is now active');

	const disposable = vscode.commands.registerCommand('ev3io.connectEV3', () => {
		vscode.window.showInformationMessage('Connecting to EV3 robot...');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
