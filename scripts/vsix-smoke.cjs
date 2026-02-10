const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = require('@vscode/test-electron');

function spawnCapture(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const isCmdScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
		const commandToRun = isCmdScript ? 'cmd.exe' : command;
		const argsToRun = isCmdScript ? ['/d', '/s', '/c', command, ...args] : args;
		let stdout = '';
		let stderr = '';
		const child = spawn(commandToRun, argsToRun, {
			stdio: ['ignore', 'pipe', 'pipe'],
			...options
		});

		child.stdout.on('data', (chunk) => {
			const text = chunk.toString();
			stdout += text;
			process.stdout.write(text);
		});
		child.stderr.on('data', (chunk) => {
			const text = chunk.toString();
			stderr += text;
			process.stderr.write(text);
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`Command failed (${code}): ${commandToRun} ${argsToRun.join(' ')}\n${stderr}`));
		});
	});
}

function resolveVsixPath() {
	const fromArgIndex = process.argv.indexOf('--vsix');
	if (fromArgIndex >= 0 && process.argv[fromArgIndex + 1]) {
		return path.resolve(process.cwd(), process.argv[fromArgIndex + 1]);
	}
	return path.resolve(process.cwd(), 'artifacts', 'vsix', 'ev3-cockpit.vsix');
}

async function main() {
	const root = process.cwd();
	const pkgJsonPath = path.resolve(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
	const extensionId = `${pkg.publisher}.${pkg.name}`;
	const vscodeVersion = process.env.VSCODE_TEST_VERSION?.trim() || '1.109.0';
	const vsixPath = resolveVsixPath();
	if (!fs.existsSync(vsixPath)) {
		throw new Error(`VSIX package not found: ${vsixPath}. Run "npm run package:vsix" first.`);
	}

	const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-vsix-smoke-'));
	const userDataDir = path.join(tempRoot, 'user-data');
	const extensionsDir = path.join(tempRoot, 'extensions');
	await fsp.mkdir(userDataDir, { recursive: true });
	await fsp.mkdir(extensionsDir, { recursive: true });

	try {
		const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
		const vscodeCliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

		await spawnCapture(
			vscodeCliPath,
			[
				'--extensions-dir',
				extensionsDir,
				'--user-data-dir',
				userDataDir,
				'--install-extension',
				vsixPath,
				'--force'
			],
			{ cwd: root }
		);

		const listResult = await spawnCapture(
			vscodeCliPath,
			[
				'--extensions-dir',
				extensionsDir,
				'--user-data-dir',
				userDataDir,
				'--list-extensions'
			],
			{ cwd: root }
		);
		const installedIds = listResult.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (!installedIds.includes(extensionId)) {
			throw new Error(
				`Installed extension list does not contain "${extensionId}". Installed: ${installedIds.join(', ') || '(none)'}`
			);
		}

		console.log(`[vsix-smoke] OK: installed and listed ${extensionId}`);
	} finally {
		await fsp.rm(tempRoot, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`[vsix-smoke] Failed: ${message}`);
	process.exitCode = 1;
});
