import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { buildCapabilityProfile } from '../compat/capabilityProfile';
import { BrickControlService } from '../device/brickControlService';
import { RemoteFsService } from '../fs/remoteFsService';
import { EMPTY_RBF_BYTES, EMPTY_RBF_META } from './fixtures/emptyProgram';
import { canonicalizeEv3Path } from '../fs/pathPolicy';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';
import { listSerialCandidates, listUsbHidCandidates } from '../transport/discovery';
import { TcpAdapter } from '../transport/tcpAdapter';
import { TransportAdapter } from '../transport/transportAdapter';
import { UsbHidAdapter } from '../transport/usbHidAdapter';

type TransportKind = 'usb' | 'tcp' | 'bluetooth';
type HardwareStatus = 'PASS' | 'SKIP' | 'FAIL';
const TRANSPORT_ORDER: TransportKind[] = ['usb', 'tcp', 'bluetooth'];

export interface HardwareSummary {
	pass: number;
	skip: number;
	fail: number;
}

export interface HardwareCaseResult {
	transport: TransportKind;
	status: HardwareStatus;
	reason: string;
	detail?: Record<string, unknown>;
}

export interface HardwareSmokeReport {
	generatedAtIso: string;
	selectedTransports: TransportKind[];
	emergencyStopCheckEnabled: boolean;
	reconnectCheckEnabled: boolean;
	reconnectGlitchCheckEnabled: boolean;
	reconnectDriverDropCheckEnabled: boolean;
	bluetoothStrictModeEnabled: boolean;
	warning?: string;
	results: HardwareCaseResult[];
	summary: HardwareSummary;
	exitCode: number;
}

interface ProbeSuccess {
	messageCounter: number;
	durationMs: number;
	capability: {
		osVersion: string;
		hwVersion: string;
		fwVersion: string;
		osBuild: string;
		fwBuild: string;
	};
}

interface RunProgramCheckResult {
	ok: boolean;
	path: string;
	mode: 'remote' | 'fixture-upload';
	localFixturePath?: string;
	fixtureSource?: string;
	fixtureBytes?: number;
	message?: string;
}

interface RunProgramSpec {
	mode: 'remote' | 'fixture-upload';
	remotePath: string;
	localFixturePath?: string;
	fixtureBytes?: Uint8Array;
	fixtureSource?: string;
}

interface RunProgramSpecResolution {
	spec?: RunProgramSpec;
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_BT_PROBE_TIMEOUT_MS = 12_000;
const DEFAULT_TCP_DISCOVERY_TIMEOUT_MS = 7_000;
const DEFAULT_TCP_ATTEMPTS = 2;
const DEFAULT_TCP_RETRY_DELAY_MS = 300;
const DEFAULT_USB_ATTEMPTS = 2;
const DEFAULT_USB_RETRY_DELAY_MS = 250;
const DEFAULT_BT_PORT_ATTEMPTS = 2;
const DEFAULT_BT_RETRY_DELAY_MS = 300;
const DEFAULT_BT_POST_OPEN_DELAY_MS = 120;
const DEFAULT_BT_AUTO_DTR_FALLBACK = true;
const DEFAULT_EMERGENCY_STOP_CHECK = true;
const DEFAULT_RECONNECT_CHECK = false;
const DEFAULT_RECONNECT_GLITCH_CHECK = true;
const DEFAULT_RECONNECT_DRIVER_DROP_CHECK = false;
const DEFAULT_BT_STRICT = false;
const DEFAULT_RECONNECT_DRIVER_DROP_WINDOW_MS = 20_000;
const DEFAULT_RECONNECT_DRIVER_DROP_POLL_MS = 500;
const SAFE_ROOTS = ['/home/root/lms2012/prjs/', '/media/card/'];
const DEFAULT_RUN_FIXTURE_REMOTE_PATH = '/home/root/lms2012/prjs/ev3-cockpit-hw-run-fixture.rbf';

const UNAVAILABLE_PATTERNS: Record<TransportKind, RegExp[]> = {
	usb: [
		/no ev3 usb hid device found/i,
		/requires package "node-hid"/i,
		/could not read from hid device/i,
		/could not write to hid device/i,
		/device has been disconnected/i,
		/transport is not open/i
	],
	tcp: [
		/requires non-empty host/i,
		/could not resolve host/i,
		/udp discovery timeout/i,
		/eaddrinuse/i,
		/econnrefused/i,
		/econnreset/i,
		/econnaborted/i,
		/socket hang up/i,
		/ehostunreach/i,
		/enetunreach/i,
		/tcp connect timeout/i,
		/transport is not open/i,
		/adapter is not open/i
	],
	bluetooth: [
		/requires package "serialport"/i,
		/could not resolve any serial com candidates/i,
		/non-empty serial port path/i,
		/file not found/i,
		/access is denied/i,
		/access denied/i,
		/unknown error code 121/i,
		/unknown error code 1256/i,
		/unknown error code 1167/i,
		/timed out/i,
		/operation aborted/i,
		/transport is not open/i
	]
};

function isLikelyStaleReplyValidationError(message: string): boolean {
	return (
		/unexpected .*reply type/i.test(message) ||
		/command mismatch/i.test(message) ||
		/payload is too short/i.test(message)
	);
}

function envNumber(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(min, parsed);
}

function envBoolean(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (raw === undefined || raw.length === 0) {
		return fallback;
	}
	if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
		return true;
	}
	if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
		return false;
	}
	return fallback;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function resolveOptionalRunProgramPath(rawValue: string | undefined): string | undefined {
	const raw = rawValue?.trim();
	if (!raw) {
		return undefined;
	}

	const fromUri = /^ev3:\/\/[^/]+(\/.*)$/i.exec(raw);
	const candidate = fromUri?.[1] ?? raw;
	try {
		return canonicalizeEv3Path(candidate);
	} catch {
		return undefined;
	}
}

function resolveExistingFixturePath(raw: string): string | undefined {
	const normalized = raw.trim();
	if (!normalized) {
		return undefined;
	}

	const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
	return fs.existsSync(absolute) ? absolute : undefined;
}

function resolveRemoteFixtureUploadPath(rawValue: string | undefined): string | undefined {
	const raw = rawValue?.trim() || DEFAULT_RUN_FIXTURE_REMOTE_PATH;
	const fromUri = /^ev3:\/\/[^/]+(\/.*)$/i.exec(raw);
	const candidate = fromUri?.[1] ?? raw;
	try {
		return canonicalizeEv3Path(candidate);
	} catch {
		return undefined;
	}
}

