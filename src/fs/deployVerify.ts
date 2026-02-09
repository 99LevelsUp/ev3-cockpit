import * as path from 'node:path';
import { DeployVerifyMode } from '../config/deployConfig';
import { computeMd5Hex } from './hashUtils';

export interface DeployVerifyRemoteFsLike {
	listDirectory(remotePath: string): Promise<{
		files: Array<{ name: string; size: number; md5: string }>;
		truncated: boolean;
	}>;
	readFile(remotePath: string): Promise<Uint8Array>;
}

async function loadRemoteSnapshot(
	fs: DeployVerifyRemoteFsLike,
	remotePath: string
): Promise<{ size: number; md5: string; truncated: boolean } | undefined> {
	const parent = path.posix.dirname(remotePath);
	const fileName = path.posix.basename(remotePath);
	const listing = await fs.listDirectory(parent);
	const file = listing.files.find((entry) => entry.name === fileName);
	if (!file) {
		return undefined;
	}
	return {
		size: file.size,
		md5: file.md5,
		truncated: listing.truncated
	};
}

export async function verifyUploadedFile(
	fs: DeployVerifyRemoteFsLike,
	remotePath: string,
	localBytes: Uint8Array,
	mode: Exclude<DeployVerifyMode, 'none'>
): Promise<void> {
	const localSize = localBytes.length;
	const localMd5 = mode === 'md5' ? computeMd5Hex(localBytes) : undefined;
	const snapshot = await loadRemoteSnapshot(fs, remotePath);

	if (snapshot && !snapshot.truncated) {
		if (snapshot.size !== localSize) {
			throw new Error(
				`Upload verification failed for "${remotePath}": size mismatch local=${localSize}, remote=${snapshot.size}.`
			);
		}

		if (mode === 'md5') {
			if (snapshot.md5 && snapshot.md5.toLowerCase() !== localMd5) {
				throw new Error(
					`Upload verification failed for "${remotePath}": md5 mismatch local=${localMd5}, remote=${snapshot.md5}.`
				);
			}
		}

		return;
	}

	const remoteBytes = await fs.readFile(remotePath);
	if (remoteBytes.length !== localSize) {
		throw new Error(
			`Upload verification failed for "${remotePath}": size mismatch local=${localSize}, remote=${remoteBytes.length}.`
		);
	}

	if (mode === 'md5') {
		const remoteMd5 = computeMd5Hex(remoteBytes);
		if (remoteMd5 !== localMd5) {
			throw new Error(
				`Upload verification failed for "${remotePath}": md5 mismatch local=${localMd5}, remote=${remoteMd5}.`
			);
		}
	}
}
