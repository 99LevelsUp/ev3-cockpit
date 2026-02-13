import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';

export type BrickTransportVisual = BrickSnapshot['transport'] | 'unknown';

const TRANSPORT_THEME_ICON_NAME: Record<BrickTransportVisual, string> = {
	auto: 'symbol-misc',
	usb: 'plug',
	bluetooth: 'plug',
	tcp: 'broadcast',
	mock: 'beaker',
	unknown: 'question'
};

const TRANSPORT_WEBVIEW_ICON_SVG: Record<BrickTransportVisual, string> = {
	auto: 'codicon:symbol-misc',
	usb: 'codicon:plug',
	bluetooth: '<svg viewBox="0 0 16 16" class="transport-icon-svg" aria-hidden="true">'
		+ '<path d="M7 2l4 3-4 3 4 3-4 3V2z" />'
		+ '<path d="M4 4l6 4-6 4" />'
		+ '</svg>',
	tcp: 'codicon:broadcast',
	mock: '<svg viewBox="-12 -12 24 24" class="transport-icon-svg" aria-hidden="true">'
		+ '<path d="M 3,2 V -2 A 1,1 45 0 0 2,-3 h -4 a 1,1 135 0 0 -1,1 v 4 a 1,1 45 0 0 1,1 H 2 A 1,1 135 0 0 3,2 Z" />'
		+ '<path d="M 5,4 V 1 h 6 a 1.24,1.24 67.5 0 1 0.88,2.12 L 4,11 H -4 L -11.88,3.12 A 1.24,1.24 112.5 0 1 -11,1 h 6 v 3 a 1,1 45 0 0 1,1 H 4 A 1,1 135 0 0 5,4 Z" />'
		+ '<path d="m 5,-4 v 3 h 6 a 1.24,1.24 112.5 0 0 0.88,-2.12 L 4,-11 h -8 l -7.88,7.88 A 1.24,1.24 67.5 0 0 -11,-1 h 6 v -3 a 1,1 135 0 1 1,-1 h 8 a 1,1 45 0 1 1,1 z" />'
		+ '</svg>',
	unknown: 'codicon:question'
};

const TAB_ACTION_CODICON_REFERENCES = {
	close: 'codicon:close',
	add: 'codicon:add',
	settings: 'codicon:gear',
	apply: 'codicon:check',
	menu: 'codicon:chevron-down',
	reload: 'codicon:refresh',
	cancel: 'codicon:close'
} as const;

const TAB_ACTION_WEBVIEW_ICON_SVG: Record<'close' | 'add' | 'settings' | 'apply' | 'menu' | 'reload' | 'cancel', string> = {
	...TAB_ACTION_CODICON_REFERENCES
};

function isBrickTransportVisual(value: string): value is BrickTransportVisual {
	return value === 'auto'
		|| value === 'usb'
		|| value === 'bluetooth'
		|| value === 'tcp'
		|| value === 'mock'
		|| value === 'unknown';
}

export function normalizeBrickTransport(value: string | undefined): BrickTransportVisual {
	if (!value) {
		return 'unknown';
	}
	const normalized = value.toLowerCase();
	return isBrickTransportVisual(normalized) ? normalized : 'unknown';
}

export function createTransportThemeIcon(transport: string | undefined): vscode.ThemeIcon {
	return new vscode.ThemeIcon(TRANSPORT_THEME_ICON_NAME[normalizeBrickTransport(transport)]);
}

export function getWebviewTransportIcons(): Record<BrickTransportVisual, string> {
	return { ...TRANSPORT_WEBVIEW_ICON_SVG };
}

export function getWebviewTabActionIcons(): Record<'close' | 'add' | 'settings' | 'apply' | 'menu' | 'reload' | 'cancel', string> {
	return { ...TAB_ACTION_WEBVIEW_ICON_SVG };
}
