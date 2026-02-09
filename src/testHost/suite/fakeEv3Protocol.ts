import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { CAPABILITY_PROBE_GLOBAL_BYTES } from '../../protocol/capabilityProbe';

export function writeCString(target: Uint8Array, offset: number, length: number, value: string): void {
	const encoded = Buffer.from(value, 'utf8');
	const end = Math.min(encoded.length, Math.max(0, length - 1));
	target.set(encoded.subarray(0, end), offset);
}

export function buildCapabilityReplyPayload(): Uint8Array {
	const payload = new Uint8Array(CAPABILITY_PROBE_GLOBAL_BYTES);
	writeCString(payload, 0, 16, 'Linux 2.6.33-rc');
	writeCString(payload, 16, 8, 'V0.60');
	writeCString(payload, 24, 8, 'V1.10E');
	writeCString(payload, 32, 12, '1803051132');
	writeCString(payload, 44, 12, '1803051258');
	return payload;
}

export function normalizeRemotePath(input: string): string {
	const unified = input.replace(/\\/g, '/');
	const prefixed = unified.startsWith('/') ? unified : `/${unified}`;
	const normalized = path.posix.normalize(prefixed);
	if (normalized === '.') {
		return '/';
	}
	const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
	if (absolute.length > 1 && absolute.endsWith('/')) {
		return absolute.slice(0, -1);
	}
	return absolute;
}

export function parseCString(bytes: Uint8Array, offset: number): string {
	let end = offset;
	while (end < bytes.length && bytes[end] !== 0x00) {
		end += 1;
	}
	return Buffer.from(bytes.subarray(offset, end)).toString('utf8');
}

export function uint32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

export function parseListOpenHandlesProbe(payload: Uint8Array): Uint8Array {
	const opcode = payload[0] ?? 0x00;
	return new Uint8Array([opcode, 0x00]);
}

export type RemoteDirectoryListing = {
	folders: string[];
	files: Array<{ name: string; bytes: Uint8Array }>;
};

export class FakeRemoteFsState {
	private readonly directories = new Set<string>(['/']);
	private readonly files = new Map<string, Uint8Array>();

	public constructor() {
		this.ensureDirectory('/home/root/lms2012/prjs/');
	}

	public ensureDirectory(inputPath: string): void {
		const normalized = normalizeRemotePath(inputPath);
		if (normalized === '/') {
			this.directories.add('/');
			return;
		}

		const parts = normalized.split('/').filter((part) => part.length > 0);
		let current = '/';
		for (const part of parts) {
			current = current === '/' ? `/${part}` : `${current}/${part}`;
			this.directories.add(current);
		}
	}

	public writeFile(inputPath: string, contents: Uint8Array): void {
		const normalized = normalizeRemotePath(inputPath);
		this.ensureDirectory(path.posix.dirname(normalized));
		this.files.set(normalized, contents.slice());
	}

	public readFile(inputPath: string): Uint8Array {
		const normalized = normalizeRemotePath(inputPath);
		const bytes = this.files.get(normalized);
		if (!bytes) {
			throw new Error(`File not found: ${normalized}`);
		}
		return bytes.slice();
	}

	public deletePath(inputPath: string): void {
		const normalized = normalizeRemotePath(inputPath);
		if (this.files.delete(normalized)) {
			return;
		}

		if (!this.directories.has(normalized)) {
			throw new Error(`Path not found: ${normalized}`);
		}

		for (const dir of this.directories) {
			if (dir !== normalized && dir.startsWith(`${normalized}/`)) {
				throw new Error(`Directory not empty: ${normalized}`);
			}
		}
		for (const filePath of this.files.keys()) {
			if (filePath.startsWith(`${normalized}/`)) {
				throw new Error(`Directory not empty: ${normalized}`);
			}
		}

		this.directories.delete(normalized);
	}

