import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { EMPTY_RBF_BYTES, EMPTY_RBF_META } from './fixtures/emptyProgram';
import { canonicalizeEv3Path } from '../fs/pathPolicy';

type TransportKind = 'usb' | 'tcp';
type HardwareStatus = 'PASS' | 'SKIP' | 'FAIL';
const TRANSPORT_ORDER: TransportKind[] = ['usb', 'tcp'];

export interface HardwareSummary {
	pass: number;
	skip: number;
	fail: number;
}

export interface HardwareBenchmarkResult {
	id: 'CONNECT_USB' | 'CONNECT_TCP';
	transport: TransportKind;
	status: HardwareStatus;
	durationMs?: number;
	warnThresholdMs: number;
	withinThreshold?: boolean;
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
	warning?: string;
	results: HardwareCaseResult[];
	summary: HardwareSummary;
	benchmarks: HardwareBenchmarkResult[];
	exitCode: number;
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

const DEFAULT_EMERGENCY_STOP_CHECK = true;
const DEFAULT_RECONNECT_CHECK = false;
const DEFAULT_RECONNECT_GLITCH_CHECK = true;
const DEFAULT_RECONNECT_DRIVER_DROP_CHECK = false;
const DEFAULT_RUN_FIXTURE_REMOTE_PATH = '/home/root/lms2012/prjs/ev3-cockpit-hw-run-fixture.rbf';
const CONNECT_WARN_THRESHOLD_MS: Record<TransportKind, number> = {
	usb: 800,
	tcp: 1_500
};

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
	]
};

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
	const remotePath = resolveRemoteFixtureUploadPath(env.EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH);
	if (!remotePath) {
		return {
			error: `Invalid EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH value: "${env.EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH ?? ''}".`
		};
	}
	if (fixtureRaw.toLowerCase() === 'auto') {
		return {
			spec: {
				mode: 'fixture-upload',
				remotePath,
				fixtureBytes: EMPTY_RBF_BYTES,
				fixtureSource: `embedded:${EMPTY_RBF_META.sourcePath}`
			}
		};
	}
	const fixturePath = resolveExistingFixturePath(fixtureRaw);
	if (!fixturePath) {
		return {
			error: `Fixture file not found: "${fixtureRaw}".`
		};
	}
	return {
		spec: {
			mode: 'fixture-upload',
			remotePath,
			localFixturePath: fixturePath
		}
	};
}

export function resolveEmergencyStopCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_EMERGENCY_STOP_CHECK?.trim().toLowerCase();
	if (raw === undefined || raw.length === 0) {
		return DEFAULT_EMERGENCY_STOP_CHECK;
	}
	if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
		return true;
	}
	if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
		return false;
	}
	return DEFAULT_EMERGENCY_STOP_CHECK;
}

export function resolveReconnectCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_RECONNECT_CHECK?.trim().toLowerCase();
	if (!raw) {
		return DEFAULT_RECONNECT_CHECK;
	}
	return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function resolveReconnectGlitchCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK?.trim().toLowerCase();
	if (!raw) {
		return DEFAULT_RECONNECT_GLITCH_CHECK;
	}
	return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function resolveReconnectDriverDropCheckFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK?.trim().toLowerCase();
	if (!raw) {
		return DEFAULT_RECONNECT_DRIVER_DROP_CHECK;
	}
	return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isLikelyUnavailableError(transport: TransportKind, error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return UNAVAILABLE_PATTERNS[transport].some((pattern) => pattern.test(message));
}

export function resolveHardwareTransportsFromEnv(
	env: NodeJS.ProcessEnv = process.env
): { transports: TransportKind[]; warning?: string } {
	const raw = env.EV3_COCKPIT_HW_TRANSPORTS?.trim();
	if (!raw) {
		return { transports: [...TRANSPORT_ORDER] };
	}
	const seen = new Set<TransportKind>();
	const unknown: string[] = [];
	for (const token of raw.split(',')) {
		const normalized = token.trim().toLowerCase();
		if (!normalized) {
			continue;
		}
		if (normalized === 'usb' || normalized === 'tcp') {
			seen.add(normalized);
			continue;
		}
		unknown.push(normalized);
	}
	if (seen.size === 0) {
		return {
			transports: [...TRANSPORT_ORDER],
			warning: `EV3_COCKPIT_HW_TRANSPORTS="${raw}" did not contain valid transports (usb,tcp). Falling back to all.`
		};
	}
	return {
		transports: TRANSPORT_ORDER.filter((transport) => seen.has(transport)),
		warning: unknown.length > 0 ? `EV3_COCKPIT_HW_TRANSPORTS ignored unknown transports: ${unknown.join(', ')}` : undefined
	};
}