export function resolveRunProgramSpecFromEnv(env: NodeJS.ProcessEnv = process.env): RunProgramSpecResolution {
	const remoteRunPath = resolveOptionalRunProgramPath(env.EV3_COCKPIT_HW_RUN_RBF_PATH);
	if (env.EV3_COCKPIT_HW_RUN_RBF_PATH?.trim()) {
		if (!remoteRunPath) {
			return {
				error: `Invalid EV3_COCKPIT_HW_RUN_RBF_PATH value: "${env.EV3_COCKPIT_HW_RUN_RBF_PATH}".`
			};
		}
		return {
			spec: {
				mode: 'remote',
				remotePath: remoteRunPath
			}
		};
	}

	const fixtureRaw = env.EV3_COCKPIT_HW_RUN_RBF_FIXTURE?.trim();
	if (!fixtureRaw) {
		return {};
	}

	if (fixtureRaw.toLowerCase() === 'auto') {
		const remoteUploadPath = resolveRemoteFixtureUploadPath(env.EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH);
		if (!remoteUploadPath) {
			return {
				error: `Invalid EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH value: "${env.EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH ?? DEFAULT_RUN_FIXTURE_REMOTE_PATH}".`
			};
		}
		return {
			spec: {
				mode: 'fixture-upload',
				remotePath: remoteUploadPath,
				fixtureBytes: new Uint8Array(EMPTY_RBF_BYTES),
				fixtureSource: `embedded:${EMPTY_RBF_META.sourcePath}`
			}
		};
	}

	const fixturePath = resolveExistingFixturePath(fixtureRaw);
	if (!fixturePath) {
		return {
			error: `Could not resolve local fixture file from EV3_COCKPIT_HW_RUN_RBF_FIXTURE="${fixtureRaw}".`
		};
	}

	const remoteUploadPath = resolveRemoteFixtureUploadPath(env.EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH);
	if (!remoteUploadPath) {
		return {
			error: `Invalid EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH value: "${env.EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH ?? DEFAULT_RUN_FIXTURE_REMOTE_PATH}".`
		};
	}

	return {
		spec: {
			mode: 'fixture-upload',
			remotePath: remoteUploadPath,
			localFixturePath: fixturePath,
			fixtureSource: fixturePath
		}
	};
}

export function resolveEmergencyStopCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_EMERGENCY_STOP_CHECK?.trim();
	if (!raw) {
		return DEFAULT_EMERGENCY_STOP_CHECK;
	}

	const normalized = raw.toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return DEFAULT_EMERGENCY_STOP_CHECK;
}

export function resolveReconnectCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_RECONNECT_CHECK?.trim();
	if (!raw) {
		return DEFAULT_RECONNECT_CHECK;
	}

	const normalized = raw.toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return DEFAULT_RECONNECT_CHECK;
}

export function resolveReconnectGlitchCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK?.trim();
	if (!raw) {
		return DEFAULT_RECONNECT_GLITCH_CHECK;
	}

	const normalized = raw.toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return DEFAULT_RECONNECT_GLITCH_CHECK;
}

export function resolveReconnectDriverDropCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK?.trim();
	if (!raw) {
		return DEFAULT_RECONNECT_DRIVER_DROP_CHECK;
	}

	const normalized = raw.toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return DEFAULT_RECONNECT_DRIVER_DROP_CHECK;
}

export function resolveBluetoothStrictModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_BT_STRICT?.trim();
	if (!raw) {
		return DEFAULT_BT_STRICT;
	}

	const normalized = raw.toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return DEFAULT_BT_STRICT;
}

export function isLikelyUnavailableError(transport: TransportKind, error: unknown): boolean {
	const message = errorMessage(error);
	return UNAVAILABLE_PATTERNS[transport].some((pattern) => pattern.test(message));
}

export function resolveHardwareTransportsFromEnv(
	env: NodeJS.ProcessEnv = process.env
): { transports: TransportKind[]; warning?: string } {
	const raw = env.EV3_COCKPIT_HW_TRANSPORTS?.trim();
	if (!raw) {
		return {
			transports: [...TRANSPORT_ORDER]
		};
	}

	const seen = new Set<TransportKind>();
	const unknown: string[] = [];
	for (const token of raw.split(',')) {
		const normalized = token.trim().toLowerCase();
		if (!normalized) {
			continue;
		}
		if (normalized === 'usb' || normalized === 'tcp' || normalized === 'bluetooth') {
			seen.add(normalized);
			continue;
		}
		unknown.push(normalized);
	}

	const transports = TRANSPORT_ORDER.filter((kind) => seen.has(kind));
	if (transports.length === 0) {
		return {
			transports: [...TRANSPORT_ORDER],
			warning: `EV3_COCKPIT_HW_TRANSPORTS="${raw}" did not contain valid transports (usb,tcp,bluetooth). Falling back to all.`
		};
	}

	if (unknown.length > 0) {
		return {
			transports,
			warning: `Ignored unknown transports in EV3_COCKPIT_HW_TRANSPORTS: ${unknown.join(', ')}`
		};
	}

	return { transports };
}

function summarizeResults(results: HardwareCaseResult[]): HardwareSummary {
	return {
		pass: results.filter((entry) => entry.status === 'PASS').length,
		skip: results.filter((entry) => entry.status === 'SKIP').length,
		fail: results.filter((entry) => entry.status === 'FAIL').length
	};
}

export function resolveHardwareSmokeReportPath(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.EV3_COCKPIT_HW_REPORT?.trim();
	const relative = raw && raw.length > 0 ? raw : path.join('artifacts', 'hw', 'hardware-smoke.json');
	return path.isAbsolute(relative) ? relative : path.resolve(process.cwd(), relative);
}

export function buildHardwareSmokeReport(
	suite: Awaited<ReturnType<typeof runHardwareSuite>>,
	exitCode: number
): HardwareSmokeReport {
	return {
		generatedAtIso: new Date().toISOString(),
		selectedTransports: [...suite.selectedTransports],
		emergencyStopCheckEnabled: suite.emergencyStopCheckEnabled,
		reconnectCheckEnabled: suite.reconnectCheckEnabled,
		reconnectGlitchCheckEnabled: suite.reconnectGlitchCheckEnabled,
		reconnectDriverDropCheckEnabled: suite.reconnectDriverDropCheckEnabled,
		bluetoothStrictModeEnabled: suite.bluetoothStrictModeEnabled,
		warning: suite.warning,
		results: suite.results,
		summary: summarizeResults(suite.results),
		exitCode
	};
}

