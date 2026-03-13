/**
 * VS Code commands for switching transport modes and managing connections.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readSchedulerConfig } from '../config/schedulerConfig';
import { OutputChannelLogger } from '../diagnostics/logger';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY, encodeEv3Packet } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from '../scheduler/orphanRecovery';
import { classifyBluetoothFailure } from '../transport/bluetoothFailure';
import { EV3_PNP_HINT, extractMacFromPnpId, hasLegoMacPrefix } from '../transport/bluetoothPortSelection';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';
import { listBluetoothCandidates, listSerialCandidates, listUsbHidCandidates, resolveWindowsBluetoothNameMap, type SerialCandidate } from '../transport/discovery';
import { canUseWindowsBluetoothApi } from '../transport/windowsBluetoothApi';
import { createProbeTransportForMode } from '../transport/transportFactory';
import { toErrorMessage } from './commandUtils';

/**
 * Dependency injection options for transport diagnostic commands.
 */
export interface TransportCommandOptions {
	/** Returns the output channel logger for transport diagnostics. */
	getLogger(): OutputChannelLogger;
	/** Returns the probe timeout in milliseconds from configuration. */
	resolveProbeTimeoutMs(): number;
	/** Optional: scans all discovery candidates (same pipeline as the panel's + tab). */
	scanDiscoveryCandidates?(): Promise<Array<{
		candidateId: string;
		displayName: string;
		transport: string;
		status?: string;
		detail?: string;
		known?: boolean;
	}>>;
}

/**
 * Disposable registrations returned by {@link registerTransportCommands}.
 */
export interface TransportCommandRegistrations {
	/** Enumerates USB HID candidates and logs a snapshot. */
	inspectTransports: vscode.Disposable;
	/** Probes USB/TCP transports with EV3 protocol handshake. */
	transportHealthReport: vscode.Disposable;
	/** Comprehensive BT detection diagnostics with COM port probing. */
	btDetectionDiagnostics: vscode.Disposable;
}

/**
 * Simple orphan recovery strategy that logs the recovery event.
 * Used by diagnostic probes that don't need full orphan handling.
 */
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

/** Checks if an error message indicates the transport is likely unavailable. */
function isTransportLikelyUnavailable(message: string): boolean {
	return /not found|requires setting|timeout|unknown error code 121|unknown error code 1256|access is denied|send aborted/i.test(
		message
	);
}

/**
 * Runs a two-phase probe on a USB or TCP transport:
 * Phase 1 sends a LIST_OPEN_HANDLES system command,
 * Phase 2 sends a capability direct command.
 *
 * @returns PASS if both succeed, SKIP if transport unavailable, FAIL on error.
 */
async function runTransportProbe(
	mode: 'usb' | 'tcp',
	logger: OutputChannelLogger,
	resolveProbeTimeoutMs: () => number
): Promise<{ mode: 'usb' | 'tcp'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> {
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
			return { mode, status: 'SKIP', message };
		}
		return { mode, status: 'FAIL', message };
	} finally {
		await probeClient?.close().catch(() => undefined);
		probeScheduler?.dispose();
	}
}

/** Result of probing a Bluetooth COM port with DTR on or off. */
interface BtProbeResult {
	dtr: boolean;
	ok: boolean;
	message: string;
	phase: string;
	code?: number;
}

/** Normalises a diagnostic text value, replacing empty/non-string with `'(none)'`. */
function normalizeDiagnosticText(value: unknown): string {
	if (typeof value !== 'string') {
		return '(none)';
	}
	const normalized = value.replace(/\s+/g, ' ').trim();
	return normalized.length > 0 ? normalized : '(none)';
}

/** Returns `true` if the value looks like a Windows COM port (e.g. `COM3`). */
function isComPath(value: string): boolean {
	return /^COM\d+$/i.test(value.trim());
}

/** Compares two COM paths numerically (e.g. COM3 < COM12). */
function compareComPath(left: string, right: string): number {
	const leftNum = Number.parseInt((/(\d+)$/.exec(left) ?? [])[1] ?? '9999', 10);
	const rightNum = Number.parseInt((/(\d+)$/.exec(right) ?? [])[1] ?? '9999', 10);
	return leftNum - rightNum;
}

