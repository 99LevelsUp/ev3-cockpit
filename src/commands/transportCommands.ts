import * as vscode from 'vscode';
import { readSchedulerConfig } from '../config/schedulerConfig';
import { OutputChannelLogger } from '../diagnostics/logger';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from '../scheduler/orphanRecovery';
import { isLikelyEv3SerialCandidate } from '../device/brickDiscoveryService';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';
import { listSerialCandidates, listUsbHidCandidates } from '../transport/discovery';
import { classifyBluetoothFailure } from '../transport/bluetoothFailure';
import { createProbeTransportForMode } from '../transport/transportFactory';
import { toErrorMessage } from './commandUtils';

export interface TransportCommandOptions {
	getLogger(): OutputChannelLogger;
	resolveProbeTimeoutMs(): number;
}

export interface TransportCommandRegistrations {
	inspectTransports: vscode.Disposable;
	transportHealthReport: vscode.Disposable;
	btDetectionDiagnostics: vscode.Disposable;
}

class LoggingOrphanRecoveryStrategy implements OrphanRecoveryStrategy {
	public constructor(private readonly log: (message: string, meta?: Record<string, unknown>) => void) {}

	public async recover(context: OrphanRecoveryContext): Promise<void> {
		this.log('Running orphan-risk recovery', {
			requestId: context.requestId,
			lane: context.lane,
			reason: context.reason
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

function isTransportLikelyUnavailable(message: string): boolean {
	return /not found|requires setting|timeout|unknown error code 121|unknown error code 1256|access is denied|send aborted/i.test(
		message
	);
}

async function runTransportProbe(
	mode: 'usb' | 'tcp' | 'bt',
	logger: OutputChannelLogger,
	resolveProbeTimeoutMs: () => number
): Promise<{ mode: 'usb' | 'tcp' | 'bt'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	const timeoutMs = resolveProbeTimeoutMs();
	let probeScheduler: CommandScheduler | undefined;
	let probeClient: Ev3CommandClient | undefined;

	try {
		probeScheduler = new CommandScheduler({
			defaultTimeoutMs: timeoutMs,
			logger,
			defaultRetryPolicy: readSchedulerConfig().defaultRetryPolicy,
			orphanRecoveryStrategy: new LoggingOrphanRecoveryStrategy((msg, meta) => logger.info(msg, meta))
		});
		probeClient = new Ev3CommandClient({
			scheduler: probeScheduler,
			transport: createProbeTransportForMode(cfg, logger, timeoutMs, mode),
			logger
		});

		await probeClient.open();
		const probeResult = await probeClient.send({
			id: `transport-health-${mode}-probe`,
			lane: 'high',
			idempotent: true,
			timeoutMs,
			type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
			payload: new Uint8Array([0x9d])
		});
		if (probeResult.reply.type !== EV3_REPLY.SYSTEM_REPLY && probeResult.reply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
			throw new Error(`Unexpected probe reply type 0x${probeResult.reply.type.toString(16)}.`);
		}
		if (probeResult.reply.type === EV3_REPLY.SYSTEM_REPLY_ERROR) {
			throw new Error('Probe returned SYSTEM_REPLY_ERROR.');
		}

		const capabilityResult = await probeClient.send({
			id: `transport-health-${mode}-capability`,
			lane: 'high',
			idempotent: true,
			timeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload: buildCapabilityProbeDirectPayload()
		});
		if (capabilityResult.reply.type !== EV3_REPLY.DIRECT_REPLY) {
			throw new Error(`Unexpected capability reply type 0x${capabilityResult.reply.type.toString(16)}.`);
		}
		const capability = parseCapabilityProbeReply(capabilityResult.reply.payload);
		return {
			mode,
			status: 'PASS',
			message: `probe+capability ok (fw=${capability.fwVersion || '?'}, build=${capability.fwBuild || '?'})`
		};
	} catch (error) {
		const message = toErrorMessage(error);
		const diagnosticMessage = (() => {
			if (mode !== 'bt') {
				return message;
			}
			const classification = classifyBluetoothFailure(message);
			return `${message} [phase=${classification.phase}${
				classification.windowsCode !== undefined ? `, code=${classification.windowsCode}` : ''
			}]`;
		})();
		if (isTransportLikelyUnavailable(message)) {
			return {
				mode,
				status: 'SKIP',
				message: diagnosticMessage
			};
		}
		return {
			mode,
			status: 'FAIL',
			message: diagnosticMessage
		};
	} finally {
		await probeClient?.close().catch(() => undefined);
		probeScheduler?.dispose();
	}
}

async function runBtPortDiagnosticProbe(
	port: string,
	timeoutMs: number
): Promise<{
	present: boolean;
	attempts: Array<{ dtr: boolean; ok: boolean; message: string }>;
}> {
	const attempts: Array<{ dtr: boolean; ok: boolean; message: string }> = [];
	for (const dtr of [false, true]) {
		const adapter = new BluetoothSppAdapter({
			port,
			baudRate: 115_200,
			dtr
		});
		try {
			await adapter.open();
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(new Error('bt-diagnostic-probe-timeout')), timeoutMs);
			try {
				const packet = encodeEv3Packet(0, EV3_COMMAND.SYSTEM_COMMAND_REPLY, new Uint8Array([0x9d]));
				const replyBytes = await adapter.send(packet, {
					timeoutMs,
					signal: controller.signal,
					expectedMessageCounter: 0
				});
				const reply = decodeEv3Packet(replyBytes);
				if (reply.type !== EV3_REPLY.SYSTEM_REPLY && reply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
					attempts.push({
						dtr,
						ok: false,
						message: `Unexpected reply type 0x${reply.type.toString(16)}.`
					});
					continue;
				}
				if (reply.payload.length < 2) {
					attempts.push({
						dtr,
						ok: false,
						message: 'Probe reply payload too short.'
					});
					continue;
				}
				const status = reply.payload[1];
				if (reply.payload[0] === 0x9d && status === 0x00) {
					attempts.push({
						dtr,
						ok: true,
						message: 'Probe OK.'
					});
					return { present: true, attempts };
				}
				attempts.push({
					dtr,
					ok: false,
					message: `Probe status 0x${status.toString(16)}.`
				});
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			attempts.push({
				dtr,
				ok: false,
				message: toErrorMessage(error)
			});
		} finally {
			await adapter.close().catch(() => undefined);
		}
	}
	return { present: false, attempts };
}

function formatBtDiagnosticsReport(params: {
	configuredMode: unknown;
	preferredPort?: string;
	entries: Array<{
		path: string;
		likelyEv3: boolean;
		manufacturer?: string;
		pnpId?: string;
		friendlyName?: string;
		present: boolean;
		attempts: Array<{ dtr: boolean; ok: boolean; message: string }>;
	}>;
}): string {
	const lines: string[] = [];
	lines.push('EV3 Cockpit BT Detection Diagnostics');
	lines.push(`Timestamp: ${new Date().toISOString()}`);
	lines.push(`transport.mode: ${String(params.configuredMode ?? 'undefined')}`);
	lines.push(`preferred BT port: ${params.preferredPort ?? '(none)'}`);
	lines.push('');

	if (params.entries.length === 0) {
		lines.push('No COM serial candidates found.');
		return lines.join('\n');
	}

	for (const entry of params.entries) {
		lines.push(`${entry.path} | likelyEv3=${entry.likelyEv3 ? 'yes' : 'no'} | present=${entry.present ? 'yes' : 'no'}`);
		if (entry.manufacturer) {
			lines.push(`  manufacturer: ${entry.manufacturer}`);
		}
		if (entry.friendlyName) {
			lines.push(`  friendlyName: ${entry.friendlyName}`);
		}
		if (entry.pnpId) {
			lines.push(`  pnpId: ${entry.pnpId}`);
		}
		for (const attempt of entry.attempts) {
			const classification = classifyBluetoothFailure(attempt.message);
			lines.push(
				`  dtr=${attempt.dtr ? 'true' : 'false'} -> ${attempt.ok ? 'OK' : 'FAIL'} | ${attempt.message}`
				+ ` | phase=${classification.phase}`
				+ (classification.windowsCode !== undefined ? `, code=${classification.windowsCode}` : '')
			);
		}
		lines.push('');
	}
	return lines.join('\n');
}

export function registerTransportCommands(options: TransportCommandOptions): TransportCommandRegistrations {
	const inspectTransports = vscode.commands.registerCommand('ev3-cockpit.inspectTransports', async () => {
		const logger = options.getLogger();
		const [usbCandidates, serialCandidates] = await Promise.all([
			listUsbHidCandidates(),
			listSerialCandidates()
		]);

		logger.info('Transport discovery snapshot', {
			usbCandidates,
			serialCandidates
		});

		vscode.window.showInformationMessage(
			`Transport discovery done: USB=${usbCandidates.length}, Serial=${serialCandidates.length}. See output channel EV3 Cockpit.`
		);
	});

	const transportHealthReport = vscode.commands.registerCommand('ev3-cockpit.transportHealthReport', async () => {
		const logger = options.getLogger();
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const configuredMode = cfg.get('transport.mode');

		if (configuredMode === 'mock') {
			logger.info('Transport health report skipped: transport.mode is mock.');
			vscode.window.showInformationMessage(
				'Transport health report: skipped (transport.mode=mock). Set a real transport mode to run probes.'
			);
			return;
		}

		const [usbCandidates, serialCandidates] = await Promise.all([
			listUsbHidCandidates(),
			listSerialCandidates()
		]);

		logger.info('Transport health report discovery snapshot', {
			usbCandidates,
			serialCandidates
		});

		const probeModes: Array<'usb' | 'tcp' | 'bt'> =
			configuredMode === 'usb' || configuredMode === 'tcp' || configuredMode === 'bt'
				? [configuredMode]
				: ['usb', 'tcp', 'bt'];

		const results: Array<{ mode: 'usb' | 'tcp' | 'bt'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> = [];
		for (const mode of probeModes) {
			const result = await runTransportProbe(mode, logger, options.resolveProbeTimeoutMs);
			results.push(result);
			logger.info('Transport health probe result', result);
		}

		const pass = results.filter((entry) => entry.status === 'PASS').length;
		const skip = results.filter((entry) => entry.status === 'SKIP').length;
		const fail = results.filter((entry) => entry.status === 'FAIL').length;
		vscode.window.showInformationMessage(
			`Transport health report: PASS=${pass}, SKIP=${skip}, FAIL=${fail}. See EV3 Cockpit output for details.`
		);
	});

	const btDetectionDiagnostics = vscode.commands.registerCommand('ev3-cockpit.btDetectionDiagnostics', async () => {
		const logger = options.getLogger();
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const configuredMode = cfg.get('transport.mode');
		const preferredPortRaw = cfg.get('transport.bluetooth.port');
		const preferredPort = typeof preferredPortRaw === 'string' && preferredPortRaw.trim().length > 0
			? preferredPortRaw.trim().toUpperCase()
			: undefined;
		const timeoutMs = Math.max(1_500, options.resolveProbeTimeoutMs());

		const serialCandidates = await listSerialCandidates();
		const comCandidates = serialCandidates
			.filter((candidate) => /^COM\d+$/i.test(candidate.path.trim()))
			.map((candidate) => ({
				path: candidate.path.trim().toUpperCase(),
				manufacturer: candidate.manufacturer?.trim(),
				pnpId: candidate.pnpId,
				friendlyName: candidate.friendlyName?.trim(),
				likelyEv3: isLikelyEv3SerialCandidate(candidate, preferredPort)
			}));

		const entries: Array<{
			path: string;
			likelyEv3: boolean;
			manufacturer?: string;
			pnpId?: string;
			friendlyName?: string;
			present: boolean;
			attempts: Array<{ dtr: boolean; ok: boolean; message: string }>;
		}> = [];

		for (const candidate of comCandidates) {
			const probe = await runBtPortDiagnosticProbe(candidate.path, timeoutMs);
			entries.push({
				...candidate,
				present: probe.present,
				attempts: probe.attempts
			});
		}

		const report = formatBtDiagnosticsReport({
			configuredMode,
			preferredPort,
			entries
		});
		logger.info('BT detection diagnostics report', {
			configuredMode,
			preferredPort,
			entries
		});

		const doc = await vscode.workspace.openTextDocument({
			content: report,
			language: 'plaintext'
		});
		await vscode.window.showTextDocument(doc, { preview: false });
		vscode.window.showInformationMessage(
			`BT diagnostics done: COM candidates=${entries.length}. Report opened in editor and logged to EV3 Cockpit output.`
		);
	});

	return { inspectTransports, transportHealthReport, btDetectionDiagnostics };
}
