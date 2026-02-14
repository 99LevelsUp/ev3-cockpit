import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';
import type { ButtonState } from '../device/buttonService';
import type { LedPattern } from '../device/ledService';
import type { MotorState } from '../device/motorTypes';
import type { SensorInfo } from '../device/sensorTypes';
import { getWebviewTabActionIcons, getWebviewTransportIcons } from './graphicsLibrary';

export interface BrickPanelDataSource {
	listBricks(): BrickSnapshot[];
	setActiveBrick(brickId: string): boolean;
	scanAvailableBricks?(): Promise<BrickPanelDiscoveryCandidate[]>;
	connectScannedBrick?(candidateId: string): Promise<void>;
	disconnectBrick?(brickId: string): Promise<void>;
	setMockConnection?(candidateId: string, connected: boolean): Promise<void>;
	applyPendingConfigChanges?(request: BrickPanelConfigApplyRequest): Promise<BrickPanelConfigApplyResult | void>;
	discardPendingConfigChanges?(brickId: string): Promise<void>;
	getSensorInfo?(brickId: string): SensorInfo[] | undefined;
	getMotorInfo?(brickId: string): MotorState[] | undefined;
	getButtonState?(brickId: string): ButtonState | undefined;
	getLedPattern?(brickId: string): LedPattern | undefined;
}

export interface BrickPanelConfigApplyRequest {
	brickId: string;
	brickName: string;
}

export interface BrickPanelConfigApplyResult {
	brickName?: string;
	relatedBrickIds?: string[];
}

export interface BrickPanelDiscoveryCandidate {
	candidateId: string;
	displayName: string;
	transport: 'usb' | 'bt' | 'tcp' | 'mock' | 'unknown';
	status?: 'AVAILABLE' | 'READY' | 'CONNECTING' | 'UNAVAILABLE' | 'ERROR' | 'UNKNOWN';
	detail?: string;
	alreadyConnected?: boolean;
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
	| { type: 'scanBricks' }
	| { type: 'connectScannedBrick'; candidateId: string }
	| { type: 'disconnectBrick'; brickId: string }
	| { type: 'setMockConnection'; candidateId: string; connected: boolean }
	| { type: 'applyConfigChanges'; brickId: string; brickName: string }
	| { type: 'discardConfigChanges'; brickId: string }
	| { type: 'ready' };

interface WebviewSensorInfo {
	port: number;
	layer?: number;
	typeName: string;
	mode: number;
	connected: boolean;
}

interface WebviewMotorInfo {
	port: string;
	layer?: number;
	speed: number;
	running: boolean;
}

interface WebviewControlsInfo {
	buttonName?: string;
	ledPattern?: number;
}

type MessageToWebview =
	| { type: 'updateBricks'; bricks: WebviewBrickInfo[]; sensors?: WebviewSensorInfo[]; motors?: WebviewMotorInfo[]; controls?: WebviewControlsInfo }
	| { type: 'scanStarted' }
	| { type: 'scanResults'; candidates: BrickPanelDiscoveryCandidate[] }
	| { type: 'scanFailed'; message: string }
	| { type: 'connectStarted'; candidateId: string }
	| { type: 'connectFailed'; candidateId: string; message: string }
	| { type: 'connectSucceeded'; candidateId: string }
	| { type: 'configApplied'; brickId: string; brickName?: string; relatedBrickIds?: string[] }
	| { type: 'configDiscarded'; brickId: string }
	| { type: 'configActionFailed'; action: 'apply' | 'discard'; brickId: string; message: string };

export interface BrickPanelPollingConfig {
	/** Polling interval (ms) when at least one brick exists. Default 500. */
	activeIntervalMs?: number;
	/** Polling interval (ms) when no bricks are known. Default 3000. */
	idleIntervalMs?: number;
	/** Discovery refresh interval (ms) while + tab is active. Default 2500. */
	discoveryRefreshFastMs?: number;
	/** Discovery refresh interval (ms) while + tab is not active. Default 15000. */
	discoveryRefreshSlowMs?: number;
}

function sanitizeIntervalMs(value: number | undefined, fallback: number, min: number): number {
	if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.floor(value));
}

