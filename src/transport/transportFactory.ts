import * as vscode from 'vscode';
import { OutputChannelLogger } from '../diagnostics/logger';
import { MockWorld } from '../mock/mockWorld';
import { decodeEv3Packet } from '../protocol/ev3Packet';
import { MockTransportAdapter } from './mockTransportAdapter';
import { TransportAdapter } from './transportAdapter';
import { TcpAdapter } from './tcpAdapter';
import { UsbHidAdapter } from './usbHidAdapter';
import { TransportMode } from '../types/enums';

// Re-export for backward compatibility
export { TransportMode };

interface ConfigurationReader {
	get<T>(section: string, defaultValue?: T): T;
}

export interface TransportConfigOverrides {
	mode?: TransportMode;
	usbPath?: string;
	tcpHost?: string;
	tcpPort?: number;
	tcpUseDiscovery?: boolean;
	tcpSerialNumber?: string;
	btPortPath?: string;
}

/** Default EV3 USB HID report size (1-byte report ID + 1024-byte payload). */
const DEFAULT_USB_HID_REPORT_SIZE = 1025;
/** Default EV3 TCP communication port (LEGO standard). */
const DEFAULT_TCP_PORT = 5555;
/** Default EV3 UDP discovery port. */
const DEFAULT_TCP_DISCOVERY_PORT = 3015;
/** Default timeout (ms) for UDP-based EV3 Brick discovery. */
const DEFAULT_TCP_DISCOVERY_TIMEOUT_MS = 7000;
/** Minimum allowed timeout (ms) for probe and discovery operations. */
const MIN_PROBE_TIMEOUT_MS = 100;

function sanitizeNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return fallback;
	}
	return Math.max(min, Math.floor(value));
}

function sanitizeTransportMode(value: unknown): TransportMode {
	if (value === TransportMode.USB || value === 'usb') return TransportMode.USB;
	if (value === TransportMode.TCP || value === 'tcp') return TransportMode.TCP;
	if (value === TransportMode.BT || value === 'bt') return TransportMode.BT;
	if (value === TransportMode.MOCK || value === 'mock') return TransportMode.MOCK;
	return TransportMode.USB;
}

function createMockProbeTransport(logger: OutputChannelLogger): MockTransportAdapter {
	const world = MockWorld.create();
	world.startTicking(100);

	logger.info('MockWorld created with default seed. Tick interval: 100 ms.');

	return new MockTransportAdapter(async (packet, options) => {
		const request = decodeEv3Packet(packet);
		logger.trace('Mock transport received packet', {
			messageCounter: request.messageCounter,
			type: request.type,
			payloadBytes: request.payload.length,
			timeoutMs: options.timeoutMs
		});

		const result = world.getResponder()(packet, options);
		return result instanceof Promise ? result : result;
	});
}

function createUsbTransport(cfg: ConfigurationReader): UsbHidAdapter {
	const rawPath = cfg.get('transport.usb.path');
	const path = typeof rawPath === 'string' && rawPath.trim().length > 0 ? rawPath.trim() : undefined;
	const vendorId = sanitizeNumber(cfg.get('transport.usb.vendorId'), 0x0694, 0);
	const productId = sanitizeNumber(cfg.get('transport.usb.productId'), 0x0005, 0);
	const reportId = sanitizeNumber(cfg.get('transport.usb.reportId'), 0, 0);
	const reportSize = sanitizeNumber(cfg.get('transport.usb.reportSize'), DEFAULT_USB_HID_REPORT_SIZE, 2);

	return new UsbHidAdapter({
		path,
		vendorId,
		productId,
		reportId,
		reportSize
	});
}

