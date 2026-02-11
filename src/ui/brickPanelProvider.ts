import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';

export interface BrickPanelDataSource {
	listBricks(): BrickSnapshot[];
	setActiveBrick(brickId: string): boolean;
}

interface WebviewBrickInfo {
	brickId: string;
	displayName: string;
	status: string;
	transport: string;
	role: string;
	isActive: boolean;
	lastError?: string;
	lastOperation?: string;
}

type MessageFromWebview =
	| { type: 'selectBrick'; brickId: string }
	| { type: 'ready' };

type MessageToWebview =
	| { type: 'updateBricks'; bricks: WebviewBrickInfo[] };

export interface BrickPanelPollingConfig {
	/** Polling interval (ms) when at least one brick exists. Default 500. */
	activeIntervalMs?: number;
	/** Polling interval (ms) when no bricks are known. Default 3000. */
	idleIntervalMs?: number;
}

export class BrickPanelProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ev3-cockpit.brickPanel';

	private view?: vscode.WebviewView;
	private onDidChangeActive?: () => void;
	private pollingTimer?: ReturnType<typeof setTimeout>;
	private readonly activeIntervalMs: number;
	private readonly idleIntervalMs: number;

	public constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly dataSource: BrickPanelDataSource,
		config?: BrickPanelPollingConfig
	) {
		this.activeIntervalMs = config?.activeIntervalMs ?? 500;
		this.idleIntervalMs = config?.idleIntervalMs ?? 3_000;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message: MessageFromWebview) => {
			if (message.type === 'selectBrick') {
				const changed = this.dataSource.setActiveBrick(message.brickId);
				if (changed && this.onDidChangeActive) {
					this.onDidChangeActive();
				}
				this.refresh();
			} else if (message.type === 'ready') {
				this.refresh();
			}
		});

		webviewView.onDidDispose(() => {
			this.stopPolling();
			this.view = undefined;
		});

		this.startPolling();
	}

	public setOnDidChangeActive(callback: () => void): void {
		this.onDidChangeActive = callback;
	}

	public refresh(): void {
		if (!this.view) {
			return;
		}
		const bricks: WebviewBrickInfo[] = this.dataSource.listBricks().map((s) => ({
			brickId: s.brickId,
			displayName: s.displayName,
			status: s.status,
			transport: s.transport,
			role: s.role,
			isActive: s.isActive,
			lastError: s.lastError,
			lastOperation: s.lastOperation
		}));
		const message: MessageToWebview = { type: 'updateBricks', bricks };
		void this.view.webview.postMessage(message);
	}

	private startPolling(): void {
		this.stopPolling();
		const tick = () => {
			if (!this.view) {
				return;
			}
			const bricks = this.dataSource.listBricks();
			this.refresh();
			const delay = bricks.length > 0 ? this.activeIntervalMs : this.idleIntervalMs;
			this.pollingTimer = setTimeout(tick, delay);
			this.pollingTimer.unref?.();
		};
		const initialDelay = this.dataSource.listBricks().length > 0
			? this.activeIntervalMs
			: this.idleIntervalMs;
		this.pollingTimer = setTimeout(tick, initialDelay);
		this.pollingTimer.unref?.();
	}

	private stopPolling(): void {
		if (this.pollingTimer) {
			clearTimeout(this.pollingTimer);
			this.pollingTimer = undefined;
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		padding: 0;
		margin: 0;
	}
	.brick-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px;
	}
	.brick-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border: 1px solid var(--vscode-panel-border, #444);
		border-radius: 4px;
		cursor: pointer;
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		font-size: var(--vscode-font-size);
	}
	.brick-tab:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.brick-tab.active {
		background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground);
		border-color: var(--vscode-focusBorder);
	}
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.status-READY { background: #4ec940; }
	.status-CONNECTING { background: #dea500; }
	.status-UNAVAILABLE { background: #888; }
	.status-ERROR { background: #f44; }
	.brick-info {
		padding: 12px;
		border-top: 1px solid var(--vscode-panel-border, #444);
	}
	.brick-info dt {
		font-weight: bold;
		margin-top: 8px;
	}
	.brick-info dd {
		margin: 2px 0 0 0;
		opacity: 0.85;
	}
	.empty-message {
		padding: 16px;
		opacity: 0.7;
		text-align: center;
	}
	.error-text {
		color: var(--vscode-errorForeground, #f44);
	}
</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		let bricks = [];

		function render() {
			const root = document.getElementById('root');
			if (bricks.length === 0) {
				root.innerHTML = '<div class="empty-message">No bricks connected.<br>Run "EV3 Cockpit: Connect to EV3 Brick" to get started.</div>';
				return;
			}

			const activeBrick = bricks.find(b => b.isActive);

			let html = '<div class="brick-tabs">';
			for (const brick of bricks) {
				const activeClass = brick.isActive ? ' active' : '';
				html += '<button class="brick-tab' + activeClass + '" data-brick-id="' + brick.brickId + '">'
					+ '<span class="status-dot status-' + brick.status + '"></span>'
					+ brick.displayName
					+ '</button>';
			}
			html += '</div>';

			if (activeBrick) {
				html += '<div class="brick-info"><dl>'
					+ '<dt>Status</dt><dd>' + activeBrick.status + '</dd>'
					+ '<dt>Transport</dt><dd>' + activeBrick.transport + '</dd>'
					+ '<dt>Role</dt><dd>' + activeBrick.role + '</dd>';
				if (activeBrick.lastOperation) {
					html += '<dt>Last Operation</dt><dd>' + activeBrick.lastOperation + '</dd>';
				}
				if (activeBrick.lastError) {
					html += '<dt>Last Error</dt><dd class="error-text">' + activeBrick.lastError + '</dd>';
				}
				html += '</dl></div>';
			}

			root.innerHTML = html;

			for (const tab of root.querySelectorAll('.brick-tab')) {
				tab.addEventListener('click', () => {
					vscode.postMessage({ type: 'selectBrick', brickId: tab.dataset.brickId });
				});
			}
		}

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'updateBricks') {
				bricks = message.bricks;
				render();
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
