import { createHash } from 'node:crypto';

export interface RemoteFileSnapshot {
	sizeBytes: number;
	md5: string;
}

export function computeMd5Hex(bytes: Uint8Array): string {
	return createHash('md5').update(bytes).digest('hex').toUpperCase();
}

export function shouldUploadByRemoteSnapshot(
	localBytes: Uint8Array,
	remote: RemoteFileSnapshot | undefined
): { upload: boolean; localMd5: string } {
	const localMd5 = computeMd5Hex(localBytes);
	if (!remote) {
		return {
			upload: true,
			localMd5
		};
	}

	if (remote.sizeBytes !== localBytes.length) {
		return {
			upload: true,
			localMd5
		};
	}

	const remoteMd5 = remote.md5.trim().toUpperCase();
	if (!remoteMd5 || remoteMd5 !== localMd5) {
		return {
			upload: true,
			localMd5
		};
	}

	return {
		upload: false,
		localMd5
	};
}