export async function writeHardwareSmokeReport(report: HardwareSmokeReport, reportPath: string): Promise<void> {
	await fsPromises.mkdir(path.dirname(reportPath), { recursive: true });
	await fsPromises.writeFile(reportPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
}

function formatResult(result: HardwareCaseResult): string {
	const prefix = `[HW][${result.transport.toUpperCase()}] ${result.status}`;
	if (!result.detail || Object.keys(result.detail).length === 0) {
		return `${prefix} ${result.reason}`;
	}
	return `${prefix} ${result.reason} ${JSON.stringify(result.detail)}`;
}

async function runProbeWithClient(client: Ev3CommandClient, timeoutMs: number): Promise<ProbeSuccess> {
	const probeCommand = 0x9d;
	let probeResult:
		| { messageCounter: number; durationMs: number; reply: { type: number; payload: Uint8Array } }
		| undefined;
	let probeValidationError = 'Probe did not return a valid reply.';
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const candidate = await client.send({
			id: `hw-connect-probe-${attempt}`,
			lane: 'high',
			idempotent: true,
			timeoutMs,
			type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
			payload: new Uint8Array([probeCommand])
		});
		const probeReply = candidate.reply;
		if (probeReply.type !== EV3_REPLY.SYSTEM_REPLY && probeReply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
			probeValidationError = `Unexpected probe reply type 0x${probeReply.type.toString(16)}.`;
		} else if (probeReply.payload.length < 2) {
			probeValidationError = 'Probe reply payload is too short.';
		} else {
			const echoedCommand = probeReply.payload[0];
			const status = probeReply.payload[1];
			if (echoedCommand !== probeCommand) {
				probeValidationError = `Probe reply command mismatch: expected 0x${probeCommand.toString(16)}, got 0x${echoedCommand.toString(16)}.`;
			} else if (probeReply.type === EV3_REPLY.SYSTEM_REPLY_ERROR || status !== 0x00) {
				probeValidationError = `Probe reply returned status 0x${status.toString(16)}.`;
			} else {
				probeResult = candidate;
				break;
			}
		}

		if (attempt < 2 && isLikelyStaleReplyValidationError(probeValidationError)) {
			await sleep(60);
			continue;
		}
	}

	if (!probeResult) {
		throw new Error(probeValidationError);
	}

	const capabilityResult = await client.send({
		id: 'hw-capability-probe',
		lane: 'high',
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload: buildCapabilityProbeDirectPayload()
	});
	const capabilityReply = capabilityResult.reply;
	if (capabilityReply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`Unexpected capability reply type 0x${capabilityReply.type.toString(16)}.`);
	}

	return {
		messageCounter: probeResult.messageCounter,
		durationMs: probeResult.durationMs,
		capability: parseCapabilityProbeReply(capabilityReply.payload)
	};
}

async function runProbe(adapter: TransportAdapter, timeoutMs: number): Promise<ProbeSuccess> {
	const scheduler = new CommandScheduler({
		defaultTimeoutMs: timeoutMs
	});
	const client = new Ev3CommandClient({
		scheduler,
		transport: adapter
	});

	try {
		await client.open();
		return await runProbeWithClient(client, timeoutMs);
	} finally {
		await client.close().catch(() => undefined);
		scheduler.dispose();
	}
}

async function runProgramCheckWithClient(
	client: Ev3CommandClient,
	timeoutMs: number,
	capability: ProbeSuccess['capability'],
	spec: RunProgramSpec
): Promise<RunProgramCheckResult> {
	try {
		const profile = buildCapabilityProfile(capability, 'auto');
		const service = new RemoteFsService({
			commandClient: client,
			capabilityProfile: profile,
			fsConfig: {
				mode: 'safe',
				defaultRoots: [...SAFE_ROOTS],
				fullModeConfirmationRequired: true
			},
			defaultTimeoutMs: Math.max(timeoutMs, profile.recommendedTimeoutMs)
		});

		if (spec.mode === 'fixture-upload') {
			const fixturePath = spec.localFixturePath;
			let fixtureBytes: Uint8Array;
			if (spec.fixtureBytes) {
				fixtureBytes = new Uint8Array(spec.fixtureBytes);
			} else {
				if (!fixturePath) {
					throw new Error('Fixture-upload run mode requires local fixture path or fixture bytes.');
				}
				fixtureBytes = new Uint8Array(await fsPromises.readFile(fixturePath));
			}
			if (fixtureBytes.length === 0) {
				throw new Error('Fixture-upload run mode resolved an empty fixture binary.');
			}
			// Best-effort cleanup from a previous interrupted run.
			await service.deleteFile(spec.remotePath).catch(() => undefined);
			await service.writeFile(spec.remotePath, fixtureBytes);
			let runError: unknown;
			try {
				await service.runBytecodeProgram(spec.remotePath);
			} catch (error) {
				runError = error;
			}

			let lastDeleteError: unknown;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await service.deleteFile(spec.remotePath);
					lastDeleteError = undefined;
					break;
				} catch (error) {
					lastDeleteError = error;
					if (attempt < 2) {
						await sleep(120);
					}
				}
			}

			if (runError) {
				throw runError;
			}
			if (lastDeleteError) {
				throw lastDeleteError;
			}
			return {
				ok: true,
				mode: spec.mode,
				path: spec.remotePath,
				localFixturePath: fixturePath,
				fixtureSource: spec.fixtureSource,
				fixtureBytes: fixtureBytes.length
			};
		}

		await service.runBytecodeProgram(spec.remotePath);
		return {
			ok: true,
			mode: spec.mode,
			path: spec.remotePath
		};
	} catch (error) {
		return {
			ok: false,
			mode: spec.mode,
			path: spec.remotePath,
			localFixturePath: spec.localFixturePath,
			fixtureSource: spec.fixtureSource,
			message: errorMessage(error)
		};
	}
}

async function runProgramCheck(
	createAdapter: () => TransportAdapter,
	timeoutMs: number,
	capability: ProbeSuccess['capability'],
	spec: RunProgramSpec
): Promise<RunProgramCheckResult> {
	const scheduler = new CommandScheduler({
		defaultTimeoutMs: timeoutMs
	});
	const client = new Ev3CommandClient({
		scheduler,
		transport: createAdapter()
	});

	try {
		await client.open();
		return await runProgramCheckWithClient(client, timeoutMs, capability, spec);
	} finally {
		await client.close().catch(() => undefined);
		scheduler.dispose();
	}
}

async function runEmergencyStopCheckWithClient(
	client: Ev3CommandClient,
	timeoutMs: number
): Promise<{ ok: boolean; message?: string }> {
	const controls = new BrickControlService({
		commandClient: client,
		defaultTimeoutMs: timeoutMs
	});

	let lastError: string | undefined;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			await controls.emergencyStopAll();
			return { ok: true };
		} catch (error) {
			lastError = errorMessage(error);
			if (attempt < 2 && isLikelyStaleReplyValidationError(lastError)) {
				await sleep(60);
				continue;
			}
			break;
		}
	}
	return {
		ok: false,
		message: lastError
	};
}

async function runEmergencyStopCheck(createAdapter: () => TransportAdapter, timeoutMs: number): Promise<{ ok: boolean; message?: string }> {
	const scheduler = new CommandScheduler({
		defaultTimeoutMs: timeoutMs
	});
	const client = new Ev3CommandClient({
		scheduler,
		transport: createAdapter()
	});

	try {
		await client.open();
		return await runEmergencyStopCheckWithClient(client, timeoutMs);
	} finally {
		await client.close().catch(() => undefined);
		scheduler.dispose();
	}
}

