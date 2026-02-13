import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

type TransportKind = 'usb' | 'tcp' | 'bt';
type HardwareStatus = 'PASS' | 'SKIP' | 'FAIL';
type MatrixScenarioId = 'baseline' | 'reconnect' | 'reconnect-glitch' | 'driver-drop';

interface HardwareCaseResult {
	transport: TransportKind;
	status: HardwareStatus;
	reason: string;
	detail?: Record<string, unknown>;
}

interface HardwareSummary {
	pass: number;
	skip: number;
	fail: number;
}

interface MatrixScenario {
	id: MatrixScenarioId;
	description: string;
	env: NodeJS.ProcessEnv;
}

interface MatrixScenarioResult {
	id: MatrixScenarioId;
	description: string;
	exitCode: number;
	durationMs: number;
	summary: HardwareSummary;
	results: HardwareCaseResult[];
	rawOutput: string;
}

interface MatrixReport {
	generatedAt: string;
	nodeVersion: string;
	transports: string;
	bluetoothStrictMode: boolean;
	scenarios: MatrixScenarioResult[];
	totals: {
		pass: number;
		skip: number;
		fail: number;
	};
}

const DEFAULT_SCENARIO_IDS: MatrixScenarioId[] = ['baseline', 'reconnect', 'reconnect-glitch'];
const ALL_SCENARIO_IDS: MatrixScenarioId[] = ['baseline', 'reconnect', 'reconnect-glitch', 'driver-drop'];

export function parseScenarioIds(raw: string | undefined): MatrixScenarioId[] {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) {
		return [...DEFAULT_SCENARIO_IDS];
	}

	const valid = new Set<MatrixScenarioId>();
	for (const token of normalized.split(',')) {
		const candidate = token.trim();
		if (
			candidate === 'baseline' ||
			candidate === 'reconnect' ||
			candidate === 'reconnect-glitch' ||
			candidate === 'driver-drop'
		) {
			valid.add(candidate);
		}
	}

	return valid.size > 0 ? [...ALL_SCENARIO_IDS].filter((id) => valid.has(id)) : [...DEFAULT_SCENARIO_IDS];
}

function buildScenario(id: MatrixScenarioId, baseEnv: NodeJS.ProcessEnv): MatrixScenario {
	if (id === 'driver-drop') {
		return {
			id,
			description: 'Reconnect recovery (manual driver-drop simulation)',
			env: {
				...baseEnv,
				EV3_COCKPIT_HW_RECONNECT_CHECK: 'true',
				EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK: 'false',
				EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK: 'true'
			}
		};
	}

	if (id === 'reconnect') {
		return {
			id,
			description: 'Reconnect recovery (without in-flight glitch)',
			env: {
				...baseEnv,
				EV3_COCKPIT_HW_RECONNECT_CHECK: 'true',
				EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK: 'false',
				EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK: 'false'
			}
		};
	}

	if (id === 'reconnect-glitch') {
		return {
			id,
			description: 'Reconnect recovery (with in-flight glitch simulation)',
			env: {
				...baseEnv,
				EV3_COCKPIT_HW_RECONNECT_CHECK: 'true',
				EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK: 'true',
				EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK: 'false'
			}
		};
	}

	return {
		id: 'baseline',
		description: 'Baseline smoke (probe + optional run + emergency stop)',
		env: {
			...baseEnv,
			EV3_COCKPIT_HW_RECONNECT_CHECK: 'false',
			EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK: 'false',
			EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK: 'false'
		}
	};
}

function parseTransportKind(raw: string): TransportKind {
	const normalized = raw.trim().toLowerCase();
	if (normalized === 'usb' || normalized === 'tcp' || normalized === 'bt') {
		return normalized;
	}
	if (normalized === 'bluetooth') {
		return 'bt';
	}
	throw new Error(`Unsupported transport kind "${raw}".`);
}

function tryParseDetailJson(raw: string): { reason: string; detail?: Record<string, unknown> } {
	const jsonStart = raw.indexOf(' {');
	if (jsonStart < 0) {
		return { reason: raw.trim() };
	}

	const reason = raw.slice(0, jsonStart).trim();
	const detailCandidate = raw.slice(jsonStart + 1).trim();
	try {
		const parsed = JSON.parse(detailCandidate);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { reason, detail: parsed as Record<string, unknown> };
		}
	} catch {
		// Keep raw reason when detail is not a valid JSON object.
	}
	return { reason: raw.trim() };
}

