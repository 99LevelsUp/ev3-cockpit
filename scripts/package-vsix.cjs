const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function spawnCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: 'inherit',
			shell: process.platform === 'win32',
			...options
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}`));
		});
	});
}

async function main() {
	const root = process.cwd();
	const artifactsDir = path.resolve(root, 'artifacts', 'vsix');
	const outputPath = path.resolve(artifactsDir, 'ev3-cockpit.vsix');
	await fs.mkdir(artifactsDir, { recursive: true });

	const runner = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	await spawnCommand(runner, ['exec', '--', 'vsce', 'package', '--out', outputPath], { cwd: root });

	console.log(`[vsix-package] Created ${outputPath}`);
}

void main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`[vsix-package] Failed: ${message}`);
	process.exitCode = 1;
});
