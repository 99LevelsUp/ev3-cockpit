import { computeMd5Hex } from './hashUtils';

export interface RemoteFileSnapshot {
	sizeBytes: number;
	md5: string;
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

	const remoteMd5 = remote.md5.trim().toLowerCase();
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
