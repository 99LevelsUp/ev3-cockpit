import { spawn } from 'node:child_process';

const WINDOWS_SHELL_FALLBACK = ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'];

let cachedPreferredShells: string[] | undefined;
let resolvingPreferredShells: Promise<string[]> | undefined;

export async function getPreferredWindowsPowerShellCommands(): Promise<string[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	if (cachedPreferredShells) {
		return cachedPreferredShells;
	}
	if (resolvingPreferredShells) {
		return await resolvingPreferredShells;
	}
	resolvingPreferredShells = resolvePreferredWindowsPowerShellCommands();
	try {
		cachedPreferredShells = await resolvingPreferredShells;
		return cachedPreferredShells;
	} finally {
		resolvingPreferredShells = undefined;
	}
}

export async function runWindowsPowerShell(script: string, timeoutMs: number): Promise<string> {
	if (process.platform !== 'win32') {
		return '';
	}
	const candidates = await getPreferredWindowsPowerShellCommands();
	let lastError: unknown;

	for (const shell of candidates) {
		try {
			return await runShellCommand(shell, script, timeoutMs);
		} catch (error) {
			lastError = error;
		}
	}

	throw new Error(`Unable to run Windows PowerShell command: ${String(lastError)}`);
}

async function resolvePreferredWindowsPowerShellCommands(): Promise<string[]> {
	const preferredPwsh = new Set<string>();

	for (const shell of WINDOWS_SHELL_FALLBACK) {
		const majorVersion = await probeShellMajorVersion(shell);
		if ((majorVersion ?? 0) >= 7) {
			preferredPwsh.add(shell);
		}
	}

	if (preferredPwsh.size === 0) {
		return [...WINDOWS_SHELL_FALLBACK];
	}

	return [
		...WINDOWS_SHELL_FALLBACK.filter((shell) => preferredPwsh.has(shell)),
		...WINDOWS_SHELL_FALLBACK.filter((shell) => !preferredPwsh.has(shell))
	];
}

async function probeShellMajorVersion(shell: string): Promise<number | undefined> {
	try {
		const stdout = await runShellCommand(shell, '$PSVersionTable.PSVersion.Major', 5000);
		const parsed = Number.parseInt(stdout.trim(), 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function runShellCommand(shell: string, script: string, timeoutMs: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const proc = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		timer.unref?.();

		proc.stdout.on('data', (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		proc.stderr.on('data', (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		proc.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		proc.once('exit', (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`PowerShell command timed out after ${timeoutMs}ms.`));
				return;
			}
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const detail = stderr.trim() || stdout.trim() || `exit code ${String(code)}`;
			reject(new Error(detail));
		});
	});
}