/** Heuristic: checks if a serial candidate is likely an EV3 brick (LEGO MAC, PnP hint, manufacturer). */
function isLikelyEv3SerialCandidate(candidate: SerialCandidate): boolean {
	if (!isComPath(candidate.path)) {
		return false;
	}
	if (hasLegoMacPrefix(candidate.pnpId)) {
		return true;
	}
	const pnpId = candidate.pnpId ?? '';
	if (pnpId.length > 0 && new RegExp(EV3_PNP_HINT, 'i').test(pnpId)) {
		return true;
	}
	const manufacturer = candidate.manufacturer ?? '';
	if (/lego/i.test(manufacturer)) {
		return true;
	}
	const friendlyName = candidate.friendlyName ?? '';
	return /\bev3\b/i.test(friendlyName);
}

/**
 * Opens a Bluetooth SPP adapter on a COM port and sends an EV3 direct command
 * probe to check if a brick is reachable.
 *
 * @param path - COM port path (e.g. `'COM3'`).
 * @param dtr - Whether to assert DTR on the serial port.
 * @param timeoutMs - Maximum time to wait for a probe reply.
 * @returns Probe result with ok/fail status, message, phase, and optional error code.
 */
async function probeBluetoothComPort(path: string, dtr: boolean, timeoutMs: number): Promise<BtProbeResult> {
	const probeMessageCounter = 0xffff;
	const probePacket = encodeEv3Packet(
		probeMessageCounter,
		EV3_COMMAND.DIRECT_COMMAND_REPLY,
		new Uint8Array([0x81, 0x12])
	);
	const adapter = new BluetoothSppAdapter({
		portPath: path,
		dtr
	});

	try {
		try {
			await adapter.open();
		} catch (error) {
			const rawMessage = `Opening ${path}: ${toErrorMessage(error)}`;
			const classification = classifyBluetoothFailure(rawMessage, 'open');
			return {
				dtr,
				ok: false,
				message: normalizeDiagnosticText(rawMessage),
				phase: classification.phase,
				code: classification.winErrorCode
			};
		}

		const abortController = new AbortController();
		const timer = setTimeout(() => abortController.abort(), Math.max(250, timeoutMs));
		timer.unref?.();
		try {
			await adapter.send(probePacket, {
				timeoutMs,
				signal: abortController.signal,
				expectedMessageCounter: probeMessageCounter
			});
			return {
				dtr,
				ok: true,
				message: 'Probe reply received.',
				phase: 'probe'
			};
		} catch (error) {
			const rawMessage = toErrorMessage(error);
			const classification = classifyBluetoothFailure(rawMessage, 'send');
			return {
				dtr,
				ok: false,
				message: normalizeDiagnosticText(rawMessage),
				phase: classification.phase,
				code: classification.winErrorCode
			};
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await adapter.close().catch(() => undefined);
	}
}

/**
 * Registers VS Code commands for transport inspection and diagnostics.
 *
 * @remarks
 * Commands registered:
 * | Command ID | Action |
 * |---|---|
 * | `ev3-cockpit.inspectTransports` | Enumerate USB HID candidates |
 * | `ev3-cockpit.transportHealthReport` | Probe USB/TCP with full EV3 handshake |
 * | `ev3-cockpit.btDetectionDiagnostics` | Comprehensive BT diagnostics with COM probing |
 *
 * The BT diagnostics command gathers serial candidates, live BT devices,
 * paired devices from the Windows registry, probes each COM port with
 * DTR true/false, cross-references with panel discovery, and writes a
 * report to disk.
 *
 * @param options - Dependency injection options.
 * @returns Disposable registrations for all three commands.
 *
 * @see {@link TransportCommandOptions}
 * @see {@link TransportCommandRegistrations}
 */
export function registerTransportCommands(options: TransportCommandOptions): TransportCommandRegistrations {
	// --- Command: inspectTransports — enumerate USB HID candidates ---
	const inspectTransports = vscode.commands.registerCommand('ev3-cockpit.inspectTransports', async () => {
		const logger = options.getLogger();
		const usbCandidates = await listUsbHidCandidates();

		logger.info('Transport discovery snapshot', { usbCandidates });
		vscode.window.showInformationMessage(
			`Transport discovery done: USB=${usbCandidates.length}. See output channel EVƎ Cockpit.`
		);
	});

	// --- Command: transportHealthReport — probe USB/TCP with EV3 protocol ---
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

		const usbCandidates = await listUsbHidCandidates();
		logger.info('Transport health report discovery snapshot', { usbCandidates });

		const probeModes: Array<'usb' | 'tcp'> =
			configuredMode === 'usb' || configuredMode === 'tcp'
				? [configuredMode]
				: ['usb', 'tcp'];

		const results: Array<{ mode: 'usb' | 'tcp'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> = [];
		for (const mode of probeModes) {
			const result = await runTransportProbe(mode, logger, options.resolveProbeTimeoutMs);
			results.push(result);
			logger.info('Transport health probe result', result);
		}

		const pass = results.filter((entry) => entry.status === 'PASS').length;
		const skip = results.filter((entry) => entry.status === 'SKIP').length;
		const fail = results.filter((entry) => entry.status === 'FAIL').length;
		vscode.window.showInformationMessage(
			`Transport health report: PASS=${pass}, SKIP=${skip}, FAIL=${fail}. See EVƎ Cockpit output for details.`
		);
	});

	// --- Command: btDetectionDiagnostics — comprehensive BT detection report ---
	const btDetectionDiagnostics = vscode.commands.registerCommand('ev3-cockpit.btDetectionDiagnostics', async () => {
		const logger = options.getLogger();
		const config = vscode.workspace.getConfiguration('ev3-cockpit');
		const transportMode = String(config.get('transport.mode') ?? 'auto');
		const preferredBtPort = normalizeDiagnosticText(config.get<string>('transport.bt.portPath') ?? '').replace(/^\(none\)$/, '(none)');
		const probeTimeoutMs = Math.max(400, Math.min(4_000, options.resolveProbeTimeoutMs()));

		const [serialCandidates, btCandidates, pairedNameMap, panelCandidates] = await Promise.all([
			listSerialCandidates(),
			listBluetoothCandidates(),
			resolveWindowsBluetoothNameMap(),
			options.scanDiscoveryCandidates?.() ?? Promise.resolve([])
		]);
		const winApiAvailable = canUseWindowsBluetoothApi();

		const comCandidates = serialCandidates
			.filter((candidate) => isComPath(candidate.path))
			.sort((left, right) => compareComPath(left.path, right.path));

		const liveByMac = new Map<string, { name?: string; comMapping: boolean }>();
		for (const candidate of btCandidates) {
			if (!candidate.mac) {
				continue;
			}
			const mac = candidate.mac.toLowerCase();
			const current = liveByMac.get(mac);
			if (!current) {
				liveByMac.set(mac, {
					name: candidate.displayName,
					comMapping: candidate.connectable === true && isComPath(candidate.path)
				});
				continue;
			}
			current.name = current.name || candidate.displayName;
			current.comMapping = current.comMapping || (candidate.connectable === true && isComPath(candidate.path));
		}

		const comMappingByMac = new Map<string, boolean>();
		for (const candidate of comCandidates) {
			const mac = extractMacFromPnpId(candidate.pnpId);
			if (!mac) {
				continue;
			}
			comMappingByMac.set(mac, true);
		}

		const lines: string[] = [];
		lines.push('EVƎ Cockpit BT Detection Diagnostics');
		lines.push(`Timestamp: ${new Date().toISOString()}`);
		lines.push(`transport.mode: ${transportMode}`);
		lines.push(`preferred BT port: ${preferredBtPort === '(none)' ? '(none)' : preferredBtPort}`);
		lines.push(`winapi.available: ${winApiAvailable ? 'yes' : 'no'}`);
		lines.push('');
		lines.push('Live Bluetooth devices (discovery pipeline):');
		if (liveByMac.size === 0) {
			lines.push('  (none)');
		} else {
			for (const [mac, live] of [...liveByMac.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
				lines.push(
					`  ${mac.toUpperCase()} | name=${normalizeDiagnosticText(live.name)} | comMapping=${live.comMapping ? 'yes' : 'no'}`
				);
			}
		}

		lines.push('');
		lines.push('Paired Bluetooth devices (registry):');
		if (pairedNameMap.size === 0) {
			lines.push('  (none)');
		} else {
			for (const [mac, name] of [...pairedNameMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
				const live = liveByMac.has(mac);
				const comMapping = comMappingByMac.has(mac) || liveByMac.get(mac)?.comMapping === true;
				lines.push(
					`  ${mac.toUpperCase()} | name=${normalizeDiagnosticText(name)} | live=${live ? 'yes' : 'no'} | comMapping=${comMapping ? 'yes' : 'no'}`
				);
			}
		}

		lines.push('');
		if (comCandidates.length === 0) {
			lines.push('No COM serial candidates found.');
		} else {
			for (const candidate of comCandidates) {
				const path = candidate.path.trim().toUpperCase();
				const likelyEv3 = isLikelyEv3SerialCandidate(candidate);
				const probeFalse = await probeBluetoothComPort(path, false, probeTimeoutMs);
				const probeTrue = await probeBluetoothComPort(path, true, probeTimeoutMs);
				const present = probeFalse.ok || probeTrue.ok;

				lines.push(`${path} | likelyEv3=${likelyEv3 ? 'yes' : 'no'} | present=${present ? 'yes' : 'no'}`);
				lines.push(`  manufacturer: ${normalizeDiagnosticText(candidate.manufacturer)}`);
				lines.push(`  friendlyName: ${normalizeDiagnosticText(candidate.friendlyName)}`);
				lines.push(`  pnpId: ${normalizeDiagnosticText(candidate.pnpId)}`);
				for (const probe of [probeFalse, probeTrue]) {
					const suffix = probe.code !== undefined ? `, code=${probe.code}` : '';
					lines.push(
						`  dtr=${probe.dtr ? 'true' : 'false'} -> ${probe.ok ? 'PASS' : 'FAIL'} | ${probe.message} | phase=${probe.phase}${suffix}`
					);
				}
				lines.push('');
			}
		}

		lines.push('Panel discovery candidates (same pipeline as + tab):');
		const panelBtCandidates = panelCandidates.filter((candidate) => candidate.transport === 'bt');
		if (panelBtCandidates.length === 0) {
			lines.push('  (none)');
		} else {
			for (const candidate of panelBtCandidates) {
				lines.push(
					`  ${candidate.candidateId} | status=${candidate.status ?? 'UNKNOWN'} | detail=${normalizeDiagnosticText(candidate.detail)}`
				);
			}
		}

		const reportText = lines.join('\n').trimEnd();
		logger.info('BT detection diagnostics report generated.', {
			transportMode,
			comCandidates: comCandidates.length,
			liveDevices: liveByMac.size,
			pairedDevices: pairedNameMap.size,
			panelBtCandidates: panelBtCandidates.length
		});
		logger.info(reportText);

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const reportDirectory = path.join(workspaceRoot, 'artifacts', 'diagnostics');
		const reportPath = path.join(reportDirectory, 'bt-detection-diagnostics.txt');
		try {
			await fs.mkdir(reportDirectory, { recursive: true });
			await fs.writeFile(reportPath, reportText, 'utf8');
		} catch (error) {
			logger.warn('Failed to write BT diagnostics report to disk.', {
				reportPath,
				error: toErrorMessage(error)
			});
		}

		const document = await vscode.workspace.openTextDocument({
			language: 'text',
			content: reportText
		});
		await vscode.window.showTextDocument(document, { preview: false });
		vscode.window.showInformationMessage(`BT diagnostics ready. Report: ${reportPath}`);
	});

	return { inspectTransports, transportHealthReport, btDetectionDiagnostics };
}
