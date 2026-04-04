import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
	console.log('EV3 Cockpit activated');
	// Foundation only - no functionality yet
}

export function deactivate(): void {
	console.log('EV3 Cockpit deactivated');
}
