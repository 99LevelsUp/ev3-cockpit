import * as vscode from 'vscode';
import { OutputChannelLogger } from '../diagnostics/logger';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { MockTransportAdapter } from './mockTransportAdapter';
import { TransportAdapter, TransportRequestOptions } from './transportAdapter';
import { TcpAdapter } from './tcpAdapter';
import { BluetoothSppAdapter } from './bluetoothSppAdapter';
import { buildBluetoothPortSelectionPlans, BluetoothPortSelectionPlan } from './bluetoothPortSelection';
import { UsbHidAdapter } from './usbHidAdapter';
import { listSerialCandidates, listUsbHidCandidates } from './discovery';

export type TransportMode = 'auto' | 'usb' | 'bluetooth' | 'tcp' | 'mock';

interface CandidateFactory {
	name: string;
	create: () => TransportAdapter;
}

const DEFAULT_BT_AUTO_PORT_ATTEMPTS = 3;
const DEFAULT_BT_AUTO_RETRY_DELAY_MS = 300;
const DEFAULT_BT_AUTO_POST_OPEN_DELAY_MS = 120;
const DEFAULT_BT_AUTO_PROBE_TIMEOUT_MS = 5_000;

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class AutoTransportAdapter implements TransportAdapter {
	private active?: { name: string; adapter: TransportAdapter };

	public constructor(
		private readonly logger: OutputChannelLogger,
		private readonly factories: CandidateFactory[]
	) {}

	public async open(): Promise<void> {
		if (this.active) {
			return;
		}

		const failures: string[] = [];
		for (const candidate of this.factories) {
			const adapter = candidate.create();
			try {
				await adapter.open();
				this.active = { name: candidate.name, adapter };
				this.logger.info('Auto transport selected candidate', {
					transport: candidate.name
				});
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${candidate.name}: ${message}`);
				await adapter.close().catch(() => undefined);
			}
		}

		throw new Error(`Auto transport failed. ${failures.join(' | ')}`);
	}

	public async close(): Promise<void> {
		if (!this.active) {
			return;
		}

		const active = this.active;
		this.active = undefined;
		await active.adapter.close();
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		if (!this.active) {
			throw new Error('Auto transport is not open.');
		}

		return this.active.adapter.send(packet, options);
	}
}

class BluetoothAutoPortAdapter implements TransportAdapter {
	private active?: BluetoothSppAdapter;

	public constructor(
		private readonly logger: OutputChannelLogger,
		private readonly preferredPort: string | undefined,
		private readonly baudRate: number,
		private readonly dtr: boolean,
		private readonly probeTimeoutMs: number,
		private readonly portAttempts: number,
		private readonly retryDelayMs: number,
		private readonly postOpenDelayMs: number
	) {}

	public async open(): Promise<void> {
		if (this.active) {
			return;
		}

		const candidatePlans = await this.resolveCandidatePlans();
		if (candidatePlans.length === 0) {
			throw new Error('Bluetooth transport could not resolve any serial COM candidates.');
		}

		const failures: string[] = [];
		const attemptedPorts = new Set<string>();
		for (const plan of candidatePlans) {
			this.logger.info('Bluetooth auto-port trying selection strategy', {
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
						dtr: this.dtr
					});

					try {
						await adapter.open();
						await sleep(this.postOpenDelayMs);
						await this.verifyEv3Probe(adapter);
						this.active = adapter;
						this.logger.info('Bluetooth auto-port selected candidate', {
							port,
							strategy: plan.name,
							attempt
						});
						return;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.logger.info('Bluetooth auto-port candidate attempt failed', {
							strategy: plan.name,
							port,
							attempt,
							message
						});
						failures.push(`${plan.name}/${port}#${attempt}: ${message}`);
						await adapter.close().catch(() => undefined);
						const transient = this.isLikelyTransientBluetoothFailure(message, plan.name);
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

		throw new Error(`Bluetooth auto-port failed. ${failures.join(' | ')}`);
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

	private isLikelyTransientBluetoothFailure(
		message: string,
		strategy: BluetoothPortSelectionPlan['name']
	): boolean {
		return (
			/unknown error code 121/i.test(message) ||
			/unknown error code 1256/i.test(message) ||
			/access is denied/i.test(message) ||
			/the semaphore timeout period has expired/i.test(message) ||
			(strategy === 'ev3-priority' && /send aborted/i.test(message))
		);
	}
}

function sanitizeNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return fallback;
	}

	return Math.max(min, Math.floor(value));
}

function sanitizeTransportMode(value: unknown): TransportMode {
	if (value === 'auto' || value === 'usb' || value === 'bluetooth' || value === 'tcp' || value === 'mock') {
		return value;
	}

	return 'auto';
}

function createMockProbeTransport(logger: OutputChannelLogger): MockTransportAdapter {
	return new MockTransportAdapter(async (packet, options) => {
		const request = decodeEv3Packet(packet);
		logger.trace('Mock transport received packet', {
			messageCounter: request.messageCounter,
			type: request.type,
			payloadBytes: request.payload.length,
			timeoutMs: options.timeoutMs
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		const replyType =
			request.type === EV3_COMMAND.SYSTEM_COMMAND_REPLY || request.type === EV3_COMMAND.SYSTEM_COMMAND_NO_REPLY
				? EV3_REPLY.SYSTEM_REPLY
				: EV3_REPLY.DIRECT_REPLY;
		const replyPayload =
			replyType === EV3_REPLY.SYSTEM_REPLY
				? new Uint8Array([request.payload[0] ?? 0x00, 0x00])
				: new Uint8Array([0x00]);

		return encodeEv3Packet(request.messageCounter, replyType, replyPayload);
	});
}

function createUsbTransport(cfg: vscode.WorkspaceConfiguration): UsbHidAdapter {
	const rawPath = cfg.get('transport.usb.path');
	const path = typeof rawPath === 'string' && rawPath.trim().length > 0 ? rawPath.trim() : undefined;
	const vendorId = sanitizeNumber(cfg.get('transport.usb.vendorId'), 0x0694, 0);
	const productId = sanitizeNumber(cfg.get('transport.usb.productId'), 0x0005, 0);
	const reportId = sanitizeNumber(cfg.get('transport.usb.reportId'), 0, 0);
	const reportSize = sanitizeNumber(cfg.get('transport.usb.reportSize'), 1025, 2);

	return new UsbHidAdapter({
		path,
		vendorId,
		productId,
		reportId,
		reportSize
	});
}

function createBluetoothTransport(
	cfg: vscode.WorkspaceConfiguration,
	logger: OutputChannelLogger
): TransportAdapter {
	const rawPort = cfg.get('transport.bluetooth.port');
	const port = typeof rawPort === 'string' ? rawPort.trim() : '';
	const baudRate = sanitizeNumber(cfg.get('transport.bluetooth.baudRate'), 115_200, 300);
	const dtr = cfg.get('transport.bluetooth.dtr') === true;
	const probeTimeoutMs = sanitizeNumber(
		cfg.get('transport.bluetooth.portProbeTimeoutMs'),
		DEFAULT_BT_AUTO_PROBE_TIMEOUT_MS,
		100
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
	const autoPortFallback = cfg.get('transport.bluetooth.autoPortFallback') !== false;
	if (autoPortFallback) {
		return new BluetoothAutoPortAdapter(
			logger,
			port || undefined,
			baudRate,
			dtr,
			probeTimeoutMs,
			portAttempts,
			retryDelayMs,
			postOpenDelayMs
		);
	}

	if (!port) {
		throw new Error('Bluetooth transport requires setting ev3-cockpit.transport.bluetooth.port.');
	}

	return new BluetoothSppAdapter({ port, baudRate, dtr });
}

function createTcpTransport(cfg: vscode.WorkspaceConfiguration, timeoutMs: number): TcpAdapter {
	const rawHost = cfg.get('transport.tcp.host');
	const host = typeof rawHost === 'string' ? rawHost.trim() : '';
	const useDiscovery = cfg.get('transport.tcp.useDiscovery') === true;
	if (!host) {
		if (!useDiscovery) {
			throw new Error('TCP transport requires setting ev3-cockpit.transport.tcp.host or enabling discovery.');
		}
	}

	const port = sanitizeNumber(cfg.get('transport.tcp.port'), 5555, 1);
	const discoveryPort = sanitizeNumber(cfg.get('transport.tcp.discoveryPort'), 3015, 1);
	const discoveryTimeoutMs = sanitizeNumber(cfg.get('transport.tcp.discoveryTimeoutMs'), 7000, 100);
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
	cfg: vscode.WorkspaceConfiguration,
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

	if (mode === 'bluetooth') {
		logger.info('Using Bluetooth transport for connect probe (ev3-cockpit.transport.mode=bluetooth).');
		return createBluetoothTransport(cfg, logger);
	}

	if (mode === 'tcp') {
		logger.info('Using TCP transport for connect probe (ev3-cockpit.transport.mode=tcp).');
		return createTcpTransport(cfg, timeoutMs);
	}

	// auto mode: prefer USB, then Bluetooth, then TCP (if host configured), fallback mock.
	logger.info('Using auto transport selection for connect probe (USB -> Bluetooth -> TCP -> mock).');
	return new AutoTransportAdapter(logger, [
		{
			name: 'usb',
			create: () => createUsbTransport(cfg)
		},
		{
			name: 'bluetooth',
			create: () => createBluetoothTransport(cfg, logger)
		},
		{
			name: 'tcp',
			create: () => createTcpTransport(cfg, timeoutMs)
		},
		{
			name: 'mock',
			create: () => createMockProbeTransport(logger)
		}
	]);
}

export function createProbeTransportFromWorkspace(logger: OutputChannelLogger, timeoutMs: number): TransportAdapter {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	return createProbeTransportForMode(cfg, logger, timeoutMs, cfg.get('transport.mode'));
}
