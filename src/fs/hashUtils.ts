import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function computeMd5Hex(bytes: Uint8Array): string {
	return createHash('md5').update(bytes).digest('hex');
}

export async function computeFileMd5Hex(filePath: string): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const hash = createHash('md5');
		const stream = createReadStream(filePath);
		stream.on('error', reject);
		stream.on('data', (chunk: Buffer | string) => {
			hash.update(chunk);
		});
		stream.on('end', () => {
			resolve(hash.digest('hex'));
		});
	});
}
