import * as path from 'node:path';

const BINARY_EXTENSIONS = new Set<string>([
	'.rbf',
	'.rgf',
	'.rsf',
	'.rbm',
	'.rso',
	'.wav',
	'.bmp',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.bin',
	'.zip',
	'.gz',
	'.tgz'
]);

export function isLikelyBinaryPath(filePath: string): boolean {
	const ext = path.posix.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}