async function runReconnectRecoveryCheck(
	createAdapter: () => TransportAdapter,
	timeoutMs: number,
	simulateInFlightDrop: boolean
): Promise<{ ok: boolean; message?: string }> {
	const scheduler = new CommandScheduler({
		defaultTimeoutMs: timeoutMs
	});
	const adapter = createAdapter();
	const client = new Ev3CommandClient({
		scheduler,
		transport: adapter
	});

	try {
		await client.open();
		await runProbeWithClient(client, timeoutMs);
		await client.close();
		await client.open();
		await runProbeWithClient(client, timeoutMs);

		if (simulateInFlightDrop) {
			const pending = client.send({
				id: 'hw-reconnect-glitch-probe',
				lane: 'high',
				idempotent: true,
				timeoutMs: Math.max(timeoutMs, 1000),
				type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
				payload: new Uint8Array([0x9d])
			});

			await sleep(20);
			await client.close().catch(() => undefined);
			await pending.catch(() => undefined);
			await client.open();
			await runProbeWithClient(client, timeoutMs);
		}

		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			message: errorMessage(error)
		};
	} finally {
		await client.close().catch(() => undefined);
		scheduler.dispose();
	}
}

async function runDriverDropRecoveryCheck(
	transport: TransportKind,
	createAdapter: () => TransportAdapter,
	timeoutMs: number,
	windowMs: number,
	pollMs: number
): Promise<{ ok: boolean; skipped?: boolean; message?: string }> {
	const logPrefix = `[HW][${transport.toUpperCase()}][driver-drop]`;
	const startedAt = Date.now();
	const logStep = (message: string): void => {
		const elapsedMs = Date.now() - startedAt;
		const remainingMs = Math.max(0, windowMs - elapsedMs);
		console.log(`${logPrefix} +${elapsedMs}ms (remaining ${remainingMs}ms) ${message}`);
	};

	const scheduler = new CommandScheduler({
		defaultTimeoutMs: timeoutMs
	});
	const client = new Ev3CommandClient({
		scheduler,
		transport: createAdapter()
	});

	try {
		logStep(`Opening transport (timeout=${timeoutMs}ms).`);
		await client.open();
		logStep('Initial probe before driver-drop window.');
		await runProbeWithClient(client, timeoutMs);
		console.log(
			`[HW][${transport.toUpperCase()}] Driver-drop reconnect check active: disconnect and reconnect the transport within ${windowMs}ms.`
		);

		const deadlineAt = startedAt + windowMs;
		let dropObserved = false;
		let connectionOpen = true;
		let loopCounter = 0;
		let reconnectAttempts = 0;
		let reconnectFailures = 0;
		let probeFailures = 0;
		while (Date.now() < deadlineAt) {
			loopCounter += 1;
			await sleep(pollMs);

			if (!connectionOpen) {
				reconnectAttempts += 1;
				logStep(`Reconnect attempt #${reconnectAttempts}: opening transport.`);
				try {
					await client.open();
					connectionOpen = true;
					logStep(`Reconnect attempt #${reconnectAttempts} succeeded.`);
				} catch (error) {
					reconnectFailures += 1;
					const message = errorMessage(error);
					logStep(`Reconnect attempt #${reconnectAttempts} failed (${message}).`);
					if (isLikelyUnavailableError(transport, error)) {
						continue;
					}
					return {
						ok: false,
						message
					};
				}
			}

			try {
				logStep(`Probe tick #${loopCounter}.`);
				await runProbeWithClient(client, timeoutMs);
				logStep(`Probe tick #${loopCounter} succeeded.`);
				if (dropObserved) {
					logStep(
						`Recovery confirmed after drop (loops=${loopCounter}, reconnectAttempts=${reconnectAttempts}, reconnectFailures=${reconnectFailures}, probeFailures=${probeFailures}).`
					);
					return { ok: true };
				}
			} catch (error) {
				probeFailures += 1;
				const message = errorMessage(error);
				logStep(`Probe tick #${loopCounter} failed (${message}).`);
				if (!isLikelyUnavailableError(transport, error)) {
					return {
						ok: false,
						message
					};
				}

				if (!dropObserved) {
					dropObserved = true;
					logStep('Driver-level drop observed; entering reconnect phase.');
				}
				if (connectionOpen) {
					await client.close().catch(() => undefined);
					connectionOpen = false;
					logStep('Transport closed after detected drop; waiting before next reconnect attempt.');
				}
				await sleep(Math.min(Math.max(50, pollMs), 500));
			}
		}

		if (!dropObserved) {
			logStep(
				`Window expired without observed drop (loops=${loopCounter}, reconnectAttempts=${reconnectAttempts}, reconnectFailures=${reconnectFailures}, probeFailures=${probeFailures}).`
			);
			return {
				ok: false,
				skipped: true,
				message: `No driver-level disconnect observed within ${windowMs}ms window.`
			};
		}

		logStep(
			`Window expired after observed drop without full recovery (loops=${loopCounter}, reconnectAttempts=${reconnectAttempts}, reconnectFailures=${reconnectFailures}, probeFailures=${probeFailures}).`
		);
		return {
			ok: false,
			message: `Driver-level disconnect observed, but reconnect did not recover within ${windowMs}ms window.`
		};
	} catch (error) {
		return {
			ok: false,
			message: errorMessage(error)
		};
	} finally {
		await client.close().catch(() => undefined);
		scheduler.dispose();
	}
}

function mapPostProbeCheckFailure(
	transport: TransportKind,
	checkName: 'Program run check' | 'Emergency stop check' | 'Reconnect recovery check' | 'Reconnect driver-drop check',
	message: string
): HardwareCaseResult {
	if (isLikelyUnavailableError(transport, message)) {
		return {
			transport,
			status: 'SKIP',
			reason: `${transport.toUpperCase()} transport became unavailable during ${checkName.toLowerCase()} (${message}).`
		};
	}

	return {
		transport,
		status: 'FAIL',
		reason: `${checkName} failed (${message}).`
	};
}

