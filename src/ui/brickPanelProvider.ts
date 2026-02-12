import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';
import type { ButtonState } from '../device/buttonService';
import type { LedPattern } from '../device/ledService';
import type { MotorState } from '../device/motorTypes';
import type { SensorInfo } from '../device/sensorTypes';
import { getWebviewTransportIcons } from './graphicsLibrary';

export interface BrickPanelDataSource {
	listBricks(): BrickSnapshot[];
	setActiveBrick(brickId: string): boolean;
	scanAvailableBricks?(): Promise<BrickPanelDiscoveryCandidate[]>;
	connectScannedBrick?(candidateId: string): Promise<void>;
	disconnectBrick?(brickId: string): Promise<void>;
	applyPendingConfigChanges?(): Promise<void>;
	discardPendingConfigChanges?(): Promise<void>;
	getSensorInfo?(brickId: string): SensorInfo[] | undefined;
	getMotorInfo?(brickId: string): MotorState[] | undefined;
	getButtonState?(brickId: string): ButtonState | undefined;
	getLedPattern?(brickId: string): LedPattern | undefined;
}

export interface BrickPanelDiscoveryCandidate {
	candidateId: string;
	displayName: string;
	transport: 'usb' | 'bluetooth' | 'tcp' | 'unknown';
	status?: 'READY' | 'CONNECTING' | 'UNAVAILABLE' | 'ERROR' | 'UNKNOWN';
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
	| { type: 'applyConfigChanges' }
	| { type: 'discardConfigChanges' }
	| { type: 'ready' };

interface WebviewSensorInfo {
	port: number;
	typeName: string;
	mode: number;
	connected: boolean;
}

interface WebviewMotorInfo {
	port: string;
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
	| { type: 'configApplied' }
	| { type: 'configDiscarded' }
	| { type: 'configActionFailed'; action: 'apply' | 'discard'; message: string };

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
			} else if (message.type === 'applyConfigChanges') {
				void this.applyConfigChanges();
			} else if (message.type === 'discardConfigChanges') {
				void this.discardConfigChanges();
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

	private async applyConfigChanges(): Promise<void> {
		if (!this.view) {
			return;
		}
		try {
			await this.dataSource.applyPendingConfigChanges?.();
			void this.view.webview.postMessage({ type: 'configApplied' } satisfies MessageToWebview);
			this.refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.view.webview.postMessage({
				type: 'configActionFailed',
				action: 'apply',
				message
			} satisfies MessageToWebview);
		}
	}

	private async discardConfigChanges(): Promise<void> {
		if (!this.view) {
			return;
		}
		try {
			await this.dataSource.discardPendingConfigChanges?.();
			void this.view.webview.postMessage({ type: 'configDiscarded' } satisfies MessageToWebview);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.view.webview.postMessage({
				type: 'configActionFailed',
				action: 'discard',
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
		const transportIconsLiteral = JSON.stringify(getWebviewTransportIcons());
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
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		padding: 0;
		margin: 0;
		overflow: hidden;
	}
	#root {
		height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.panel-toolbar {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		padding: 10px 10px 0;
		position: sticky;
		top: 0;
		z-index: 50;
		background: var(--vscode-editor-background);
	}
	.config-toolbar {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0;
	}
	.config-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 24px;
		border: 1px solid var(--vscode-button-border, transparent);
		background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
		color: var(--vscode-foreground);
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}
	.config-btn:hover:not(:disabled) {
		background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.14));
	}
	.config-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.config-enter {
		border-radius: 4px;
		font-size: 14px;
	}
	.config-apply {
		color: #11d56b;
		border-top-left-radius: 4px;
		border-bottom-left-radius: 4px;
		font-size: 14px;
	}
	.config-menu-toggle {
		width: 18px;
		border-left: none;
		border-top-right-radius: 4px;
		border-bottom-right-radius: 4px;
		font-size: 10px;
	}
	.config-actions-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		display: flex;
		flex-direction: column;
		min-width: 34px;
		padding: 4px;
		border: 1px solid var(--vscode-panel-border, #444);
		border-radius: 6px;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
		z-index: 30;
	}
	.config-discard {
		color: #ff4b4b;
		border-radius: 4px;
		font-size: 14px;
	}
	.config-error {
		padding: 6px 12px 0;
		color: var(--vscode-errorForeground, #f44);
	}
	.brick-detail-area {
		background: var(--vscode-editor-background);
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		position: relative;
	}
	.brick-tabs-wrap {
		position: relative;
	}
	.brick-tabs {
		display: flex;
		align-items: flex-end;
		flex-wrap: nowrap;
		gap: 0;
		padding: 8px 8px 0;
		overflow: visible;
	}
	.brick-tab-baseline {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 1px;
		background: var(--vscode-panel-border, #444);
		pointer-events: none;
	}
	.brick-tab-baseline-gap {
		position: absolute;
		bottom: 0;
		height: 2px;
		background: var(--vscode-editor-background);
		pointer-events: none;
		z-index: 3;
		display: none;
	}
	.brick-tabs-main {
		display: block;
		flex: 1 1 auto;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.brick-tabs-track {
		display: flex;
		align-items: flex-end;
		min-width: max-content;
		padding-bottom: 0;
	}
	.brick-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		margin: 0 2px -1px 0;
		border: 1px solid var(--vscode-panel-border, #444);
		border-top-left-radius: 0;
		border-top-right-radius: 0;
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
		border-bottom-color: transparent;
		cursor: pointer;
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		font-size: var(--vscode-font-size);
		white-space: nowrap;
		flex: 0 1 auto;
		min-width: 44px;
		max-width: 170px;
	}
	.brick-tab-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1 1 auto;
		min-width: 0;
	}
	.brick-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-left: 4px;
		border-radius: 2px;
		font-size: 15px;
		line-height: 15px;
		opacity: 0.85;
		cursor: pointer;
		flex: 0 0 auto;
	}
	.brick-tab-close:hover {
		opacity: 1;
		background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.14));
	}
	.brick-tab:hover {
		background: var(--vscode-list-hoverBackground);
		border-bottom-color: transparent;
	}
	.brick-tab.active {
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		border-bottom-color: var(--vscode-editor-background);
		position: relative;
		z-index: 2;
	}
	.brick-tab.add-tab {
		font-weight: bold;
		min-width: 38px;
		justify-content: center;
		font-size: 18px;
		line-height: 18px;
	}
	.brick-detail-area::-webkit-scrollbar,
	.brick-tabs-main::-webkit-scrollbar {
		width: 10px;
		height: 10px;
	}
	.brick-detail-area::-webkit-scrollbar-track,
	.brick-tabs-main::-webkit-scrollbar-track {
		background: transparent;
	}
	.brick-detail-area::-webkit-scrollbar-thumb,
	.brick-tabs-main::-webkit-scrollbar-thumb {
		background: transparent;
		border-radius: 5px;
	}
	.brick-detail-area:hover::-webkit-scrollbar-thumb,
	.brick-tabs-main:hover::-webkit-scrollbar-thumb {
		background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
	}
	.brick-detail-area:hover::-webkit-scrollbar-thumb:hover,
	.brick-tabs-main:hover::-webkit-scrollbar-thumb:hover {
		background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
	}
	.brick-detail-area:hover::-webkit-scrollbar-thumb:active,
	.brick-tabs-main:hover::-webkit-scrollbar-thumb:active {
		background: var(--vscode-scrollbarSlider-activeBackground, rgba(191, 191, 191, 0.4));
	}
	.brick-detail-area::-webkit-scrollbar-button,
	.brick-tabs-main::-webkit-scrollbar-button {
		display: none;
		width: 0;
		height: 0;
	}
	.discovery-section {
		padding: 8px 12px 12px;
	}
	.discovery-title {
		margin: 0 0 14px;
		font-size: 26px;
		line-height: 1.2;
		font-weight: 300;
	}
	.discovery-message {
		opacity: 0.9;
		padding: 4px 0;
	}
	.discovery-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.discovery-item {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 6px 4px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--vscode-foreground);
		cursor: pointer;
		text-align: left;
	}
	.discovery-item:hover:not(:disabled) {
		background: var(--vscode-list-hoverBackground);
	}
	.discovery-item.selected {
		background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
		color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
	}
	.discovery-item.status-ready {
		border-left: none;
	}
	.discovery-item.status-connecting {
		border-left: none;
	}
	.discovery-item.status-error {
		border-left: none;
	}
	.discovery-item.status-unavailable {
		border-left: none;
	}
	.discovery-item.status-unknown {
		border-left: none;
	}
	.discovery-item:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.discovery-main {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		font-weight: 400;
		line-height: 20px;
		width: 100%;
	}
	.discovery-main-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.transport-indicator {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}
	.discovery-main .transport-indicator {
		width: 20px;
		height: 20px;
	}
	.transport-indicator.status-ready {
		color: #00e676;
	}
	.transport-indicator.status-connecting {
		color: #ffb300;
	}
	.transport-indicator.status-unavailable {
		color: #8f9aa6;
	}
	.transport-indicator.status-error {
		color: #ff3b30;
	}
	.transport-indicator.status-unknown {
		color: #4fc3f7;
	}
	.transport-icon-svg {
		display: block;
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.discovery-main .transport-icon-svg {
		width: 20px;
		height: 20px;
	}
	.brick-info {
		padding: 12px;
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
	.sensor-section {
		padding: 8px 12px;
		border-top: 1px solid var(--vscode-panel-border, #444);
	}
	.sensor-section h3 {
		margin: 4px 0 8px;
		font-size: var(--vscode-font-size);
		font-weight: bold;
	}
	.sensor-port {
		display: flex;
		justify-content: space-between;
		padding: 3px 0;
		opacity: 0.85;
	}
	.sensor-port.disconnected {
		opacity: 0.45;
	}
	.sensor-port-label {
		font-weight: bold;
		min-width: 50px;
	}
	.motor-section {
		padding: 8px 12px;
		border-top: 1px solid var(--vscode-panel-border, #444);
	}
	.motor-section h3 {
		margin: 4px 0 8px;
		font-size: var(--vscode-font-size);
		font-weight: bold;
	}
	.motor-port {
		display: flex;
		justify-content: space-between;
		padding: 3px 0;
		opacity: 0.85;
	}
	.motor-port.stopped {
		opacity: 0.45;
	}
	.motor-port-label {
		font-weight: bold;
		min-width: 50px;
	}
	.controls-section {
		padding: 8px 12px;
		border-top: 1px solid var(--vscode-panel-border, #444);
	}
	.controls-section h3 {
		margin: 4px 0 8px;
		font-size: var(--vscode-font-size);
		font-weight: bold;
	}
	.controls-row {
		display: flex;
		justify-content: space-between;
		padding: 3px 0;
		opacity: 0.85;
	}
	.controls-label {
		font-weight: bold;
		min-width: 80px;
	}
</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		let bricks = [];
		let sensors = [];
		let motors = [];
		let controls = null;
		let discoveryOpen = false;
		let discoveryLoading = false;
		let discoveryError = '';
		let discoveryCandidates = [];
		let selectedDiscoveryCandidateId = '';
		let connectingDiscoveryCandidateId = '';
		let configMode = false;
		let configMenuOpen = false;
		let configActionInFlight = '';
		let configError = '';
		let detailScrollTop = 0;
		let tabsScrollLeft = 0;
		let suppressRenderUntil = 0;
		let initialAutoScanPending = true;
		let scanInFlight = false;
		let scanLoopTimer = null;
		let scanLoopMode = '';
		let lastScanBackground = false;
		let nextBrickOrder = 0;
		const brickOrderById = new Map();
		const DISCOVERY_REFRESH_FAST_MS = ${this.discoveryRefreshFastMs};
		const DISCOVERY_REFRESH_SLOW_MS = ${this.discoveryRefreshSlowMs};
		const TRANSPORT_ICONS = ${transportIconsLiteral};

		function isPlusTabActive() {
			return discoveryOpen || bricks.length === 0;
		}

		function stopScanLoop() {
			if (scanLoopTimer) {
				clearTimeout(scanLoopTimer);
				scanLoopTimer = null;
			}
			scanLoopMode = '';
		}

		function scheduleNextScan(force = false) {
			const desiredMode = isPlusTabActive() ? 'fast' : 'slow';
			const delay = desiredMode === 'fast' ? DISCOVERY_REFRESH_FAST_MS : DISCOVERY_REFRESH_SLOW_MS;
			if (scanInFlight) {
				scanLoopMode = desiredMode;
				return;
			}
			if (!force && scanLoopTimer && scanLoopMode === desiredMode) {
				return;
			}
			stopScanLoop();
			scanLoopMode = desiredMode;
			scanLoopTimer = setTimeout(() => {
				scanLoopTimer = null;
				requestDiscoveryScan({
					preserveCandidates: true,
					openUi: isPlusTabActive(),
					background: !isPlusTabActive()
				});
			}, delay);
		}

		function mergeDiscoveryCandidates(nextCandidates) {
			const byId = new Map();
			for (const candidate of nextCandidates || []) {
				if (!candidate || !candidate.candidateId) {
					continue;
				}
				if (isHiddenDiscoveryCandidate(candidate)) {
					continue;
				}
				byId.set(candidate.candidateId, candidate);
			}
			discoveryCandidates = Array.from(byId.values());
			if (selectedDiscoveryCandidateId && !byId.has(selectedDiscoveryCandidateId)) {
				selectedDiscoveryCandidateId = '';
			}
		}

		function isHiddenDiscoveryCandidate(candidate) {
			if (!candidate) {
				return true;
			}
			const candidateId = typeof candidate.candidateId === 'string'
				? candidate.candidateId.trim().toLowerCase()
				: '';
			const displayName = typeof candidate.displayName === 'string'
				? candidate.displayName.trim().toLowerCase()
				: '';
			const detail = typeof candidate.detail === 'string'
				? candidate.detail.trim().toLowerCase()
				: '';
			return candidateId === 'active'
				|| displayName === 'auto'
				|| detail === 'auto'
				|| detail.startsWith('auto ');
		}

		function setCandidateConnectionState(candidateId, status, alreadyConnected) {
			for (const candidate of discoveryCandidates) {
				if (candidate.candidateId !== candidateId) {
					continue;
				}
				candidate.status = status;
				candidate.alreadyConnected = alreadyConnected;
				break;
			}
		}

		function ensureBrickVisibleFromCandidate(candidateId, status) {
			const candidate = discoveryCandidates.find((item) => item.candidateId === candidateId);
			const transport = candidate?.transport || 'unknown';
			const displayName = candidate?.displayName || candidateId;
			let found = false;
			bricks = bricks.map((brick) => {
				if (brick.brickId !== candidateId) {
					return {
						...brick,
						isActive: false
					};
				}
				found = true;
				return {
					...brick,
					displayName,
					transport,
					status,
					isActive: true
				};
			});
			if (!found) {
				bricks.push({
					brickId: candidateId,
					displayName,
					status,
					transport,
					role: 'standalone',
					isActive: true
				});
				bricks = bricks.map((brick) => ({
					...brick,
					isActive: brick.brickId === candidateId
				}));
			}
			bricks = stabilizeBrickOrder(bricks);
		}

		function removeBrickImmediately(brickId) {
			const wasActive = bricks.some((brick) => brick.brickId === brickId && brick.isActive);
			bricks = bricks.filter((brick) => brick.brickId !== brickId);
			if (wasActive && bricks.length > 0) {
				bricks = bricks.map((brick, index) => ({
					...brick,
					isActive: index === 0
				}));
			}
			bricks = stabilizeBrickOrder(bricks);
		}

		function syncDiscoveryCandidatesWithBricks() {
			if (!Array.isArray(discoveryCandidates) || discoveryCandidates.length === 0) {
				return false;
			}
			let changed = false;
			const statusByBrickId = new Map();
			for (const brick of bricks) {
				if (!brick || !brick.brickId) {
					continue;
				}
				statusByBrickId.set(brick.brickId, String(brick.status || '').toUpperCase());
			}
			for (const candidate of discoveryCandidates) {
				if (!candidate || !candidate.candidateId) {
					continue;
				}
				const liveStatus = statusByBrickId.get(candidate.candidateId);
				if (liveStatus === 'READY' || liveStatus === 'CONNECTING' || liveStatus === 'UNAVAILABLE' || liveStatus === 'ERROR') {
					const nextAlreadyConnected = liveStatus === 'READY' || liveStatus === 'CONNECTING';
					if (candidate.status !== liveStatus || candidate.alreadyConnected !== nextAlreadyConnected) {
						candidate.status = liveStatus;
						candidate.alreadyConnected = nextAlreadyConnected;
						changed = true;
					}
					continue;
				}
				if (
					candidate.alreadyConnected === true
					&& candidate.candidateId !== connectingDiscoveryCandidateId
				) {
					if (candidate.status !== 'UNAVAILABLE' || candidate.alreadyConnected !== false) {
						candidate.status = 'UNAVAILABLE';
						candidate.alreadyConnected = false;
						changed = true;
					}
				}
			}
			return changed;
		}

		function stabilizeBrickOrder(nextBricks) {
			const normalized = Array.isArray(nextBricks)
				? nextBricks.filter((brick) => brick && brick.brickId)
				: [];
			for (const brick of normalized) {
				if (!brickOrderById.has(brick.brickId)) {
					brickOrderById.set(brick.brickId, nextBrickOrder);
					nextBrickOrder += 1;
				}
			}
			const visibleIds = new Set(normalized.map((brick) => brick.brickId));
			for (const knownId of Array.from(brickOrderById.keys())) {
				if (!visibleIds.has(knownId)) {
					brickOrderById.delete(knownId);
				}
			}
			return normalized.slice().sort((left, right) => {
				const leftOrder = brickOrderById.get(left.brickId) ?? 0;
				const rightOrder = brickOrderById.get(right.brickId) ?? 0;
				return leftOrder - rightOrder;
			});
		}

		function requestDiscoveryScan(options = {}) {
			if (scanInFlight) {
				return;
			}
			const openUi = options.openUi !== false;
			const background = options.background === true;
			lastScanBackground = background;
			if (openUi) {
				discoveryOpen = true;
			}
			discoveryLoading = openUi && discoveryCandidates.length === 0;
			discoveryError = '';
			if (!options.preserveCandidates) {
				discoveryCandidates = [];
				selectedDiscoveryCandidateId = '';
				connectingDiscoveryCandidateId = '';
			}
			scanInFlight = true;
			render();
			vscode.postMessage({ type: 'scanBricks' });
		}

		function renderTransportIcon(transport) {
			const normalized = typeof transport === 'string' ? transport.toLowerCase() : 'unknown';
			return TRANSPORT_ICONS[normalized] || TRANSPORT_ICONS.unknown;
		}

		function renderTransportIndicator(brick) {
			const status = String(brick.status || '').toLowerCase();
			const statusClass = status === 'ready' || status === 'connecting' || status === 'unavailable' || status === 'error'
				? 'status-' + status
				: 'status-unknown';
			return '<span class="transport-indicator ' + statusClass + '">' + renderTransportIcon(brick.transport) + '</span>';
		}

		function renderDiscoveryTransportIndicator(candidate) {
			const normalizedStatus = String(candidate.status || '').toLowerCase();
			const connectedStatus = candidate.alreadyConnected ? 'ready' : 'unknown';
			const statusClass = (candidate.candidateId === connectingDiscoveryCandidateId)
				? 'status-connecting'
				: (
					normalizedStatus === 'ready'
					|| normalizedStatus === 'connecting'
					|| normalizedStatus === 'unavailable'
					|| normalizedStatus === 'error'
				)
					? 'status-' + normalizedStatus
					: 'status-' + connectedStatus;
			return '<span class="transport-indicator ' + statusClass + '">' + renderTransportIcon(candidate.transport) + '</span>';
		}

		function shouldShowTabClose(brick) {
			const status = String(brick.status || '').toLowerCase();
			return status === 'ready' || status === 'connecting';
		}

		function resolveCandidateStatusClass(candidate) {
			if (candidate.candidateId === connectingDiscoveryCandidateId) {
				return ' status-connecting';
			}
			const normalizedStatus = String(candidate.status || '').toLowerCase();
			if (
				normalizedStatus === 'ready'
				|| normalizedStatus === 'connecting'
				|| normalizedStatus === 'unavailable'
				|| normalizedStatus === 'error'
			) {
				return ' status-' + normalizedStatus;
			}
			return candidate.alreadyConnected ? ' status-ready' : ' status-unknown';
		}

		function isCandidateReadyConnected(candidate) {
			if (!candidate) {
				return false;
			}
			const status = String(candidate.status || '').toLowerCase();
			return status === 'ready' || (candidate.alreadyConnected === true && status !== 'error' && status !== 'unavailable');
		}

		function isSameSnapshot(left, right) {
			return JSON.stringify(left) === JSON.stringify(right);
		}

		function renderConfigToolbar() {
			if (!configMode) {
				return '<div class="panel-toolbar"><div class="config-toolbar">'
					+ '<button class="config-btn config-enter" data-config-enter="true" title="Enter configuration mode" aria-label="Enter configuration mode">⚙</button>'
					+ '</div></div>';
			}
			const disabledAttr = configActionInFlight ? ' disabled' : '';
			let html = '<div class="panel-toolbar"><div class="config-toolbar">';
			html += '<button class="config-btn config-apply" data-config-apply="true" title="Apply all configuration changes" aria-label="Apply all configuration changes"' + disabledAttr + '>✔</button>';
			html += '<button class="config-btn config-menu-toggle" data-config-menu-toggle="true" title="Configuration actions" aria-label="Configuration actions"' + disabledAttr + '>▾</button>';
			if (configMenuOpen) {
				html += '<div class="config-actions-menu">'
					+ '<button class="config-btn config-discard" data-config-discard="true" title="Discard all configuration changes" aria-label="Discard all configuration changes"' + disabledAttr + '>✕</button>'
					+ '</div>';
			}
			html += '</div></div>';
			return html;
		}

		function render() {
			const root = document.getElementById('root');
			const previousDetailArea = root.querySelector('.brick-detail-area');
			if (previousDetailArea) {
				detailScrollTop = previousDetailArea.scrollTop;
			}
			const previousTabsMain = root.querySelector('.brick-tabs-main');
			if (previousTabsMain) {
				tabsScrollLeft = previousTabsMain.scrollLeft;
			}
			const activeBrick = bricks.find(b => b.isActive);
			let html = '<div class="brick-tabs-wrap"><div class="brick-tabs"><div class="brick-tabs-main"><div class="brick-tabs-track">';
			for (const brick of bricks) {
				const activeClass = !discoveryOpen && brick.isActive ? ' active' : '';
				const closeMarkup = shouldShowTabClose(brick)
					? '<span class="brick-tab-close" data-close-brick-id="' + brick.brickId + '" title="Disconnect EV3 Brick" aria-label="Disconnect EV3 Brick" role="button">×</span>'
					: '';
				html += '<button class="brick-tab' + activeClass + '" data-brick-id="' + brick.brickId + '" title="' + brick.displayName + '">'
					+ renderTransportIndicator(brick)
					+ '<span class="brick-tab-label">' + brick.displayName + '</span>'
					+ closeMarkup
					+ '</button>';
			}
			html += '</div></div>';
			const addTabActiveClass = (discoveryOpen || bricks.length === 0) ? ' active' : '';
			html += '<button class="brick-tab add-tab' + addTabActiveClass + '" data-add-brick="true" title="Connect EV3 Brick" aria-label="Connect EV3 Brick">+</button>';
			html += '</div>';
			html += '<div class="brick-tab-baseline"></div>';
			html += '<div class="brick-tab-baseline-gap"></div>';
			html += '</div>';

			html += '<div class="brick-detail-area">';
			html += renderConfigToolbar();
			if (configError) {
				html += '<div class="config-error">' + configError + '</div>';
			}

			if (discoveryOpen) {
				html += '<div class="discovery-section">'
					+ '<div class="discovery-title">Available bricks</div>';
				if (discoveryLoading) {
					html += '<div class="discovery-message">Scanning...</div>';
				} else if (discoveryError) {
					html += '<div class="discovery-message error-text">' + discoveryError + '</div>';
				} else if (!discoveryCandidates || discoveryCandidates.length === 0) {
					html += '<div class="discovery-message">No available Bricks found.</div>';
				} else {
					html += '<div class="discovery-list">';
					for (const candidate of discoveryCandidates) {
						const selectedClass = candidate.candidateId === selectedDiscoveryCandidateId ? ' selected' : '';
						const statusClass = resolveCandidateStatusClass(candidate);
						const disabledAttr = connectingDiscoveryCandidateId ? ' disabled' : '';
						html += '<button class="discovery-item' + selectedClass + statusClass + '" data-candidate-id="' + candidate.candidateId + '"' + disabledAttr + '>'
							+ '<span class="discovery-main">'
							+ renderDiscoveryTransportIndicator(candidate)
							+ '<span class="discovery-main-label">' + candidate.displayName + '</span>'
							+ '</span>'
							+ '</button>';
					}
					html += '</div>';
				}
				html += '</div>';
			}

			if (!discoveryOpen && activeBrick) {
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

			if (sensors && sensors.length > 0) {
				html += '<div class="sensor-section"><h3>Sensors</h3>';
				for (const s of sensors) {
					const cls = s.connected ? 'sensor-port' : 'sensor-port disconnected';
					html += '<div class="' + cls + '">'
						+ '<span class="sensor-port-label">Port ' + (s.port + 1) + '</span>'
						+ '<span>' + s.typeName + (s.connected ? ' (mode ' + s.mode + ')' : '') + '</span>'
						+ '</div>';
				}
				html += '</div>';
			}

			if (motors && motors.length > 0) {
				html += '<div class="motor-section"><h3>Motors</h3>';
				for (const m of motors) {
					const cls = m.running ? 'motor-port' : 'motor-port stopped';
					html += '<div class="' + cls + '">'
						+ '<span class="motor-port-label">Port ' + m.port + '</span>'
						+ '<span>' + (m.running ? 'Speed ' + m.speed + '%' : 'Stopped') + '</span>'
						+ '</div>';
				}
				html += '</div>';
			}

			if (controls) {
				html += '<div class="controls-section"><h3>Controls</h3>';
				if (controls.buttonName) {
					html += '<div class="controls-row">'
						+ '<span class="controls-label">Button</span>'
						+ '<span>' + controls.buttonName + '</span>'
						+ '</div>';
				}
				if (typeof controls.ledPattern === 'number') {
					const ledNames = ['Off','Green','Red','Orange','Green Flash','Red Flash','Orange Flash','Green Pulse','Red Pulse','Orange Pulse'];
					html += '<div class="controls-row">'
						+ '<span class="controls-label">LED</span>'
						+ '<span>' + (ledNames[controls.ledPattern] || 'Pattern ' + controls.ledPattern) + '</span>'
						+ '</div>';
				}
				html += '</div>';
			}
			html += '</div>';

			root.innerHTML = html;
			const detailArea = root.querySelector('.brick-detail-area');
			if (detailArea) {
				detailArea.scrollTop = detailScrollTop;
				detailArea.addEventListener('scroll', () => {
					detailScrollTop = detailArea.scrollTop;
					suppressRenderUntil = Date.now() + 250;
				}, { passive: true });
			}
			const tabsMain = root.querySelector('.brick-tabs-main');
			if (tabsMain) {
				tabsMain.scrollLeft = tabsScrollLeft;
				tabsMain.addEventListener('scroll', () => {
					tabsScrollLeft = tabsMain.scrollLeft;
					suppressRenderUntil = Date.now() + 250;
					updateTabBaselineGap();
				}, { passive: true });
			}
			const baselineGap = root.querySelector('.brick-tab-baseline-gap');
			const activeTab = root.querySelector('.brick-tab.active');
			const tabsWrap = root.querySelector('.brick-tabs-wrap');
			function updateTabBaselineGap() {
				if (!baselineGap || !activeTab || !tabsWrap) {
					if (baselineGap) {
						baselineGap.style.display = 'none';
					}
					return;
				}
				const activeRect = activeTab.getBoundingClientRect();
				const wrapRect = tabsWrap.getBoundingClientRect();
				const left = activeRect.left - wrapRect.left - 1;
				const width = activeRect.width + 2;
				baselineGap.style.left = left + 'px';
				baselineGap.style.width = width + 'px';
				baselineGap.style.display = 'block';
			}
			updateTabBaselineGap();

			for (const configEnterButton of root.querySelectorAll('[data-config-enter]')) {
				configEnterButton.addEventListener('click', () => {
					configMode = true;
					configMenuOpen = false;
					configError = '';
					render();
				});
			}
			for (const configApplyButton of root.querySelectorAll('[data-config-apply]')) {
				configApplyButton.addEventListener('click', () => {
					if (configActionInFlight) {
						return;
					}
					configMenuOpen = false;
					configActionInFlight = 'apply';
					configError = '';
					render();
					vscode.postMessage({ type: 'applyConfigChanges' });
				});
			}
			for (const configMenuToggleButton of root.querySelectorAll('[data-config-menu-toggle]')) {
				configMenuToggleButton.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (configActionInFlight) {
						return;
					}
					configMenuOpen = !configMenuOpen;
					render();
				});
			}
			for (const configDiscardButton of root.querySelectorAll('[data-config-discard]')) {
				configDiscardButton.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (configActionInFlight) {
						return;
					}
					configMenuOpen = false;
					configActionInFlight = 'discard';
					configError = '';
					render();
					vscode.postMessage({ type: 'discardConfigChanges' });
				});
			}
			for (const closeConfigMenuArea of root.querySelectorAll('.brick-detail-area, .brick-tabs-main')) {
				closeConfigMenuArea.addEventListener('click', () => {
					if (!configMenuOpen) {
						return;
					}
					configMenuOpen = false;
					render();
				});
			}

			for (const tab of root.querySelectorAll('.brick-tab')) {
				tab.addEventListener('click', () => {
					configMenuOpen = false;
					if (tab.dataset.addBrick === 'true') {
						selectedDiscoveryCandidateId = '';
						requestDiscoveryScan({ preserveCandidates: true });
						return;
					}
					discoveryOpen = false;
					stopScanLoop();
					vscode.postMessage({ type: 'selectBrick', brickId: tab.dataset.brickId });
				});
			}
			for (const closeButton of root.querySelectorAll('.brick-tab-close')) {
				closeButton.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					configMenuOpen = false;
					const brickId = closeButton.dataset.closeBrickId || '';
					if (!brickId) {
						return;
					}
					removeBrickImmediately(brickId);
					setCandidateConnectionState(brickId, 'UNKNOWN', false);
					render();
					vscode.postMessage({ type: 'disconnectBrick', brickId });
				});
			}
			for (const candidateButton of root.querySelectorAll('.discovery-item')) {
				candidateButton.addEventListener('click', () => {
					configMenuOpen = false;
					selectedDiscoveryCandidateId = candidateButton.dataset.candidateId || '';
					render();
				});
				candidateButton.addEventListener('dblclick', () => {
					const candidateId = candidateButton.dataset.candidateId || '';
					if (!candidateId) {
						return;
					}
					if (candidateButton.disabled) {
						return;
					}
					const candidate = discoveryCandidates.find((item) => item.candidateId === candidateId);
					if (isCandidateReadyConnected(candidate)) {
						ensureBrickVisibleFromCandidate(candidateId, 'READY');
						discoveryOpen = false;
						stopScanLoop();
						render();
						vscode.postMessage({ type: 'selectBrick', brickId: candidateId });
						return;
					}
					connectingDiscoveryCandidateId = candidateId;
					setCandidateConnectionState(candidateId, 'CONNECTING', true);
					ensureBrickVisibleFromCandidate(candidateId, 'CONNECTING');
					render();
					vscode.postMessage({ type: 'connectScannedBrick', candidateId });
				});
			}
		}

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'updateBricks') {
				const nextBricks = stabilizeBrickOrder(message.bricks || []);
				const nextSensors = message.sensors || [];
				const nextMotors = message.motors || [];
				const nextControls = message.controls || null;
				const bricksChanged = !isSameSnapshot(nextBricks, bricks);
				const sensorsChanged = !isSameSnapshot(nextSensors, sensors);
				const motorsChanged = !isSameSnapshot(nextMotors, motors);
				const controlsChanged = !isSameSnapshot(nextControls, controls);
				if (bricksChanged) {
					bricks = nextBricks;
				}
				if (sensorsChanged) {
					sensors = nextSensors;
				}
				if (motorsChanged) {
					motors = nextMotors;
				}
				if (controlsChanged) {
					controls = nextControls;
				}
				const discoveryChanged = syncDiscoveryCandidatesWithBricks();
				if (initialAutoScanPending && bricks.length === 0) {
					initialAutoScanPending = false;
					requestDiscoveryScan({ preserveCandidates: false });
					return;
				}
				initialAutoScanPending = false;
				if (
					(bricksChanged || sensorsChanged || motorsChanged || controlsChanged || discoveryChanged)
					&& Date.now() >= suppressRenderUntil
				) {
					render();
				}
				scheduleNextScan();
				return;
			}
			if (message.type === 'scanStarted') {
				if (!lastScanBackground) {
					discoveryLoading = discoveryCandidates.length === 0;
					discoveryError = '';
				}
				scanInFlight = true;
				if (discoveryOpen) {
					render();
				}
				return;
			}
			if (message.type === 'scanResults') {
				if (!lastScanBackground) {
					discoveryLoading = false;
					discoveryError = '';
				}
				scanInFlight = false;
				mergeDiscoveryCandidates(message.candidates || []);
				connectingDiscoveryCandidateId = '';
				if (discoveryOpen) {
					render();
				}
				scheduleNextScan();
				return;
			}
			if (message.type === 'scanFailed') {
				if (!lastScanBackground) {
					discoveryLoading = false;
					discoveryError = message.message || 'Brick scan failed.';
				}
				scanInFlight = false;
				connectingDiscoveryCandidateId = '';
				if (discoveryOpen) {
					render();
				}
				scheduleNextScan();
				return;
			}
			if (message.type === 'connectStarted') {
				discoveryOpen = true;
				connectingDiscoveryCandidateId = message.candidateId || '';
				if (connectingDiscoveryCandidateId) {
					setCandidateConnectionState(connectingDiscoveryCandidateId, 'CONNECTING', true);
					ensureBrickVisibleFromCandidate(connectingDiscoveryCandidateId, 'CONNECTING');
				}
				discoveryError = '';
				render();
				return;
			}
			if (message.type === 'connectSucceeded') {
				const connectedCandidateId = message.candidateId || connectingDiscoveryCandidateId;
				if (connectedCandidateId) {
					setCandidateConnectionState(connectedCandidateId, 'READY', true);
					ensureBrickVisibleFromCandidate(connectedCandidateId, 'READY');
				}
				discoveryOpen = false;
				discoveryLoading = false;
				discoveryError = '';
				selectedDiscoveryCandidateId = '';
				connectingDiscoveryCandidateId = '';
				scanInFlight = false;
				stopScanLoop();
				render();
				scheduleNextScan(true);
				return;
			}
			if (message.type === 'connectFailed') {
				const failedCandidateId = message.candidateId || connectingDiscoveryCandidateId;
				if (failedCandidateId) {
					setCandidateConnectionState(failedCandidateId, 'UNKNOWN', false);
					removeBrickImmediately(failedCandidateId);
				}
				connectingDiscoveryCandidateId = '';
				discoveryError = message.message || 'Connect failed.';
				scanInFlight = false;
				render();
				scheduleNextScan();
				return;
			}
			if (message.type === 'configApplied') {
				configActionInFlight = '';
				configMenuOpen = false;
				configMode = false;
				configError = '';
				render();
				return;
			}
			if (message.type === 'configDiscarded') {
				configActionInFlight = '';
				configMenuOpen = false;
				configMode = false;
				configError = '';
				render();
				return;
			}
			if (message.type === 'configActionFailed') {
				configActionInFlight = '';
				configMenuOpen = false;
				configError = message.message || 'Configuration action failed.';
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
