import * as vscode from 'vscode';
import { OutputChannelLogger } from '../diagnostics/logger';
import { MockWorld } from '../mock/mockWorld';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { MockTransportAdapter } from './mockTransportAdapter';
import { TransportAdapter, TransportRequestOptions } from './transportAdapter';
import { TcpAdapter } from './tcpAdapter';
import { BluetoothSppAdapter } from './bluetoothSppAdapter';
import { buildBluetoothPortSelectionPlans, BluetoothPortSelectionPlan } from './bluetoothPortSelection';
import {
	classifyBluetoothFailure,
	isLikelyDynamicBluetoothAvailabilityFailure,
	isLikelyTransientBluetoothFailure,
	summarizeBluetoothFailures
} from './bluetoothFailure';
import { UsbHidAdapter } from './usbHidAdapter';
import { listSerialCandidates, listUsbHidCandidates } from './discovery';

export type TransportMode = 'usb' | 'bt' | 'tcp' | 'mock';

interface ConfigurationReader {
	get<T>(section: string, defaultValue?: T): T;
}

export interface TransportConfigOverrides {
	mode?: TransportMode;
	usbPath?: string;
	btPort?: string;
	tcpHost?: string;
	tcpPort?: number;
	tcpUseDiscovery?: boolean;
	tcpSerialNumber?: string;
}

/** Maximum number of serial port open attempts for Bluetooth auto-port scanning. */
const DEFAULT_BT_AUTO_PORT_ATTEMPTS = 3;
/** Delay (ms) between Bluetooth serial port open retries. */
const DEFAULT_BT_AUTO_RETRY_DELAY_MS = 300;
/** Delay (ms) after opening a Bluetooth serial port before probing (firmware needs settling time). */
const DEFAULT_BT_AUTO_POST_OPEN_DELAY_MS = 120;
/** Timeout (ms) for a single Bluetooth probe attempt during auto-port scanning. */
const DEFAULT_BT_AUTO_PROBE_TIMEOUT_MS = 5_000;
/** Number of rediscovery rounds when all known Bluetooth ports fail. */
const DEFAULT_BT_AUTO_REDISCOVERY_ATTEMPTS = 1;
/** Delay (ms) before starting a Bluetooth rediscovery round. */
const DEFAULT_BT_AUTO_REDISCOVERY_DELAY_MS = 700;
/** Whether to attempt DTR toggle as fallback when Bluetooth open fails. */
const DEFAULT_BT_AUTO_DTR_FALLBACK = true;

