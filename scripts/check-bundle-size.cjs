const fs = require('node:fs');
const path = require('node:path');

const bundlePath = path.resolve(process.cwd(), 'out', 'extension.js');
const maxBytes = Number(process.env.EV3_COCKPIT_MAX_BUNDLE_BYTES ?? 256 * 1024);

if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
	throw new Error(`Invalid EV3_COCKPIT_MAX_BUNDLE_BYTES value: ${process.env.EV3_COCKPIT_MAX_BUNDLE_BYTES ?? ''}`);
}

if (!fs.existsSync(bundlePath)) {
	throw new Error(`Bundle file not found: ${bundlePath}. Run "npm run package" first.`);
}

const sizeBytes = fs.statSync(bundlePath).size;
if (sizeBytes > maxBytes) {
	throw new Error(`Bundle size ${sizeBytes} B exceeds limit ${maxBytes} B (${path.relative(process.cwd(), bundlePath)}).`);
}

console.log(
	`[bundle-size] OK: ${path.relative(process.cwd(), bundlePath)} = ${sizeBytes} B (limit ${maxBytes} B).`
);