function createTcpTransport(cfg: ConfigurationReader, timeoutMs: number): TcpAdapter {
	const rawHost = cfg.get('transport.tcp.host');
	const host = typeof rawHost === 'string' ? rawHost.trim() : '';
	const useDiscovery = cfg.get('transport.tcp.useDiscovery') === true;
	if (!host && !useDiscovery) {
		throw new Error('TCP transport requires setting ev3-cockpit.transport.tcp.host or enabling discovery.');
	}

	const port = sanitizeNumber(cfg.get('transport.tcp.port'), DEFAULT_TCP_PORT, 1);
	const discoveryPort = sanitizeNumber(cfg.get('transport.tcp.discoveryPort'), DEFAULT_TCP_DISCOVERY_PORT, 1);
	const discoveryTimeoutMs = sanitizeNumber(
		cfg.get('transport.tcp.discoveryTimeoutMs'),
		DEFAULT_TCP_DISCOVERY_TIMEOUT_MS,
		MIN_PROBE_TIMEOUT_MS
	);
	const rawSerial = cfg.get('transport.tcp.serialNumber');
	const serialNumber = typeof rawSerial === 'string' ? rawSerial.trim() : '';
	const handshakeTimeoutMs = sanitizeNumber(cfg.get('transport.tcp.handshakeTimeoutMs'), timeoutMs, 50);

	return new TcpAdapter({
		host,
		port,
		serialNumber,
		useDiscovery,
		discoveryPort,
		discoveryTimeoutMs,
		handshakeTimeoutMs
	});
}

export function createProbeTransportForMode(
	cfg: ConfigurationReader,
	logger: OutputChannelLogger,
	timeoutMs: number,
	modeRaw: unknown
): TransportAdapter {
	const mode = sanitizeTransportMode(modeRaw);
	if (mode === TransportMode.MOCK) {
		logger.info('Using mock transport for connect probe (ev3-cockpit.transport.mode=mock).');
		return createMockProbeTransport(logger);
	}

	if (mode === TransportMode.USB) {
		logger.info('Using USB transport for connect probe (ev3-cockpit.transport.mode=usb).');
		return createUsbTransport(cfg);
	}

	if (mode === TransportMode.TCP) {
		logger.info('Using TCP transport for connect probe (ev3-cockpit.transport.mode=tcp).');
		return createTcpTransport(cfg, timeoutMs);
	}

	if (mode === TransportMode.BT) {
		logger.info('Using BT transport for connect probe (ev3-cockpit.transport.mode=bt).');
		const rawPort = cfg.get('transport.bt.portPath');
		const portPath = typeof rawPort === 'string' && rawPort.trim().length > 0 ? rawPort.trim() : undefined;
		if (portPath) {
			const { BluetoothSppAdapter } = require('./bluetoothSppAdapter') as typeof import('./bluetoothSppAdapter');
			return new BluetoothSppAdapter({ portPath });
		}
		// No explicit port — use auto-port discovery
		const { BluetoothAutoPortAdapter } = require('./bluetoothAutoPortAdapter') as typeof import('./bluetoothAutoPortAdapter');
		return new BluetoothAutoPortAdapter({ probeTimeoutMs: timeoutMs });
	}

	logger.info('Using USB transport for connect probe (fallback).');
	return createUsbTransport(cfg);
}

export function createProbeTransportFromWorkspace(
	logger: OutputChannelLogger,
	timeoutMs: number,
	overrides?: TransportConfigOverrides
): TransportAdapter {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	const profileReader: ConfigurationReader = {
		get<T>(section: string, defaultValue?: T): T {
			if (overrides) {
				const mappedKey = section
					.replace(/^transport\./, '')
					.replace(/\./g, '') as
					| 'mode'
					| 'usbpath'
					| 'tcphost'
					| 'tcpport'
					| 'tcpusediscovery'
					| 'tcpserialnumber'
					| 'btportpath';
				const overrideMap: Partial<Record<typeof mappedKey, unknown>> = {
					mode: overrides.mode,
					usbpath: overrides.usbPath,
					tcphost: overrides.tcpHost,
					tcpport: overrides.tcpPort,
					tcpusediscovery: overrides.tcpUseDiscovery,
					tcpserialnumber: overrides.tcpSerialNumber,
					btportpath: overrides.btPortPath
				};
				if (overrideMap[mappedKey] !== undefined) {
					return overrideMap[mappedKey] as T;
				}
			}
			return cfg.get(section, defaultValue as T);
		}
	};
	return createProbeTransportForMode(profileReader, logger, timeoutMs, overrides?.mode ?? cfg.get('transport.mode'));
}