async function runUsbCase(
	runSpecResolution: RunProgramSpecResolution,
	emergencyStopCheckEnabled: boolean,
	reconnectCheckEnabled: boolean,
	reconnectGlitchCheckEnabled: boolean,
	reconnectDriverDropCheckEnabled: boolean
): Promise<HardwareCaseResult> {
	const vendorId = envNumber('EV3_COCKPIT_HW_USB_VENDOR_ID', 0x0694, 0);
	const productId = envNumber('EV3_COCKPIT_HW_USB_PRODUCT_ID', 0x0005, 0);
	const timeoutMs = envNumber('EV3_COCKPIT_HW_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 50);
	const reconnectDriverDropWindowMs = envNumber(
		'EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_WINDOW_MS',
		DEFAULT_RECONNECT_DRIVER_DROP_WINDOW_MS,
		1000
	);
	const reconnectDriverDropPollMs = envNumber(
		'EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_POLL_MS',
		DEFAULT_RECONNECT_DRIVER_DROP_POLL_MS,
		50
	);
	const attempts = envNumber('EV3_COCKPIT_HW_USB_ATTEMPTS', DEFAULT_USB_ATTEMPTS, 1);
	const retryDelayMs = envNumber('EV3_COCKPIT_HW_USB_RETRY_DELAY_MS', DEFAULT_USB_RETRY_DELAY_MS, 0);
	const path = process.env.EV3_COCKPIT_HW_USB_PATH?.trim() || undefined;
	const candidates = await listUsbHidCandidates(vendorId, productId);
	const runSpec = runSpecResolution.spec;
	if (runSpecResolution.error) {
		return {
			transport: 'usb',
			status: 'FAIL',
			reason: runSpecResolution.error
		};
	}

	if (!path && candidates.length === 0) {
		return {
			transport: 'usb',
			status: 'SKIP',
			reason: 'USB transport unavailable (EV3 HID device not found).',
			detail: { vendorId, productId }
		};
	}

	const failures: string[] = [];
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const createAdapter = () =>
				new UsbHidAdapter({
					path,
					vendorId,
					productId
				});
			const probe = await runProbe(
				createAdapter(),
				timeoutMs
			);

		if (runSpec) {
			const runCheck = await runProgramCheck(createAdapter, timeoutMs, probe.capability, runSpec);
			if (!runCheck.ok) {
				return mapPostProbeCheckFailure('usb', 'Program run check', runCheck.message ?? 'unknown error');
			}
		}

		if (emergencyStopCheckEnabled) {
			const stopCheck = await runEmergencyStopCheck(createAdapter, timeoutMs);
			if (!stopCheck.ok) {
				return mapPostProbeCheckFailure('usb', 'Emergency stop check', stopCheck.message ?? 'unknown error');
			}
		}

		if (reconnectCheckEnabled) {
			const reconnectCheck = await runReconnectRecoveryCheck(
				createAdapter,
				timeoutMs,
				reconnectGlitchCheckEnabled
			);
			if (!reconnectCheck.ok) {
				return mapPostProbeCheckFailure('usb', 'Reconnect recovery check', reconnectCheck.message ?? 'unknown error');
			}
		}

		if (reconnectCheckEnabled && reconnectDriverDropCheckEnabled) {
			const driverDropCheck = await runDriverDropRecoveryCheck(
				'usb',
				createAdapter,
				timeoutMs,
				reconnectDriverDropWindowMs,
				reconnectDriverDropPollMs
			);
			if (driverDropCheck.skipped) {
				return {
					transport: 'usb',
					status: 'SKIP',
					reason: `USB driver-drop reconnect check skipped (${driverDropCheck.message ?? 'no disconnect observed'}).`
				};
			}
			if (!driverDropCheck.ok) {
				return mapPostProbeCheckFailure(
					'usb',
					'Reconnect driver-drop check',
					driverDropCheck.message ?? 'unknown error'
				);
			}
		}

			return {
				transport: 'usb',
				status: 'PASS',
				reason: runSpec
					? emergencyStopCheckEnabled
						? reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, run-program, emergency-stop, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe, run-program, emergency-stop and reconnect-recovery checks succeeded.'
							: 'Connect, capability probe, run-program and emergency-stop check succeeded.'
						: reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, run-program, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe, run-program and reconnect-recovery checks succeeded.'
							: 'Connect, capability probe and run-program check succeeded.'
					: emergencyStopCheckEnabled
						? reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, emergency-stop, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe, emergency-stop and reconnect-recovery checks succeeded.'
							: 'Connect, capability probe and emergency-stop check succeeded.'
						: reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe and reconnect-recovery checks succeeded.'
							: 'Connect and capability probe succeeded.',
				detail: {
					path: path ?? candidates[0]?.path ?? 'auto',
					attempt,
					runProgramPath: runSpec?.remotePath ?? undefined,
					runProgramMode: runSpec?.mode ?? undefined,
					runProgramFixturePath: runSpec?.localFixturePath ?? undefined,
					runProgramFixtureSource: runSpec?.fixtureSource ?? undefined,
					emergencyStopChecked: emergencyStopCheckEnabled,
					reconnectChecked: reconnectCheckEnabled,
					reconnectGlitchChecked: reconnectCheckEnabled ? reconnectGlitchCheckEnabled : false,
					reconnectDriverDropChecked: reconnectCheckEnabled ? reconnectDriverDropCheckEnabled : false,
					fwVersion: probe.capability.fwVersion,
					fwBuild: probe.capability.fwBuild
				}
			};
		} catch (error) {
			failures.push(`attempt ${attempt}: ${errorMessage(error)}`);
			if (attempt < attempts) {
				await sleep(retryDelayMs);
			}
		}
	}

	if (failures.length > 0 && failures.every((message) => isLikelyUnavailableError('usb', message))) {
		return {
			transport: 'usb',
			status: 'SKIP',
			reason: `USB transport unavailable (${failures[0]}).`
		};
	}

	return {
		transport: 'usb',
		status: 'FAIL',
		reason: failures.join(' | ')
	};
}

