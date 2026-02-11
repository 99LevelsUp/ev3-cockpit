import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';
import type { ButtonState } from '../device/buttonService';
import type { LedPattern } from '../device/ledService';
import type { MotorState } from '../device/motorTypes';
import type { SensorInfo } from '../device/sensorTypes';

export interface BrickPanelDataSource {
	listBricks(): BrickSnapshot[];
	setActiveBrick(brickId: string): boolean;
	scanAvailableBricks?(): Promise<BrickPanelDiscoveryCandidate[]>;
	connectScannedBrick?(candidateId: string): Promise<void>;
	getSensorInfo?(brickId: string): SensorInfo[] | undefined;
	getMotorInfo?(brickId: string): MotorState[] | undefined;
	getButtonState?(brickId: string): ButtonState | undefined;
	getLedPattern?(brickId: string): LedPattern | undefined;
}

export interface BrickPanelDiscoveryCandidate {
	candidateId: string;
	displayName: string;
	transport: 'usb' | 'bluetooth' | 'tcp' | 'unknown';
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
	| { type: 'connectSucceeded'; candidateId: string };

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
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		padding: 0;
		margin: 0;
	}
	#root {
		min-height: 100vh;
	}
	.brick-detail-area {
		background: var(--vscode-editor-background);
		min-height: calc(100vh - 38px);
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
		display: flex;
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
	}
	.brick-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		margin: 0 2px -1px 0;
		border: 1px solid transparent;
		border-top-left-radius: 6px;
		border-top-right-radius: 6px;
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
		border-bottom-color: transparent;
		cursor: pointer;
		background: transparent;
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
	}
	.brick-tab:hover {
		background: var(--vscode-list-hoverBackground);
		border-color: var(--vscode-panel-border, #444);
		border-bottom-color: transparent;
	}
	.brick-tab.active {
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		border-color: var(--vscode-panel-border, #444);
		border-bottom-color: var(--vscode-editor-background);
		position: relative;
		z-index: 2;
	}
	.brick-tab.add-tab {
		font-weight: bold;
		min-width: 36px;
		justify-content: center;
	}
	.brick-tab.overflow-toggle {
		min-width: 36px;
		max-width: 36px;
		justify-content: center;
		padding-left: 0;
		padding-right: 0;
	}
	.brick-overflow-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 46px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		min-width: 220px;
		max-width: 300px;
		padding: 4px;
		border: 1px solid var(--vscode-panel-border, #444);
		border-radius: 6px;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
	}
	.brick-overflow-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--vscode-foreground);
		cursor: pointer;
		text-align: left;
	}
	.brick-overflow-item:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.brick-overflow-item.active {
		background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground);
	}
	.brick-overflow-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.discovery-section {
		padding: 8px 12px;
	}
	.discovery-title {
		margin: 2px 0 6px;
		font-weight: bold;
	}
	.discovery-help {
		margin: 0 0 8px;
		opacity: 0.75;
	}
	.discovery-message {
		opacity: 0.8;
		padding: 6px 0;
	}
	.discovery-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.discovery-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 6px 8px;
		border: 1px solid var(--vscode-panel-border, #444);
		border-radius: 4px;
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		cursor: pointer;
		text-align: left;
	}
	.discovery-item:hover:not(:disabled) {
		background: var(--vscode-list-hoverBackground);
	}
	.discovery-item.selected {
		border-color: var(--vscode-focusBorder);
	}
	.discovery-item:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.discovery-main {
		font-weight: bold;
	}
	.discovery-meta {
		opacity: 0.8;
		font-size: 0.92em;
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
		let overflowMenuOpen = false;
		let initialAutoScanPending = true;
		let scanInFlight = false;
		let scanLoopTimer = null;
		let scanLoopMode = '';
		let lastScanBackground = false;
		const DEFAULT_MAX_VISIBLE_BRICK_TABS = 4;
		const ESTIMATED_BRICK_TAB_WIDTH = 128;
		const ESTIMATED_CONTROL_TAB_WIDTH = 42;
		const TAB_STRIP_HORIZONTAL_PADDING = 16;
		const DISCOVERY_REFRESH_FAST_MS = ${this.discoveryRefreshFastMs};
		const DISCOVERY_REFRESH_SLOW_MS = ${this.discoveryRefreshSlowMs};

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

		function computeMaxVisibleBrickTabs(rootWidth, brickCount) {
			if (!Number.isFinite(rootWidth) || rootWidth <= 0) {
				return DEFAULT_MAX_VISIBLE_BRICK_TABS;
			}
			const reservedControlsWidth = ESTIMATED_CONTROL_TAB_WIDTH
				+ (brickCount > 1 ? ESTIMATED_CONTROL_TAB_WIDTH : 0);
			const available = Math.max(0, rootWidth - TAB_STRIP_HORIZONTAL_PADDING - reservedControlsWidth);
			const byWidth = Math.floor(available / ESTIMATED_BRICK_TAB_WIDTH);
			return Math.max(1, byWidth);
		}

		function buildTabLayout(allBricks, maxVisibleBrickTabs) {
			if (!allBricks || allBricks.length <= maxVisibleBrickTabs) {
				return { visibleBricks: allBricks || [], overflowBricks: [] };
			}

			const initiallyVisible = allBricks.slice(0, maxVisibleBrickTabs);
			const activeBrick = allBricks.find((brick) => brick.isActive);
			if (activeBrick && !initiallyVisible.some((brick) => brick.brickId === activeBrick.brickId)) {
				const visibleBricks = initiallyVisible.slice(0, maxVisibleBrickTabs - 1);
				visibleBricks.push(activeBrick);
				const visibleIds = new Set(visibleBricks.map((brick) => brick.brickId));
				return {
					visibleBricks,
					overflowBricks: allBricks.filter((brick) => !visibleIds.has(brick.brickId))
				};
			}

			const visibleIds = new Set(initiallyVisible.map((brick) => brick.brickId));
			return {
				visibleBricks: initiallyVisible,
				overflowBricks: allBricks.filter((brick) => !visibleIds.has(brick.brickId))
			};
		}

		function mergeDiscoveryCandidates(nextCandidates) {
			const byId = new Map();
			for (const candidate of nextCandidates || []) {
				if (!candidate || !candidate.candidateId) {
					continue;
				}
				byId.set(candidate.candidateId, candidate);
			}
			discoveryCandidates = Array.from(byId.values());
			if (selectedDiscoveryCandidateId && !byId.has(selectedDiscoveryCandidateId)) {
				selectedDiscoveryCandidateId = '';
			}
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

		function render() {
			const root = document.getElementById('root');
			const activeBrick = bricks.find(b => b.isActive);
			const maxVisibleBrickTabs = computeMaxVisibleBrickTabs(root.clientWidth, bricks.length);
			const tabLayout = buildTabLayout(bricks, maxVisibleBrickTabs);
			const visibleBricks = tabLayout.visibleBricks;
			const overflowBricks = tabLayout.overflowBricks;
			if (overflowBricks.length === 0 && overflowMenuOpen) {
				overflowMenuOpen = false;
			}
			const overflowHasActive = overflowBricks.some((brick) => brick.isActive);

			let html = '<div class="brick-tabs-wrap"><div class="brick-tabs"><div class="brick-tabs-main">';
			for (const brick of visibleBricks) {
				const activeClass = brick.isActive ? ' active' : '';
				html += '<button class="brick-tab' + activeClass + '" data-brick-id="' + brick.brickId + '" title="' + brick.displayName + '">'
					+ '<span class="status-dot status-' + brick.status + '"></span>'
					+ '<span class="brick-tab-label">' + brick.displayName + '</span>'
					+ '</button>';
			}
			html += '</div>';
			if (overflowBricks.length > 0) {
				const overflowActiveClass = overflowHasActive ? ' active' : '';
				html += '<button class="brick-tab overflow-toggle' + overflowActiveClass + '" data-overflow-toggle="true" title="More Bricks" aria-label="More Bricks">...</button>';
			}
			const addTabActiveClass = (discoveryOpen || bricks.length === 0) ? ' active' : '';
			html += '<button class="brick-tab add-tab' + addTabActiveClass + '" data-add-brick="true" title="Connect EV3 Brick" aria-label="Connect EV3 Brick">+</button>';
			html += '</div>';
			html += '<div class="brick-tab-baseline"></div>';
			html += '<div class="brick-tab-baseline-gap"></div>';
			if (overflowMenuOpen && overflowBricks.length > 0) {
				html += '<div class="brick-overflow-menu">';
				for (const brick of overflowBricks) {
					const overflowItemActiveClass = brick.isActive ? ' active' : '';
					html += '<button class="brick-overflow-item' + overflowItemActiveClass + '" data-overflow-brick-id="' + brick.brickId + '" title="' + brick.displayName + '">'
						+ '<span class="status-dot status-' + brick.status + '"></span>'
						+ '<span class="brick-overflow-label">' + brick.displayName + '</span>'
						+ '</button>';
				}
				html += '</div>';
			}
			html += '</div>';

			html += '<div class="brick-detail-area">';

			if (discoveryOpen) {
				html += '<div class="discovery-section">'
					+ '<div class="discovery-title">Available Bricks</div>'
					+ '<div class="discovery-help">Single-click to select, double-click to connect.</div>';
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
						const transportLabel = String(candidate.transport || 'unknown').toUpperCase();
						const connectedLabel = candidate.alreadyConnected ? ' | connected' : '';
						const detail = candidate.detail ? ' | ' + candidate.detail : '';
						const disabledAttr = connectingDiscoveryCandidateId ? ' disabled' : '';
						html += '<button class="discovery-item' + selectedClass + '" data-candidate-id="' + candidate.candidateId + '"' + disabledAttr + '>'
							+ '<span class="discovery-main">' + candidate.displayName + '</span>'
							+ '<span class="discovery-meta">' + transportLabel + detail + connectedLabel + '</span>'
							+ '</button>';
					}
					html += '</div>';
				}
				html += '</div>';
			}

			if (bricks.length === 0) {
				html += '<div class="empty-message">No bricks connected.<br>Use the + tab to connect an EV3 Brick.</div>';
			}

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
			const baselineGap = root.querySelector('.brick-tab-baseline-gap');
			const activeTab = root.querySelector('.brick-tab.active');
			if (baselineGap && activeTab) {
				const left = activeTab.offsetLeft - 1;
				const width = activeTab.offsetWidth + 2;
				baselineGap.style.left = left + 'px';
				baselineGap.style.width = width + 'px';
				baselineGap.style.display = 'block';
			} else if (baselineGap) {
				baselineGap.style.display = 'none';
			}

			for (const tab of root.querySelectorAll('.brick-tab')) {
				tab.addEventListener('click', () => {
					if (tab.dataset.addBrick === 'true') {
						overflowMenuOpen = false;
						requestDiscoveryScan({ preserveCandidates: false });
						return;
					}
					if (tab.dataset.overflowToggle === 'true') {
						overflowMenuOpen = !overflowMenuOpen;
						render();
						return;
					}
					overflowMenuOpen = false;
					discoveryOpen = false;
					stopScanLoop();
					vscode.postMessage({ type: 'selectBrick', brickId: tab.dataset.brickId });
				});
			}
			for (const overflowButton of root.querySelectorAll('.brick-overflow-item')) {
				overflowButton.addEventListener('click', () => {
					overflowMenuOpen = false;
					vscode.postMessage({ type: 'selectBrick', brickId: overflowButton.dataset.overflowBrickId });
				});
			}
			for (const candidateButton of root.querySelectorAll('.discovery-item')) {
				candidateButton.addEventListener('click', () => {
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
					vscode.postMessage({ type: 'connectScannedBrick', candidateId });
				});
			}
		}

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'updateBricks') {
				bricks = message.bricks;
				sensors = message.sensors || [];
				motors = message.motors || [];
				controls = message.controls || null;
				if (initialAutoScanPending && bricks.length === 0) {
					initialAutoScanPending = false;
					requestDiscoveryScan({ preserveCandidates: false });
					return;
				}
				initialAutoScanPending = false;
				render();
				scheduleNextScan();
				return;
			}
			if (message.type === 'scanStarted') {
				if (!lastScanBackground) {
					discoveryOpen = true;
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
					discoveryOpen = true;
					discoveryLoading = false;
					discoveryError = '';
				}
				scanInFlight = false;
				mergeDiscoveryCandidates(message.candidates || []);
				connectingDiscoveryCandidateId = '';
				if (discoveryOpen || !lastScanBackground) {
					render();
				}
				scheduleNextScan();
				return;
			}
			if (message.type === 'scanFailed') {
				if (!lastScanBackground) {
					discoveryOpen = true;
					discoveryLoading = false;
					discoveryError = message.message || 'Brick scan failed.';
				}
				scanInFlight = false;
				connectingDiscoveryCandidateId = '';
				if (discoveryOpen || !lastScanBackground) {
					render();
				}
				scheduleNextScan();
				return;
			}
			if (message.type === 'connectStarted') {
				discoveryOpen = true;
				connectingDiscoveryCandidateId = message.candidateId || '';
				discoveryError = '';
				render();
				return;
			}
			if (message.type === 'connectSucceeded') {
				discoveryOpen = false;
				discoveryLoading = false;
				discoveryError = '';
				discoveryCandidates = [];
				selectedDiscoveryCandidateId = '';
				connectingDiscoveryCandidateId = '';
				scanInFlight = false;
				stopScanLoop();
				render();
				scheduleNextScan(true);
				return;
			}
			if (message.type === 'connectFailed') {
				connectingDiscoveryCandidateId = '';
				discoveryError = message.message || 'Connect failed.';
				scanInFlight = false;
				render();
				scheduleNextScan();
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