export function parseHardwareSmokeOutput(output: string): { results: HardwareCaseResult[]; summary: HardwareSummary } {
	const results: HardwareCaseResult[] = [];
	const summary: HardwareSummary = { pass: 0, skip: 0, fail: 0 };

	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	for (const line of lines) {
		const caseMatch = /^\[HW\]\[(USB|TCP|BT|BLUETOOTH)\]\s+(PASS|SKIP|FAIL)\s+(.+)$/i.exec(line);
		if (caseMatch) {
			const transport = parseTransportKind(caseMatch[1]);
			const status = caseMatch[2].toUpperCase() as HardwareStatus;
			const parsedDetail = tryParseDetailJson(caseMatch[3]);
			results.push({
				transport,
				status,
				reason: parsedDetail.reason,
				detail: parsedDetail.detail
			});
			continue;
		}

		const summaryMatch = /^\[HW\]\s+Summary:\s+PASS=(\d+)\s+SKIP=(\d+)\s+FAIL=(\d+)$/i.exec(line);
		if (summaryMatch) {
			summary.pass = Number.parseInt(summaryMatch[1], 10);
			summary.skip = Number.parseInt(summaryMatch[2], 10);
			summary.fail = Number.parseInt(summaryMatch[3], 10);
		}
	}

	if (summary.pass === 0 && summary.skip === 0 && summary.fail === 0 && results.length > 0) {
		for (const result of results) {
			if (result.status === 'PASS') {
				summary.pass += 1;
			} else if (result.status === 'SKIP') {
				summary.skip += 1;
			} else {
				summary.fail += 1;
			}
		}
	}

	return { results, summary };
}

function runHardwareSmokeOnce(env: NodeJS.ProcessEnv): Promise<{ exitCode: number; output: string; durationMs: number }> {
	const scriptPath = path.resolve(__dirname, 'hardwareSmoke.js');
	return new Promise((resolve, reject) => {
		const startTime = Date.now();
		const child = spawn(process.execPath, [scriptPath], {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let output = '';
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
		});

		child.on('error', (error) => {
			reject(error);
		});

		child.on('close', (exitCode) => {
			resolve({
				exitCode: exitCode ?? 1,
				output,
				durationMs: Date.now() - startTime
			});
		});
	});
}

function resolveReportPath(): string {
	const raw = process.env.EV3_COCKPIT_HW_MATRIX_REPORT?.trim();
	const relative = raw && raw.length > 0 ? raw : path.join('artifacts', 'hw', 'hardware-matrix.json');
	return path.resolve(process.cwd(), relative);
}

export async function runHardwareMatrix(): Promise<{ report: MatrixReport; exitCode: number; reportPath: string }> {
	const selectedTransports = process.env.EV3_COCKPIT_HW_TRANSPORTS?.trim() || 'usb,tcp,bluetooth';
	const bluetoothStrictMode = /^(1|true|yes|on)$/i.test(process.env.EV3_COCKPIT_HW_BT_STRICT?.trim() ?? '');
	const baseEnv: NodeJS.ProcessEnv = {
		...process.env,
		EV3_COCKPIT_HW_TRANSPORTS: selectedTransports
	};

	const scenarios = parseScenarioIds(process.env.EV3_COCKPIT_HW_MATRIX_SCENARIOS).map((id) => buildScenario(id, baseEnv));
	const results: MatrixScenarioResult[] = [];

	for (const scenario of scenarios) {
		console.log(`[HW-MATRIX] Running scenario "${scenario.id}" (${scenario.description}).`);
		const execution = await runHardwareSmokeOnce(scenario.env);
		const parsed = parseHardwareSmokeOutput(execution.output);
		results.push({
			id: scenario.id,
			description: scenario.description,
			exitCode: execution.exitCode,
			durationMs: execution.durationMs,
			summary: parsed.summary,
			results: parsed.results,
			rawOutput: execution.output
		});
		console.log(
			`[HW-MATRIX] Scenario "${scenario.id}" finished: PASS=${parsed.summary.pass} SKIP=${parsed.summary.skip} FAIL=${parsed.summary.fail} (exit=${execution.exitCode}, ${execution.durationMs}ms).`
		);
	}

	const totals = results.reduce(
		(acc, scenario) => {
			acc.pass += scenario.summary.pass;
			acc.skip += scenario.summary.skip;
			acc.fail += scenario.summary.fail;
			return acc;
		},
		{ pass: 0, skip: 0, fail: 0 }
	);

	const report: MatrixReport = {
		generatedAt: new Date().toISOString(),
		nodeVersion: process.version,
		transports: selectedTransports,
		bluetoothStrictMode,
		scenarios: results,
		totals
	};

	const reportPath = resolveReportPath();
	await fs.mkdir(path.dirname(reportPath), { recursive: true });
	await fs.writeFile(reportPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
	console.log(`[HW-MATRIX] Report written to ${reportPath}`);
	console.log(`[HW-MATRIX] Totals: PASS=${totals.pass} SKIP=${totals.skip} FAIL=${totals.fail}`);

	const exitCode = results.some((entry) => entry.exitCode !== 0 || entry.summary.fail > 0) ? 1 : 0;
	return { report, exitCode, reportPath };
}

export async function main(): Promise<number> {
	const result = await runHardwareMatrix();
	return result.exitCode;
}

if (require.main === module) {
	void main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[HW-MATRIX] Unhandled error: ${message}`);
			process.exitCode = 1;
		}
	);
}
