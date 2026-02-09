import * as vscode from 'vscode';
import { readSchedulerConfig } from '../config/schedulerConfig';
import { OutputChannelLogger } from '../diagnostics/logger';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from '../scheduler/orphanRecovery';
import { listSerialCandidates, listUsbHidCandidates } from '../transport/discovery';
import { createProbeTransportForMode } from '../transport/transportFactory';
import { toErrorMessage } from './commandUtils';

interface TransportCommandOptions {
	getLogger(): OutputChannelLogger;
	resolveProbeTimeoutMs(): number;
}

interface TransportCommandRegistrations {
	inspectTransports: vscode.Disposable;
	transportHealthReport: vscode.Disposable;
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
	mode: 'usb' | 'tcp' | 'bluetooth',
	logger: OutputChannelLogger,
	resolveProbeTimeoutMs: () => number
): Promise<{ mode: 'usb' | 'tcp' | 'bluetooth'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> {
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
		if (isTransportLikelyUnavailable(message)) {
			return {
				mode,
				status: 'SKIP',
				message
			};
		}
		return {
			mode,
			status: 'FAIL',
			message
		};
	} finally {
		await probeClient?.close().catch(() => undefined);
		probeScheduler?.dispose();
	}
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

		const probeModes: Array<'usb' | 'tcp' | 'bluetooth'> =
			configuredMode === 'usb' || configuredMode === 'tcp' || configuredMode === 'bluetooth'
				? [configuredMode]
				: ['usb', 'tcp', 'bluetooth'];

		const results: Array<{ mode: 'usb' | 'tcp' | 'bluetooth'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> = [];
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

	return { inspectTransports, transportHealthReport };
}