export function resolveHardwareSmokeReportPath(env: NodeJS.ProcessEnv = process.env): string {
	const relative = env.EV3_COCKPIT_HW_REPORT?.trim() || path.join('artifacts', 'hw', 'hardware-smoke.json');
	return path.resolve(process.cwd(), relative);
}

export function buildHardwareSmokeReport(
	params: {
		selectedTransports: TransportKind[];
		emergencyStopCheckEnabled: boolean;
		reconnectCheckEnabled: boolean;
		reconnectGlitchCheckEnabled: boolean;
		reconnectDriverDropCheckEnabled: boolean;
		warning?: string;
		results: Array<{ transport: TransportKind; status: HardwareStatus; reason: string; detail?: Record<string, unknown> }>;
	},
	exitCode: number
): HardwareSmokeReport {
	const normalizedResults: HardwareCaseResult[] = params.results.map((entry) => ({
		transport: entry.transport,
		status: entry.status,
		reason: entry.reason,
		detail: entry.detail
	}));
	const summary = normalizedResults.reduce<HardwareSummary>(
		(acc, result) => {
			if (result.status === 'PASS') {
				acc.pass += 1;
			} else if (result.status === 'SKIP') {
				acc.skip += 1;
			} else {
				acc.fail += 1;
			}
			return acc;
		},
		{ pass: 0, skip: 0, fail: 0 }
	);
	const benchmarks: HardwareBenchmarkResult[] = normalizedResults.map((result) => ({
		id: result.transport === 'usb' ? 'CONNECT_USB' : 'CONNECT_TCP',
		transport: result.transport,
		status: result.status,
		warnThresholdMs: CONNECT_WARN_THRESHOLD_MS[result.transport]
	}));

	return {
		generatedAtIso: new Date().toISOString(),
		selectedTransports: params.selectedTransports,
		emergencyStopCheckEnabled: params.emergencyStopCheckEnabled,
		reconnectCheckEnabled: params.reconnectCheckEnabled,
		reconnectGlitchCheckEnabled: params.reconnectGlitchCheckEnabled,
		reconnectDriverDropCheckEnabled: params.reconnectDriverDropCheckEnabled,
		warning: params.warning,
		results: normalizedResults,
		summary,
		benchmarks,
		exitCode
	};
}

export async function writeHardwareSmokeReport(report: HardwareSmokeReport, reportPath: string): Promise<void> {
	await fsPromises.mkdir(path.dirname(reportPath), { recursive: true });
	await fsPromises.writeFile(reportPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
}

export async function main(): Promise<number> {
	const transportsResolution = resolveHardwareTransportsFromEnv(process.env);
	const results: HardwareCaseResult[] = transportsResolution.transports.map((transport) => ({
		transport,
		status: 'SKIP',
		reason: 'Hardware smoke execution is disabled in this build.'
	}));
	const report = buildHardwareSmokeReport({
		selectedTransports: transportsResolution.transports,
		emergencyStopCheckEnabled: resolveEmergencyStopCheckFromEnv(process.env),
		reconnectCheckEnabled: resolveReconnectCheckFromEnv(process.env),
		reconnectGlitchCheckEnabled: resolveReconnectGlitchCheckFromEnv(process.env),
		reconnectDriverDropCheckEnabled: resolveReconnectDriverDropCheckFromEnv(process.env),
		warning: transportsResolution.warning,
		results
	}, 0);
	await writeHardwareSmokeReport(report, resolveHardwareSmokeReportPath(process.env));
	return 0;
}

if (require.main === module) {
	void main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[HW] Unhandled error: ${message}`);
			process.exitCode = 1;
		}
	);
}