async function runTcpCase(
	runSpecResolution: RunProgramSpecResolution,
	emergencyStopCheckEnabled: boolean,
	reconnectCheckEnabled: boolean,
	reconnectDriverDropCheckEnabled: boolean
): Promise<HardwareCaseResult> {
	const host = process.env.EV3_COCKPIT_HW_TCP_HOST?.trim() ?? '';
	const timeoutMs = envNumber('EV3_COCKPIT_HW_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 50);
	const reconnectDriverDropWindowMs = envNumber(
		'EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_WINDOW_MS',
		DEFAULT_RECONNECT_DRIVER_DROP_WINDOW_MS,
		1000
	);
	const reconnectDriverDropPollMs = envNumber(
		'EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_POLL_MS',
		DEFAULT_RECONNECT_DRIVER_DROP_POLL_MS,
		50
	);
	const useDiscovery = envBoolean('EV3_COCKPIT_HW_TCP_USE_DISCOVERY', host.length === 0);
	const port = envNumber('EV3_COCKPIT_HW_TCP_PORT', 5555, 1);
	const discoveryPort = envNumber('EV3_COCKPIT_HW_TCP_DISCOVERY_PORT', 3015, 1);
	const discoveryTimeoutMs = envNumber(
		'EV3_COCKPIT_HW_TCP_DISCOVERY_TIMEOUT_MS',
		DEFAULT_TCP_DISCOVERY_TIMEOUT_MS,
		100
	);
	const handshakeTimeoutMs = envNumber('EV3_COCKPIT_HW_TCP_HANDSHAKE_TIMEOUT_MS', timeoutMs, 50);
	const serialNumber = process.env.EV3_COCKPIT_HW_TCP_SERIAL?.trim() ?? '';
	const attempts = envNumber('EV3_COCKPIT_HW_TCP_ATTEMPTS', DEFAULT_TCP_ATTEMPTS, 1);
	const retryDelayMs = envNumber('EV3_COCKPIT_HW_TCP_RETRY_DELAY_MS', DEFAULT_TCP_RETRY_DELAY_MS, 0);
	const runSpec = runSpecResolution.spec;
	if (runSpecResolution.error) {
		return {
			transport: 'tcp',
			status: 'FAIL',
			reason: runSpecResolution.error
		};
	}

	if (host.length === 0 && !useDiscovery) {
		return {
			transport: 'tcp',
			status: 'SKIP',
			reason: 'TCP transport unavailable (missing host and discovery disabled).'
		};
	}

	const failures: string[] = [];
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const createAdapter = () =>
				new TcpAdapter({
					host,
					port,
					serialNumber,
					useDiscovery,
					discoveryPort,
					discoveryTimeoutMs,
					handshakeTimeoutMs
				});
			const probe = await runProbe(
				createAdapter(),
				timeoutMs
			);

			if (runSpec) {
				const runCheck = await runProgramCheck(createAdapter, timeoutMs, probe.capability, runSpec);
				if (!runCheck.ok) {
					return mapPostProbeCheckFailure('tcp', 'Program run check', runCheck.message ?? 'unknown error');
				}
			}

			if (emergencyStopCheckEnabled) {
				const stopCheck = await runEmergencyStopCheck(createAdapter, timeoutMs);
				if (!stopCheck.ok) {
					return mapPostProbeCheckFailure('tcp', 'Emergency stop check', stopCheck.message ?? 'unknown error');
				}
			}

			if (reconnectCheckEnabled) {
				const reconnectCheck = await runReconnectRecoveryCheck(createAdapter, timeoutMs, false);
				if (!reconnectCheck.ok) {
					return mapPostProbeCheckFailure('tcp', 'Reconnect recovery check', reconnectCheck.message ?? 'unknown error');
				}
			}

			if (reconnectCheckEnabled && reconnectDriverDropCheckEnabled) {
				const driverDropCheck = await runDriverDropRecoveryCheck(
					'tcp',
					createAdapter,
					timeoutMs,
					reconnectDriverDropWindowMs,
					reconnectDriverDropPollMs
				);
				if (driverDropCheck.skipped) {
					return {
						transport: 'tcp',
						status: 'SKIP',
						reason: `TCP driver-drop reconnect check skipped (${driverDropCheck.message ?? 'no disconnect observed'}).`
					};
				}
				if (!driverDropCheck.ok) {
					return mapPostProbeCheckFailure(
						'tcp',
						'Reconnect driver-drop check',
						driverDropCheck.message ?? 'unknown error'
					);
				}
			}

			return {
				transport: 'tcp',
				status: 'PASS',
				reason: runSpec
					? emergencyStopCheckEnabled
						? reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, run-program, emergency-stop, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe, run-program, emergency-stop and reconnect-recovery checks succeeded.'
							: 'Connect, capability probe, run-program and emergency-stop check succeeded.'
						: reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, run-program, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe, run-program and reconnect-recovery checks succeeded.'
							: 'Connect, capability probe and run-program check succeeded.'
					: emergencyStopCheckEnabled
						? reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, emergency-stop, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe, emergency-stop and reconnect-recovery checks succeeded.'
							: 'Connect, capability probe and emergency-stop check succeeded.'
						: reconnectCheckEnabled
							? reconnectDriverDropCheckEnabled
								? 'Connect, capability probe, reconnect-recovery and driver-drop reconnect checks succeeded.'
								: 'Connect, capability probe and reconnect-recovery checks succeeded.'
							: 'Connect and capability probe succeeded.',
				detail: {
					host: host || 'discovery',
					port,
					attempt,
					runProgramPath: runSpec?.remotePath ?? undefined,
					runProgramMode: runSpec?.mode ?? undefined,
					runProgramFixturePath: runSpec?.localFixturePath ?? undefined,
					runProgramFixtureSource: runSpec?.fixtureSource ?? undefined,
					emergencyStopChecked: emergencyStopCheckEnabled,
					reconnectChecked: reconnectCheckEnabled,
					reconnectDriverDropChecked: reconnectCheckEnabled ? reconnectDriverDropCheckEnabled : false,
					fwVersion: probe.capability.fwVersion,
					fwBuild: probe.capability.fwBuild
				}
			};
		} catch (error) {
			failures.push(`attempt ${attempt}: ${errorMessage(error)}`);
			if (attempt < attempts) {
				await sleep(retryDelayMs);
			}
		}
	}

	if (failures.length > 0 && failures.every((message) => isLikelyUnavailableError('tcp', message))) {
		return {
			transport: 'tcp',
			status: 'SKIP',
			reason: `TCP transport unavailable (${failures[0]}).`
		};
	}

	return {
		transport: 'tcp',
		status: 'FAIL',
		reason: failures.join(' | ')
	};
}

function collectBluetoothPorts(
	candidates: Awaited<ReturnType<typeof listSerialCandidates>>,
	preferredSerial?: string
): string[] {
	const normalizedSerial = preferredSerial?.trim().toUpperCase() ?? '';
	return candidates
		.filter((candidate) => /^COM\d+$/i.test(candidate.path.trim()))
		.sort((a, b) => {
			const aPnp = (a.pnpId ?? '').toUpperCase();
			const bPnp = (b.pnpId ?? '').toUpperCase();
			const aSerialMatch = normalizedSerial && aPnp.includes(normalizedSerial) ? 0 : 1;
			const bSerialMatch = normalizedSerial && bPnp.includes(normalizedSerial) ? 0 : 1;
			if (aSerialMatch !== bSerialMatch) {
				return aSerialMatch - bSerialMatch;
			}

			const aEv3 = /_005D/i.test(a.pnpId ?? '') ? 0 : 1;
			const bEv3 = /_005D/i.test(b.pnpId ?? '') ? 0 : 1;
			if (aEv3 !== bEv3) {
				return aEv3 - bEv3;
			}
			return a.path.localeCompare(b.path);
		})
		.map((candidate) => candidate.path.trim().toUpperCase());
}

