import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';

export type BrickTransportVisual = BrickSnapshot['transport'] | 'unknown';

const TRANSPORT_THEME_ICON_NAME: Record<BrickTransportVisual, string> = {
	auto: 'question',
	usb: 'plug',
	bluetooth: 'bluetooth',
	tcp: 'rss',
	mock: 'beaker',
	unknown: 'question'
};

const UNKNOWN_TRANSPORT_ICON = '<svg viewBox="0 0 16 16" class="transport-icon-svg" aria-hidden="true">'
	+ '<circle cx="8" cy="8" r="6" />'
	+ '<path d="M6.8 6.3a1.8 1.8 0 1 1 2.5 1.7c-.8.3-1.3.9-1.3 1.7v.4" />'
	+ '<path d="M8 12.2h0" />'
	+ '</svg>';

const TRANSPORT_WEBVIEW_ICON_SVG: Record<BrickTransportVisual, string> = {
	auto: UNKNOWN_TRANSPORT_ICON,
	// Keep USB icon aligned with the File System tree icon semantics ("plug").
	usb: '<svg viewBox="0 0 16 16" class="transport-icon-svg" aria-hidden="true">'
		+ '<rect x="4.3" y="4.8" width="7.4" height="9" rx="1.6" />'
		+ '<rect x="5.9" y="1.6" width="4.2" height="3.4" rx="0.5" />'
		+ '<path d="M6.6 3h0" />'
		+ '<path d="M9.4 3h0" />'
		+ '<path d="M6 8.2h4" />'
		+ '</svg>',
	bluetooth: '<svg viewBox="0 0 16 16" class="transport-icon-svg" aria-hidden="true">'
		+ '<path d="M7 2l4 3-4 3 4 3-4 3V2z" />'
		+ '<path d="M4 4l6 4-6 4" />'
		+ '</svg>',
	// Keep WiFi/TCP icon aligned with the tab icon already used in Brick panel.
	tcp: '<svg viewBox="0 0 16 16" class="transport-icon-svg" aria-hidden="true">'
		+ '<path d="M2.5 6.5a7.5 7.5 0 0 1 11 0" />'
		+ '<path d="M5 9.5a4.5 4.5 0 0 1 6 0" />'
		+ '<path d="M7.1 12a1.4 1.4 0 0 1 1.8 0" />'
		+ '</svg>',
	mock: '<svg viewBox="0 0 16 16" class="transport-icon-svg" aria-hidden="true">'
		+ '<path d="M6 2h4" />'
		+ '<path d="M5 4h6l-1 3v2.8a3 3 0 0 1-.9 2.1L8 13l-1.1-1.1A3 3 0 0 1 6 9.8V7L5 4z" />'
		+ '</svg>',
	unknown: UNKNOWN_TRANSPORT_ICON
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