export class BrickPanelProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ev3-cockpit.brick';

	private view?: vscode.WebviewView;
	private onDidChangeActive?: () => void;
	private pollingTimer?: ReturnType<typeof setTimeout>;
	private readonly activeIntervalMs: number;
	private readonly idleIntervalMs: number;
	private readonly discoveryRefreshFastMs: number;
	private readonly discoveryRefreshSlowMs: number;

	public constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly dataSource: BrickPanelDataSource,
		config?: BrickPanelPollingConfig
	) {
		this.activeIntervalMs = config?.activeIntervalMs ?? 500;
		this.idleIntervalMs = config?.idleIntervalMs ?? 3_000;
		this.discoveryRefreshFastMs = sanitizeIntervalMs(config?.discoveryRefreshFastMs, 2_500, 500);
		this.discoveryRefreshSlowMs = sanitizeIntervalMs(
			config?.discoveryRefreshSlowMs,
			15_000,
			Math.max(1_000, this.discoveryRefreshFastMs)
		);
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
			} else if (message.type === 'scanBricks') {
				void this.scanAvailableBricks();
			} else if (message.type === 'connectScannedBrick') {
				void this.connectScannedBrick(message.candidateId);
			} else if (message.type === 'disconnectBrick') {
				void this.disconnectBrick(message.brickId);
			} else if (message.type === 'setMockConnection') {
				void this.setMockConnection(message.candidateId, message.connected);
			} else if (message.type === 'applyConfigChanges') {
				void this.applyConfigChanges(message.brickId, message.brickName);
			} else if (message.type === 'discardConfigChanges') {
				void this.discardConfigChanges(message.brickId);
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
		const activeBrick = bricks.find((b) => b.isActive);
		let sensors: WebviewSensorInfo[] | undefined;
		if (activeBrick && this.dataSource.getSensorInfo) {
			const sensorData = this.dataSource.getSensorInfo(activeBrick.brickId);
			if (sensorData) {
				sensors = sensorData.map((s) => ({
					port: s.port,
					layer: s.layer,
					typeName: s.typeName,
					mode: s.mode,
					connected: s.connected
				}));
			}
		}
		let motors: WebviewMotorInfo[] | undefined;
		if (activeBrick && this.dataSource.getMotorInfo) {
			const motorData = this.dataSource.getMotorInfo(activeBrick.brickId);
			if (motorData) {
				motors = motorData.map((m) => ({
					port: m.port,
					layer: m.layer,
					speed: m.speed,
					running: m.running
				}));
			}
		}
		let controls: WebviewControlsInfo | undefined;
		if (activeBrick) {
			const buttonState = this.dataSource.getButtonState?.(activeBrick.brickId);
			const ledPattern = this.dataSource.getLedPattern?.(activeBrick.brickId);
			if (buttonState !== undefined || ledPattern !== undefined) {
				controls = {
					buttonName: buttonState?.buttonName,
					ledPattern: ledPattern
				};
			}
		}
		const message: MessageToWebview = { type: 'updateBricks', bricks, sensors, motors, controls };
		void this.view.webview.postMessage(message);
	}

	private async scanAvailableBricks(): Promise<void> {
		if (!this.view) {
			return;
		}
		void this.view.webview.postMessage({ type: 'scanStarted' } satisfies MessageToWebview);
		if (!this.dataSource.scanAvailableBricks) {
			void this.view.webview.postMessage({
				type: 'scanFailed',
				message: 'Brick scan is not available in the current runtime.'
			} satisfies MessageToWebview);
			return;
		}

		try {
			const candidates = await this.dataSource.scanAvailableBricks();
			void this.view.webview.postMessage({
				type: 'scanResults',
				candidates
			} satisfies MessageToWebview);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.view.webview.postMessage({
				type: 'scanFailed',
				message
			} satisfies MessageToWebview);
		}
	}

	private async connectScannedBrick(candidateId: string): Promise<void> {
		if (!this.view) {
			return;
		}
		void this.view.webview.postMessage({
			type: 'connectStarted',
			candidateId
		} satisfies MessageToWebview);
		if (!this.dataSource.connectScannedBrick) {
			void this.view.webview.postMessage({
				type: 'connectFailed',
				candidateId,
				message: 'Connect action is not available in the current runtime.'
			} satisfies MessageToWebview);
			return;
		}

		try {
			await this.dataSource.connectScannedBrick(candidateId);
			void this.view.webview.postMessage({
				type: 'connectSucceeded',
				candidateId
			} satisfies MessageToWebview);
			this.refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.view.webview.postMessage({
				type: 'connectFailed',
				candidateId,
				message
			} satisfies MessageToWebview);
		}
	}

	private async disconnectBrick(brickId: string): Promise<void> {
		const normalizedBrickId = brickId.trim();
		if (!normalizedBrickId) {
			return;
		}
		try {
			if (this.dataSource.disconnectBrick) {
				await this.dataSource.disconnectBrick(normalizedBrickId);
			} else {
				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', normalizedBrickId);
			}
			this.refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Disconnect failed: ${message}`);
		}
	}

	private async setMockConnection(candidateId: string, connected: boolean): Promise<void> {
		const normalizedCandidateId = candidateId.trim();
		if (!normalizedCandidateId) {
			return;
		}
		try {
			if (this.dataSource.setMockConnection) {
				await this.dataSource.setMockConnection(normalizedCandidateId, connected);
			} else if (connected) {
				await this.connectScannedBrick(normalizedCandidateId);
				return;
			} else {
				await this.disconnectBrick(normalizedCandidateId);
				return;
			}
			this.refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Mock connection toggle failed: ${message}`);
		}
	}

	private async applyConfigChanges(brickId: string, brickName?: string): Promise<void> {
		if (!this.view) {
			return;
		}
		const normalizedBrickId = brickId.trim();
		const normalizedBrickName = (typeof brickName === 'string' ? brickName : '').trim();
		if (normalizedBrickId) {
			const changed = this.dataSource.setActiveBrick(normalizedBrickId);
			if (changed && this.onDidChangeActive) {
				this.onDidChangeActive();
			}
		}
		try {
			const applyResult = await this.dataSource.applyPendingConfigChanges?.({
				brickId: normalizedBrickId,
				brickName: normalizedBrickName
			});
			void this.view.webview.postMessage({
				type: 'configApplied',
				brickId: normalizedBrickId,
				brickName: applyResult?.brickName ?? normalizedBrickName,
				relatedBrickIds: applyResult?.relatedBrickIds
			} satisfies MessageToWebview);
			this.refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.view.webview.postMessage({
				type: 'configActionFailed',
				action: 'apply',
				brickId: normalizedBrickId,
				message
			} satisfies MessageToWebview);
		}
	}

	private async discardConfigChanges(brickId: string): Promise<void> {
		if (!this.view) {
			return;
		}
		const normalizedBrickId = brickId.trim();
		if (normalizedBrickId) {
			const changed = this.dataSource.setActiveBrick(normalizedBrickId);
			if (changed && this.onDidChangeActive) {
				this.onDidChangeActive();
			}
		}
		try {
			await this.dataSource.discardPendingConfigChanges?.(normalizedBrickId);
			void this.view.webview.postMessage({
				type: 'configDiscarded',
				brickId: normalizedBrickId
			} satisfies MessageToWebview);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.view.webview.postMessage({
				type: 'configActionFailed',
				action: 'discard',
				brickId: normalizedBrickId,
				message
			} satisfies MessageToWebview);
		}
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
		const uriApi = vscode.Uri as unknown as { joinPath?: (...paths: unknown[]) => vscode.Uri } | undefined;
		const hasJoinPath = !!uriApi && typeof uriApi.joinPath === 'function';
		const hasAsWebviewUri = typeof webview.asWebviewUri === 'function';
		const codiconsUri = hasJoinPath && hasAsWebviewUri
			? webview.asWebviewUri(
				uriApi.joinPath?.(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
					?? this.extensionUri
			)
			: undefined;
		const codiconsLinkTag = codiconsUri
			? `<link rel="stylesheet" href="${codiconsUri}">`
			: '';
		const transportIconsLiteral = JSON.stringify(getWebviewTransportIcons());
		const tabActionIconsLiteral = JSON.stringify(getWebviewTabActionIcons());
		const template = readBrickPanelTemplate(this.extensionUri);

		return template
			.replaceAll('__NONCE__', nonce)
			.replaceAll('__CSP_SOURCE__', cspSource)
			.replace('__CODICONS_LINK_TAG__', codiconsLinkTag)
			.replace('__TRANSPORT_ICONS_LITERAL__', transportIconsLiteral)
			.replace('__TAB_ACTION_ICONS_LITERAL__', tabActionIconsLiteral)
			.replace('__DISCOVERY_REFRESH_FAST_MS__', String(this.discoveryRefreshFastMs))
			.replace('__DISCOVERY_REFRESH_SLOW_MS__', String(this.discoveryRefreshSlowMs));
	}
}

let cachedBrickPanelTemplate: string | undefined;

function readBrickPanelTemplate(extensionUri: vscode.Uri): string {
	if (cachedBrickPanelTemplate) {
		return cachedBrickPanelTemplate;
	}
	const extensionFsPath = typeof extensionUri.fsPath === 'string' && extensionUri.fsPath.length > 0
		? extensionUri.fsPath
		: process.cwd();
	const templatePath = path.join(extensionFsPath, 'media', 'brick-panel.html');
	cachedBrickPanelTemplate = fs.readFileSync(templatePath, 'utf8');
	return cachedBrickPanelTemplate;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