async function runBluetoothCase(
	runSpecResolution: RunProgramSpecResolution,
	emergencyStopCheckEnabled: boolean,
	reconnectCheckEnabled: boolean,
	reconnectGlitchCheckEnabled: boolean,
	reconnectDriverDropCheckEnabled: boolean,
	bluetoothStrictModeEnabled: boolean
): Promise<HardwareCaseResult> {
	const timeoutMs = envNumber('EV3_COCKPIT_HW_BT_PROBE_TIMEOUT_MS', DEFAULT_BT_PROBE_TIMEOUT_MS, 50);
	const baudRate = envNumber('EV3_COCKPIT_HW_BT_BAUD_RATE', 115200, 300);
	const dtr = envBoolean('EV3_COCKPIT_HW_BT_DTR', false);
	const autoDtrFallback = envBoolean('EV3_COCKPIT_HW_BT_AUTO_DTR_FALLBACK', DEFAULT_BT_AUTO_DTR_FALLBACK);
	const postOpenDelayMs = envNumber('EV3_COCKPIT_HW_BT_POST_OPEN_DELAY_MS', DEFAULT_BT_POST_OPEN_DELAY_MS, 0);
	const reconnectDriverDropWindowMs = envNumber(
		'EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_WINDOW_MS',
		DEFAULT_RECONNECT_DRIVER_DROP_WINDOW_MS,
		1000
	);
	const reconnectDriverDropPollMs = envNumber(
		'EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_POLL_MS',
		DEFAULT_RECONNECT_DRIVER_DROP_POLL_MS,
		50
	);
	const preferredPort = process.env.EV3_COCKPIT_HW_BT_PORT?.trim().toUpperCase();
	const perPortAttempts = envNumber('EV3_COCKPIT_HW_BT_PORT_ATTEMPTS', DEFAULT_BT_PORT_ATTEMPTS, 1);
	const retryDelayMs = envNumber('EV3_COCKPIT_HW_BT_RETRY_DELAY_MS', DEFAULT_BT_RETRY_DELAY_MS, 0);
	const runSpec = runSpecResolution.spec;
	if (runSpecResolution.error) {
		return {
			transport: 'bluetooth',
			status: 'FAIL',
			reason: runSpecResolution.error
		};
	}

	const usbCandidates = await listUsbHidCandidates();
	const preferredSerial = usbCandidates[0]?.serialNumber;
	const autoPorts = preferredPort ? [] : collectBluetoothPorts(await listSerialCandidates(), preferredSerial);
	const ports = preferredPort ? [preferredPort] : autoPorts;
	if (ports.length === 0) {
		if (bluetoothStrictModeEnabled) {
			return {
				transport: 'bluetooth',
				status: 'FAIL',
				reason: 'Bluetooth strict mode: no COM candidates found.'
			};
		}
		return {
			transport: 'bluetooth',
			status: 'SKIP',
			reason: 'Bluetooth transport unavailable (no COM candidates found).'
		};
	}

	const failures: string[] = [];
	const dtrProfiles = autoDtrFallback ? Array.from(new Set([dtr, !dtr])) : [dtr];
	const uncaughtErrors: string[] = [];
	const uncaughtHandler = (error: unknown): void => {
		uncaughtErrors.push(errorMessage(error));
	};
	process.prependListener('uncaughtException', uncaughtHandler);
	try {
		for (const dtrProfile of dtrProfiles) {
			for (const port of ports) {
				for (let attempt = 1; attempt <= perPortAttempts; attempt += 1) {
					try {
						const createAdapter = () =>
							new BluetoothSppAdapter({
								port,
								baudRate,
								dtr: dtrProfile
							});
						const scheduler = new CommandScheduler({
							defaultTimeoutMs: timeoutMs
						});
						const client = new Ev3CommandClient({
							scheduler,
							transport: createAdapter()
						});

						let probe: ProbeSuccess;
						try {
							await client.open();
							await sleep(postOpenDelayMs);
							probe = await runProbeWithClient(client, timeoutMs);

							if (runSpec) {
								const runCheck = await runProgramCheckWithClient(client, timeoutMs, probe.capability, runSpec);
								if (!runCheck.ok) {
									return mapPostProbeCheckFailure(
										'bluetooth',
										'Program run check',
										runCheck.message ?? 'unknown error'
									);
								}
							}

							if (emergencyStopCheckEnabled) {
								const stopCheck = await runEmergencyStopCheckWithClient(client, timeoutMs);
								if (!stopCheck.ok) {
									return mapPostProbeCheckFailure(
										'bluetooth',
										'Emergency stop check',
										stopCheck.message ?? 'unknown error'
									);
								}
							}
						} finally {
							await client.close().catch(() => undefined);
							scheduler.dispose();
						}

						if (reconnectCheckEnabled) {
							const reconnectCheck = await runReconnectRecoveryCheck(
								createAdapter,
								timeoutMs,
								reconnectGlitchCheckEnabled
							);
							if (!reconnectCheck.ok) {
								return mapPostProbeCheckFailure(
									'bluetooth',
									'Reconnect recovery check',
									reconnectCheck.message ?? 'unknown error'
								);
							}
						}

						if (reconnectCheckEnabled && reconnectDriverDropCheckEnabled) {
							const driverDropCheck = await runDriverDropRecoveryCheck(
								'bluetooth',
								createAdapter,
								timeoutMs,
								reconnectDriverDropWindowMs,
								reconnectDriverDropPollMs
							);
							if (driverDropCheck.skipped) {
								if (bluetoothStrictModeEnabled) {
									return {
										transport: 'bluetooth',
										status: 'FAIL',
										reason: `Bluetooth strict mode: driver-drop reconnect check skipped (${driverDropCheck.message ?? 'no disconnect observed'}).`
									};
								}
								return {
									transport: 'bluetooth',
									status: 'SKIP',
									reason: `Bluetooth driver-drop reconnect check skipped (${driverDropCheck.message ?? 'no disconnect observed'}).`
								};
							}
							if (!driverDropCheck.ok) {
								return mapPostProbeCheckFailure(
									'bluetooth',
									'Reconnect driver-drop check',
									driverDropCheck.message ?? 'unknown error'
								);
							}
						}

						return {
							transport: 'bluetooth',
							status: 'PASS',
							reason: runSpec
								? emergencyStopCheckEnabled
									? reconnectCheckEnabled
										? reconnectDriverDropCheckEnabled
											? 'Connect, capability probe, run-program, emergency-stop, reconnect-recovery and driver-drop reconnect checks succeeded.'
											: 'Connect, capability probe, run-program, emergency-stop and reconnect-recovery checks succeeded.'
										: 'Connect, capability probe, run-program and emergency-stop check succeeded.'
									: reconnectCheckEnabled
										? reconnectDriverDropCheckEnabled
											? 'Connect, capability probe, run-program, reconnect-recovery and driver-drop reconnect checks succeeded.'
											: 'Connect, capability probe, run-program and reconnect-recovery checks succeeded.'
										: 'Connect, capability probe and run-program check succeeded.'
								: emergencyStopCheckEnabled
									? reconnectCheckEnabled
										? reconnectDriverDropCheckEnabled
											? 'Connect, capability probe, emergency-stop, reconnect-recovery and driver-drop reconnect checks succeeded.'
											: 'Connect, capability probe, emergency-stop and reconnect-recovery checks succeeded.'
										: 'Connect, capability probe and emergency-stop check succeeded.'
									: reconnectCheckEnabled
										? reconnectDriverDropCheckEnabled
											? 'Connect, capability probe, reconnect-recovery and driver-drop reconnect checks succeeded.'
											: 'Connect, capability probe and reconnect-recovery checks succeeded.'
										: 'Connect and capability probe succeeded.',
							detail: {
								port,
								attempt,
								dtr: dtrProfile,
								runProgramPath: runSpec?.remotePath ?? undefined,
								runProgramMode: runSpec?.mode ?? undefined,
								runProgramFixturePath: runSpec?.localFixturePath ?? undefined,
								runProgramFixtureSource: runSpec?.fixtureSource ?? undefined,
								emergencyStopChecked: emergencyStopCheckEnabled,
								reconnectChecked: reconnectCheckEnabled,
								reconnectGlitchChecked: reconnectCheckEnabled ? reconnectGlitchCheckEnabled : false,
								reconnectDriverDropChecked: reconnectCheckEnabled ? reconnectDriverDropCheckEnabled : false,
								fwVersion: probe.capability.fwVersion,
								fwBuild: probe.capability.fwBuild
							}
						};
					} catch (error) {
						failures.push(`${port} attempt ${attempt} dtr=${dtrProfile}: ${errorMessage(error)}`);
						if (uncaughtErrors.length > 0) {
							for (const uncaught of uncaughtErrors.splice(0, uncaughtErrors.length)) {
								failures.push(`${port} attempt ${attempt} dtr=${dtrProfile} uncaught: ${uncaught}`);
							}
						}
						if (attempt < perPortAttempts) {
							await sleep(retryDelayMs);
						}
					}
				}
			}
		}
	} finally {
		process.removeListener('uncaughtException', uncaughtHandler);
	}

	if (failures.length > 0 && failures.every((message) => isLikelyUnavailableError('bluetooth', message))) {
		if (bluetoothStrictModeEnabled) {
			return {
				transport: 'bluetooth',
				status: 'FAIL',
				reason: `Bluetooth strict mode: unavailable failures observed (${failures[0]}).`
			};
		}
		return {
			transport: 'bluetooth',
			status: 'SKIP',
			reason: `Bluetooth transport unavailable (${failures[0]}).`
		};
	}

	return {
		transport: 'bluetooth',
		status: 'FAIL',
		reason: failures.join(' | ')
	};
}