/** Default EV3 USB HID report size (1-byte report ID + 1024-byte payload). */
const DEFAULT_USB_HID_REPORT_SIZE = 1025;
/** Standard EV3 Bluetooth serial baud rate. */
const DEFAULT_BT_BAUD_RATE = 115_200;
/** Minimum allowed baud rate for serial port configuration. */
const MIN_BT_BAUD_RATE = 300;
/** Default EV3 TCP communication port (LEGO standard). */
const DEFAULT_TCP_PORT = 5555;
/** Default EV3 UDP discovery port. */
const DEFAULT_TCP_DISCOVERY_PORT = 3015;
/** Default timeout (ms) for UDP-based EV3 Brick discovery. */
const DEFAULT_TCP_DISCOVERY_TIMEOUT_MS = 7000;
/** Minimum allowed timeout (ms) for Bluetooth probe and TCP discovery. */
const MIN_PROBE_TIMEOUT_MS = 100;

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class BluetoothAutoPortAdapter implements TransportAdapter {
	private active?: BluetoothSppAdapter;

	public constructor(
		private readonly logger: OutputChannelLogger,
		private readonly preferredPort: string | undefined,
		private readonly baudRate: number,
		private readonly dtr: boolean,
		private readonly autoDtrFallback: boolean,
		private readonly probeTimeoutMs: number,
		private readonly portAttempts: number,
		private readonly retryDelayMs: number,
		private readonly postOpenDelayMs: number,
		private readonly rediscoveryAttempts: number,
		private readonly rediscoveryDelayMs: number
	) {}

	public async open(): Promise<void> {
		if (this.active) {
			return;
		}

		const failures: string[] = [];
		const dtrProfiles = this.autoDtrFallback ? Array.from(new Set([this.dtr, !this.dtr])) : [this.dtr];
		for (const dtr of dtrProfiles) {
			if (dtr !== this.dtr) {
				this.logger.info('Bluetooth auto-port trying DTR fallback profile', {
					dtr
				});
			}
			for (let discoveryPass = 0; discoveryPass <= this.rediscoveryAttempts; discoveryPass += 1) {
				const candidatePlans = await this.resolveCandidatePlans();
				if (candidatePlans.length === 0) {
					failures.push(
						`discovery(dtr=${dtr}): Bluetooth transport could not resolve any serial COM candidates.`
					);
				} else {
					const roundFailures = await this.tryOpenAgainstPlans(candidatePlans, discoveryPass + 1, dtr);
					if (this.active) {
						return;
					}
					failures.push(...roundFailures);
				}

				if (discoveryPass >= this.rediscoveryAttempts) {
					break;
				}

				const lastFailure = failures[failures.length - 1] ?? '';
				if (!isLikelyDynamicBluetoothAvailabilityFailure(lastFailure)) {
					break;
				}

				this.logger.info('Bluetooth auto-port refreshing COM discovery after failed round', {
					dtr,
					pass: discoveryPass + 1,
					nextPass: discoveryPass + 2,
					delayMs: this.rediscoveryDelayMs
				});
				await sleep(this.rediscoveryDelayMs);
			}
		}
		const summary = summarizeBluetoothFailures(failures);
		this.logger.warn('Bluetooth auto-port failed after exhausting candidates', {
			totalFailures: summary.total,
			primaryPhase: summary.primaryPhase,
			phaseBreakdown: summary.byPhase,
			likelyTransientCount: summary.likelyTransientCount,
			likelyDynamicAvailabilityCount: summary.likelyDynamicAvailabilityCount,
			windowsCodes: summary.windowsCodes
		});

		const windowsCodes =
			summary.windowsCodes.length > 0 ? `codes=${summary.windowsCodes.join(',')}` : 'codes=n/a';
		throw new Error(
			`Bluetooth auto-port failed (${windowsCodes}, phase=${summary.primaryPhase}, transient=${summary.likelyTransientCount}/${summary.total}, dynamic=${summary.likelyDynamicAvailabilityCount}/${summary.total}). ${failures.join(' | ')}`
		);
	}

	public async close(): Promise<void> {
		if (!this.active) {
			return;
		}

		const current = this.active;
		this.active = undefined;
		await current.close();
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		if (!this.active) {
			throw new Error('Bluetooth auto-port adapter is not open.');
		}

		return this.active.send(packet, options);
	}

	private async resolveCandidatePlans(): Promise<BluetoothPortSelectionPlan[]> {
		const usbCandidates = await listUsbHidCandidates();
		const preferredSerial = usbCandidates[0]?.serialNumber;
		const listed = await listSerialCandidates();
		return buildBluetoothPortSelectionPlans(this.preferredPort, listed, preferredSerial);
	}

	private async verifyEv3Probe(adapter: BluetoothSppAdapter): Promise<void> {
		const probePacket = encodeEv3Packet(0, EV3_COMMAND.SYSTEM_COMMAND_REPLY, new Uint8Array([0x9d]));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error('bt-port-probe-timeout')), this.probeTimeoutMs);
		try {
			const replyBytes = await adapter.send(probePacket, {
				timeoutMs: this.probeTimeoutMs,
				signal: controller.signal
			});
			const reply = decodeEv3Packet(replyBytes);
			if (reply.type !== EV3_REPLY.SYSTEM_REPLY && reply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
				throw new Error(`Unexpected reply type 0x${reply.type.toString(16)} during BT port probe.`);
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	private async tryOpenAgainstPlans(
		candidatePlans: BluetoothPortSelectionPlan[],
		pass: number,
		dtr: boolean
	): Promise<string[]> {
		const failures: string[] = [];
		const attemptedPorts = new Set<string>();
		for (const plan of candidatePlans) {
			this.logger.info('Bluetooth auto-port trying selection strategy', {
				pass,
				dtr,
				strategy: plan.name,
				candidates: plan.ports
			});
			for (const port of plan.ports) {
				if (attemptedPorts.has(port)) {
					continue;
				}
				attemptedPorts.add(port);

				const attemptBudget = plan.name === 'legacy-order' ? 1 : this.portAttempts;
				for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
					const adapter = new BluetoothSppAdapter({
						port,
						baudRate: this.baudRate,
						dtr
					});

					try {
						await adapter.open();
						await sleep(this.postOpenDelayMs);
						await this.verifyEv3Probe(adapter);
						this.active = adapter;
						this.logger.info('Bluetooth auto-port selected candidate', {
							pass,
							dtr,
							port,
							strategy: plan.name,
							attempt
						});
						return failures;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const classification = classifyBluetoothFailure(message, plan.name);
						this.logger.info('Bluetooth auto-port candidate attempt failed', {
							pass,
							dtr,
							strategy: plan.name,
							port,
							attempt,
							message,
							phase: classification.phase,
							windowsCode: classification.windowsCode,
							likelyTransient: classification.likelyTransient,
							likelyDynamicAvailability: classification.likelyDynamicAvailability
						});
						failures.push(
							`${plan.name}/${port}#${attempt}(dtr=${dtr},phase=${classification.phase}${
								classification.windowsCode !== undefined ? `,code=${classification.windowsCode}` : ''
							}): ${message}`
						);
						await adapter.close().catch(() => undefined);
						const transient = isLikelyTransientBluetoothFailure(message, plan.name);
						if (!transient) {
							break;
						}
						if (attempt < attemptBudget) {
							await sleep(this.retryDelayMs);
						}
					}
				}
			}
		}
		return failures;
	}
}

function sanitizeNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return fallback;
	}

	return Math.max(min, Math.floor(value));
}

function sanitizeTransportMode(value: unknown): TransportMode {
	if (value === 'usb' || value === 'bt' || value === 'tcp' || value === 'mock') {
		return value;
	}

	return 'usb';
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

function createBluetoothTransport(cfg: ConfigurationReader, logger: OutputChannelLogger): TransportAdapter {
	const rawPort = cfg.get('transport.bluetooth.port');
	const port = typeof rawPort === 'string' ? rawPort.trim() : '';
	const baudRate = sanitizeNumber(cfg.get('transport.bluetooth.baudRate'), DEFAULT_BT_BAUD_RATE, MIN_BT_BAUD_RATE);
	const dtr = cfg.get('transport.bluetooth.dtr') === true;
	const autoDtrFallbackRaw = cfg.get('transport.bluetooth.autoDtrFallback');
	const autoDtrFallback =
		typeof autoDtrFallbackRaw === 'boolean' ? autoDtrFallbackRaw : DEFAULT_BT_AUTO_DTR_FALLBACK;
	const probeTimeoutMs = sanitizeNumber(
		cfg.get('transport.bluetooth.portProbeTimeoutMs'),
		DEFAULT_BT_AUTO_PROBE_TIMEOUT_MS,
		MIN_PROBE_TIMEOUT_MS
	);
	const portAttempts = sanitizeNumber(
		cfg.get('transport.bluetooth.portAttempts'),
		DEFAULT_BT_AUTO_PORT_ATTEMPTS,
		1
	);
	const retryDelayMs = sanitizeNumber(
		cfg.get('transport.bluetooth.retryDelayMs'),
		DEFAULT_BT_AUTO_RETRY_DELAY_MS,
		0
	);
	const postOpenDelayMs = sanitizeNumber(
		cfg.get('transport.bluetooth.postOpenDelayMs'),
		DEFAULT_BT_AUTO_POST_OPEN_DELAY_MS,
		0
	);
	const rediscoveryAttempts = sanitizeNumber(
		cfg.get('transport.bluetooth.rediscoveryAttempts'),
		DEFAULT_BT_AUTO_REDISCOVERY_ATTEMPTS,
		0
	);
	const rediscoveryDelayMs = sanitizeNumber(
		cfg.get('transport.bluetooth.rediscoveryDelayMs'),
		DEFAULT_BT_AUTO_REDISCOVERY_DELAY_MS,
		0
	);
	const autoPortFallback = cfg.get('transport.bluetooth.autoPortFallback') !== false;
	if (autoPortFallback) {
		return new BluetoothAutoPortAdapter(
			logger,
			port || undefined,
			baudRate,
			dtr,
			autoDtrFallback,
			probeTimeoutMs,
			portAttempts,
			retryDelayMs,
			postOpenDelayMs,
			rediscoveryAttempts,
			rediscoveryDelayMs
		);
	}

	if (!port) {
		throw new Error('Bluetooth transport requires setting ev3-cockpit.transport.bluetooth.port.');
	}

	return new BluetoothSppAdapter({ port, baudRate, dtr });
}

function createTcpTransport(cfg: ConfigurationReader, timeoutMs: number): TcpAdapter {
	const rawHost = cfg.get('transport.tcp.host');
	const host = typeof rawHost === 'string' ? rawHost.trim() : '';
	const useDiscovery = cfg.get('transport.tcp.useDiscovery') === true;
	if (!host) {
		if (!useDiscovery) {
			throw new Error('TCP transport requires setting ev3-cockpit.transport.tcp.host or enabling discovery.');
		}
	}

	const port = sanitizeNumber(cfg.get('transport.tcp.port'), DEFAULT_TCP_PORT, 1);
	const discoveryPort = sanitizeNumber(cfg.get('transport.tcp.discoveryPort'), DEFAULT_TCP_DISCOVERY_PORT, 1);
	const discoveryTimeoutMs = sanitizeNumber(cfg.get('transport.tcp.discoveryTimeoutMs'), DEFAULT_TCP_DISCOVERY_TIMEOUT_MS, MIN_PROBE_TIMEOUT_MS);
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
	if (mode === 'mock') {
		logger.info('Using mock transport for connect probe (ev3-cockpit.transport.mode=mock).');
		return createMockProbeTransport(logger);
	}

	if (mode === 'usb') {
		logger.info('Using USB transport for connect probe (ev3-cockpit.transport.mode=usb).');
		return createUsbTransport(cfg);
	}

	if (mode === 'bt') {
		logger.info('Using Bluetooth transport for connect probe (ev3-cockpit.transport.mode=bt).');
		return createBluetoothTransport(cfg, logger);
	}

	if (mode === 'tcp') {
		logger.info('Using TCP transport for connect probe (ev3-cockpit.transport.mode=tcp).');
		return createTcpTransport(cfg, timeoutMs);
	}

	// Fallback to USB when mode is unrecognized (sanitizeTransportMode already defaults to 'usb').
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
					| 'bluetoothport'
					| 'tcphost'
					| 'tcpport'
					| 'tcpusediscovery'
					| 'tcpserialnumber';
				const overrideMap: Partial<Record<typeof mappedKey, unknown>> = {
					mode: overrides.mode,
					usbpath: overrides.usbPath,
					bluetoothport: overrides.btPort,
					tcphost: overrides.tcpHost,
					tcpport: overrides.tcpPort,
					tcpusediscovery: overrides.tcpUseDiscovery,
					tcpserialnumber: overrides.tcpSerialNumber
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
