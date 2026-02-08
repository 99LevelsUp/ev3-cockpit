const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function collectTestFiles(rootDir) {
	const queue = [rootDir];
	const files = [];

	while (queue.length > 0) {
		const current = queue.shift();
		const entries = fs.readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith('.test.js')) {
				files.push(fullPath);
			}
		}
	}

	files.sort((left, right) => left.localeCompare(right));
	return files;
}

const testRoot = path.join(process.cwd(), 'out', '__tests__');

if (!fs.existsSync(testRoot)) {
	console.error(`Unit test directory not found: ${testRoot}`);
	process.exit(1);
}

const testFiles = collectTestFiles(testRoot);
if (testFiles.length === 0) {
	console.error(`No unit test files found under: ${testRoot}`);
	process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
	stdio: 'inherit'
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