async function runHardwareSuite(): Promise<{
	results: HardwareCaseResult[];
	selectedTransports: TransportKind[];
	emergencyStopCheckEnabled: boolean;
	reconnectCheckEnabled: boolean;
	reconnectGlitchCheckEnabled: boolean;
	reconnectDriverDropCheckEnabled: boolean;
	bluetoothStrictModeEnabled: boolean;
	warning?: string;
}> {
	const results: HardwareCaseResult[] = [];
	const runSpecResolution = resolveRunProgramSpecFromEnv();
	const selection = resolveHardwareTransportsFromEnv();
	const emergencyStopCheckEnabled = resolveEmergencyStopCheckFromEnv();
	const reconnectCheckEnabled = resolveReconnectCheckFromEnv();
	const reconnectGlitchCheckEnabled = resolveReconnectGlitchCheckFromEnv();
	const reconnectDriverDropCheckEnabled = resolveReconnectDriverDropCheckFromEnv();
	const bluetoothStrictModeEnabled = resolveBluetoothStrictModeFromEnv();

	for (const transport of selection.transports) {
		if (transport === 'usb') {
			results.push(
				await runUsbCase(
					runSpecResolution,
					emergencyStopCheckEnabled,
					reconnectCheckEnabled,
					reconnectGlitchCheckEnabled,
					reconnectDriverDropCheckEnabled
				)
			);
		} else if (transport === 'tcp') {
			results.push(
				await runTcpCase(
					runSpecResolution,
					emergencyStopCheckEnabled,
					reconnectCheckEnabled,
					reconnectDriverDropCheckEnabled
				)
			);
		} else {
			results.push(
				await runBluetoothCase(
					runSpecResolution,
					emergencyStopCheckEnabled,
					reconnectCheckEnabled,
					reconnectGlitchCheckEnabled,
					reconnectDriverDropCheckEnabled,
					bluetoothStrictModeEnabled
				)
			);
		}
	}

	return {
		results,
		selectedTransports: selection.transports,
		emergencyStopCheckEnabled,
		reconnectCheckEnabled,
		reconnectGlitchCheckEnabled,
		reconnectDriverDropCheckEnabled,
		bluetoothStrictModeEnabled,
		warning: selection.warning
	};
}

function printSummary(
	results: HardwareCaseResult[],
	selectedTransports: TransportKind[],
	emergencyStopCheckEnabled: boolean,
	reconnectCheckEnabled: boolean,
	reconnectGlitchCheckEnabled: boolean,
	reconnectDriverDropCheckEnabled: boolean,
	bluetoothStrictModeEnabled: boolean,
	warning?: string
): void {
	console.log(`[HW] Running hardware smoke tests in order: ${selectedTransports.join(' -> ')}`);
	console.log(`[HW] Emergency stop check: ${emergencyStopCheckEnabled ? 'enabled' : 'disabled'}`);
	console.log(`[HW] Reconnect recovery check: ${reconnectCheckEnabled ? 'enabled' : 'disabled'}`);
	console.log(
		`[HW] Reconnect in-flight drop simulation: ${reconnectCheckEnabled ? (reconnectGlitchCheckEnabled ? 'enabled' : 'disabled') : 'disabled'}`
	);
	console.log(
		`[HW] Reconnect driver-drop check: ${reconnectCheckEnabled ? (reconnectDriverDropCheckEnabled ? 'enabled' : 'disabled') : 'disabled'}`
	);
	console.log(`[HW] Bluetooth strict mode: ${bluetoothStrictModeEnabled ? 'enabled' : 'disabled'}`);
	if (warning) {
		console.log(`[HW] Selection warning: ${warning}`);
	}
	for (const result of results) {
		console.log(formatResult(result));
	}

	const { pass, skip, fail } = summarizeResults(results);
	console.log(`[HW] Summary: PASS=${pass} SKIP=${skip} FAIL=${fail}`);
}

export async function main(): Promise<number> {
	const suite = await runHardwareSuite();
	printSummary(
		suite.results,
		suite.selectedTransports,
		suite.emergencyStopCheckEnabled,
		suite.reconnectCheckEnabled,
		suite.reconnectGlitchCheckEnabled,
		suite.reconnectDriverDropCheckEnabled,
		suite.bluetoothStrictModeEnabled,
		suite.warning
	);
	const exitCode = suite.results.some((entry) => entry.status === 'FAIL') ? 1 : 0;
	const report = buildHardwareSmokeReport(suite, exitCode);
	const reportPath = resolveHardwareSmokeReportPath();
	await writeHardwareSmokeReport(report, reportPath);
	console.log(`[HW] Report written to ${reportPath}`);
	return exitCode;
}

if (require.main === module) {
	void main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(`[HW] Unhandled error: ${errorMessage(error)}`);
			process.exitCode = 1;
		}
	);
}
