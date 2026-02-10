import { computeMd5Hex } from './hashUtils';

export interface RemoteFileSnapshot {
	sizeBytes: number;
	md5: string;
}

export function shouldUploadByRemoteSnapshotMeta(
	localSizeBytes: number,
	localMd5: string,
	remote: RemoteFileSnapshot | undefined
): { upload: boolean; localMd5: string } {
	if (!remote) {
		return {
			upload: true,
			localMd5
		};
	}

	if (remote.sizeBytes !== localSizeBytes) {
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

export function shouldUploadByRemoteSnapshot(
	localBytes: Uint8Array,
	remote: RemoteFileSnapshot | undefined
): { upload: boolean; localMd5: string } {
	const localMd5 = computeMd5Hex(localBytes);
	return shouldUploadByRemoteSnapshotMeta(localBytes.length, localMd5, remote);
}