	public listDirectory(inputPath: string): RemoteDirectoryListing {
		const normalized = normalizeRemotePath(inputPath);
		if (!this.directories.has(normalized)) {
			throw new Error(`Directory not found: ${normalized}`);
		}

		const folders = new Set<string>();
		const files: Array<{ name: string; bytes: Uint8Array }> = [];
		for (const dir of this.directories) {
			if (dir === normalized) {
				continue;
			}
			if (!dir.startsWith(`${normalized === '/' ? '' : normalized}/`)) {
				continue;
			}
			const relative = dir.slice((normalized === '/' ? '' : normalized).length + 1);
			if (relative.length > 0 && !relative.includes('/')) {
				folders.add(relative);
			}
		}
		for (const [filePath, data] of this.files.entries()) {
			if (!filePath.startsWith(`${normalized === '/' ? '' : normalized}/`)) {
				continue;
			}
			const relative = filePath.slice((normalized === '/' ? '' : normalized).length + 1);
			if (relative.length > 0 && !relative.includes('/')) {
				files.push({
					name: relative,
					bytes: data.slice()
				});
			}
		}

		files.sort((a, b) => a.name.localeCompare(b.name));
		return {
			folders: Array.from(folders).sort((a, b) => a.localeCompare(b)),
			files
		};
	}
}

export type UploadSession = {
	handle: number;
	path: string;
	expectedBytes: number;
	chunks: Uint8Array[];
};

export type DownloadSession = {
	handle: number;
	remaining: Uint8Array;
};

export interface FakeEv3CommandContext {
	fs: FakeRemoteFsState;
	uploads: Map<number, UploadSession>;
	downloads: Map<number, DownloadSession>;
	nextHandle: number;
}

export function allocateHandle(ctx: FakeEv3CommandContext): number {
	const handle = ctx.nextHandle & 0xff;
	ctx.nextHandle = ((ctx.nextHandle + 1) & 0xff) || 1;
	return handle;
}

export function buildListText(listing: RemoteDirectoryListing): Uint8Array {
	const lines: string[] = [];
	for (const folder of listing.folders) {
		lines.push(`${folder}/`);
	}
	for (const file of listing.files) {
		const md5 = createHash('md5').update(Buffer.from(file.bytes)).digest('hex');
		lines.push(`${md5} ${file.bytes.length.toString(16)} ${file.name}`);
	}
	return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseListPath(payload: Uint8Array): string {
	// LIST_FILES payload: uint16 max + c-string path.
	return parseCString(payload, 2);
}

export function parseBeginUploadPath(payload: Uint8Array): string {
	// BEGIN_UPLOAD payload: uint16 max + c-string path.
	return parseCString(payload, 2);
}

export function parseBeginDownload(payload: Uint8Array): { path: string; size: number } {
	// BEGIN_DOWNLOAD payload: uint32 size + c-string path.
	const size = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
	const filePath = parseCString(payload, 4);
	return {
		path: filePath,
		size
	};
}

export function buildSystemReply(opcode: number, status: number, data: Uint8Array = new Uint8Array()): Uint8Array {
	const out = new Uint8Array(2 + data.length);
	out[0] = opcode & 0xff;
	out[1] = status & 0xff;
	out.set(data, 2);
	return out;
}

export function executeFakeSystemCommand(ctx: FakeEv3CommandContext, opcode: number, commandPayload: Uint8Array): Uint8Array {
	switch (opcode) {
		case 0x9d: {
			return parseListOpenHandlesProbe(new Uint8Array([opcode]));
		}
		case 0x9b: {
			const dirPath = parseCString(commandPayload, 0);
			ctx.fs.ensureDirectory(dirPath);
			return buildSystemReply(opcode, 0x00);
		}
		case 0x9c: {
			const targetPath = parseCString(commandPayload, 0);
			try {
				ctx.fs.deletePath(targetPath);
				return buildSystemReply(opcode, 0x00);
			} catch {
				return buildSystemReply(opcode, 0x01);
			}
		}
		case 0x99: {
			const remotePath = parseListPath(commandPayload);
			try {
				const listing = ctx.fs.listDirectory(remotePath);
				const payload = buildListText(listing);
				const data = new Uint8Array(5 + payload.length);
				data.set(uint32le(payload.length), 0);
				data[4] = 0x00;
				data.set(payload, 5);
				return buildSystemReply(opcode, 0x08, data);
			} catch {
				return buildSystemReply(opcode, 0x06);
			}
		}
		case 0x98: {
			return buildSystemReply(opcode, 0x00);
		}
		case 0x94: {
			const remotePath = parseBeginUploadPath(commandPayload);
			try {
				const bytes = ctx.fs.readFile(remotePath);
				const requestSize = new DataView(
					commandPayload.buffer,
					commandPayload.byteOffset,
					commandPayload.byteLength
				).getUint16(0, true);
				const firstChunkSize = Math.min(requestSize, bytes.length);
				const firstChunk = bytes.subarray(0, firstChunkSize);
				const remaining = bytes.subarray(firstChunkSize);
				const handle = remaining.length > 0 ? allocateHandle(ctx) : 0x00;
				if (remaining.length > 0) {
					ctx.downloads.set(handle, {
						handle,
						remaining: remaining.slice()
					});
				}

				const data = new Uint8Array(5 + firstChunk.length);
				data.set(uint32le(bytes.length), 0);
				data[4] = handle;
				data.set(firstChunk, 5);
				const status = remaining.length > 0 ? 0x00 : 0x08;
				return buildSystemReply(opcode, status, data);
			} catch {
				return buildSystemReply(opcode, 0x06);
			}
		}
		case 0x95: {
			if (commandPayload.length < 3) {
				return buildSystemReply(opcode, 0x01);
			}
			const handle = commandPayload[0];
			const session = ctx.downloads.get(handle);
			if (!session) {
				return buildSystemReply(opcode, 0x01);
			}

			const requestedSize = new DataView(
				commandPayload.buffer,
				commandPayload.byteOffset + 1,
				commandPayload.byteLength - 1
			).getUint16(0, true);
			const chunkSize = Math.min(requestedSize, session.remaining.length);
			const chunk = session.remaining.subarray(0, chunkSize);
			session.remaining = session.remaining.subarray(chunkSize);
			if (session.remaining.length === 0) {
				ctx.downloads.delete(handle);
				return buildSystemReply(opcode, 0x08, new Uint8Array([handle, ...chunk]));
			}

			ctx.downloads.set(handle, session);
			return buildSystemReply(opcode, 0x00, new Uint8Array([handle, ...chunk]));
		}
		case 0x92: {
			const parsed = parseBeginDownload(commandPayload);
			const handle = allocateHandle(ctx);
			ctx.uploads.set(handle, {
				handle,
				path: parsed.path,
				expectedBytes: parsed.size,
				chunks: []
			});
			return buildSystemReply(opcode, 0x00, new Uint8Array([handle]));
		}
		case 0x93: {
			if (commandPayload.length < 1) {
				return buildSystemReply(opcode, 0x01);
			}
			const handle = commandPayload[0];
			const session = ctx.uploads.get(handle);
			if (!session) {
				return buildSystemReply(opcode, 0x01);
			}
			session.chunks.push(commandPayload.subarray(1));
			const uploaded = session.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const done = uploaded >= session.expectedBytes;
			if (done) {
				const data = new Uint8Array(uploaded);
				let offset = 0;
				for (const chunk of session.chunks) {
					data.set(chunk, offset);
					offset += chunk.length;
				}
				ctx.fs.writeFile(session.path, data.subarray(0, session.expectedBytes));
				ctx.uploads.delete(handle);
				return buildSystemReply(opcode, 0x08, new Uint8Array([handle]));
			}

			ctx.uploads.set(handle, session);
			return buildSystemReply(opcode, 0x00, new Uint8Array([handle]));
		}
		default:
			return buildSystemReply(opcode, 0x0a);
	}
}
