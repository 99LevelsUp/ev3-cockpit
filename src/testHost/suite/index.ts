import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildRemoteProjectRoot } from '../../fs/deployActions';
import { CAPABILITY_PROBE_GLOBAL_BYTES } from '../../protocol/capabilityProbe';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../../protocol/ev3Packet';

const EXTENSION_ID = 'ev3-cockpit.ev3-cockpit';

async function waitForCondition(
	label: string,
	condition: () => boolean,
	timeoutMs = 10_000
): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timeout while waiting for condition: ${label}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
}

function writeCString(target: Uint8Array, offset: number, length: number, value: string): void {
	const encoded = Buffer.from(value, 'utf8');
	const end = Math.min(encoded.length, Math.max(0, length - 1));
	target.set(encoded.subarray(0, end), offset);
}

function buildCapabilityReplyPayload(): Uint8Array {
	const payload = new Uint8Array(CAPABILITY_PROBE_GLOBAL_BYTES);
	writeCString(payload, 0, 16, 'Linux 2.6.33-rc');
	writeCString(payload, 16, 8, 'V0.60');
	writeCString(payload, 24, 8, 'V1.10E');
	writeCString(payload, 32, 12, '1803051132');
	writeCString(payload, 44, 12, '1803051258');
	return payload;
}

function normalizeRemotePath(input: string): string {
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

function toSafeIdentifierForTest(input: string): string {
	const normalized = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized.length > 0 ? normalized : 'active';
}

function parseCString(bytes: Uint8Array, offset: number): string {
	let end = offset;
	while (end < bytes.length && bytes[end] !== 0x00) {
		end += 1;
	}
	return Buffer.from(bytes.subarray(offset, end)).toString('utf8');
}

function uint32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

function parseListOpenHandlesProbe(payload: Uint8Array): Uint8Array {
	const opcode = payload[0] ?? 0x00;
	return new Uint8Array([opcode, 0x00]);
}

type RemoteDirectoryListing = {
	folders: string[];
	files: Array<{ name: string; bytes: Uint8Array }>;
};

class FakeRemoteFsState {
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

type UploadSession = {
	handle: number;
	path: string;
	expectedBytes: number;
	chunks: Uint8Array[];
};

type DownloadSession = {
	handle: number;
	remaining: Uint8Array;
};

interface FakeEv3CommandContext {
	fs: FakeRemoteFsState;
	uploads: Map<number, UploadSession>;
	downloads: Map<number, DownloadSession>;
	nextHandle: number;
}

function allocateHandle(ctx: FakeEv3CommandContext): number {
	const handle = ctx.nextHandle & 0xff;
	ctx.nextHandle = ((ctx.nextHandle + 1) & 0xff) || 1;
	return handle;
}

function buildListText(listing: RemoteDirectoryListing): Uint8Array {
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

function parseListPath(payload: Uint8Array): string {
	// LIST_FILES payload: uint16 max + c-string path.
	return parseCString(payload, 2);
}

function parseBeginUploadPath(payload: Uint8Array): string {
	// BEGIN_UPLOAD payload: uint16 max + c-string path.
	return parseCString(payload, 2);
}

function parseBeginDownload(payload: Uint8Array): { path: string; size: number } {
	// BEGIN_DOWNLOAD payload: uint32 size + c-string path.
	const size = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
	const filePath = parseCString(payload, 4);
	return {
		path: filePath,
		size
	};
}

function buildSystemReply(opcode: number, status: number, data: Uint8Array = new Uint8Array()): Uint8Array {
	const out = new Uint8Array(2 + data.length);
	out[0] = opcode & 0xff;
	out[1] = status & 0xff;
	out.set(data, 2);
	return out;
}

function executeFakeSystemCommand(ctx: FakeEv3CommandContext, opcode: number, commandPayload: Uint8Array): Uint8Array {
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

async function startFakeEv3TcpServer(): Promise<{
	port: number;
	getRunProgramCommandCount: () => number;
	getAcceptedConnectionCount: () => number;
	close: () => Promise<void>;
}> {
	const sockets = new Set<net.Socket>();
	const capabilityPayload = buildCapabilityReplyPayload();
	let runProgramCommandCount = 0;
	let acceptedConnectionCount = 0;
	const commandContext: FakeEv3CommandContext = {
		fs: new FakeRemoteFsState(),
		uploads: new Map<number, UploadSession>(),
		downloads: new Map<number, DownloadSession>(),
		nextHandle: 1
	};
	const server = net.createServer((socket) => {
		acceptedConnectionCount += 1;
		sockets.add(socket);
		let handshakeComplete = false;
		let receiveBuffer = Buffer.alloc(0);

		socket.on('close', () => {
			sockets.delete(socket);
		});

		socket.on('data', (chunk: Buffer) => {
			if (!handshakeComplete) {
				const text = chunk.toString('utf8');
				if (text.includes('GET /target?sn=')) {
					socket.write('Accept: EV340\r\n\r\n');
					handshakeComplete = true;
				}
				return;
			}

			receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
			while (receiveBuffer.length >= 2) {
				const bodyLength = receiveBuffer.readUInt16LE(0);
				const totalLength = bodyLength + 2;
				if (receiveBuffer.length < totalLength) {
					return;
				}

				const packet = new Uint8Array(receiveBuffer.subarray(0, totalLength));
				receiveBuffer = receiveBuffer.subarray(totalLength);
				const request = decodeEv3Packet(packet);
				let replyType: number = EV3_REPLY.SYSTEM_REPLY;
				let replyPayload: Uint8Array = new Uint8Array();
				if (
					request.type === EV3_COMMAND.SYSTEM_COMMAND_REPLY ||
					request.type === EV3_COMMAND.SYSTEM_COMMAND_NO_REPLY
				) {
					const opcode = request.payload[0] ?? 0x00;
					const commandPayload = request.payload.subarray(1);
					replyPayload = executeFakeSystemCommand(commandContext, opcode, commandPayload);
					replyType = replyPayload[1] === 0x00 || replyPayload[1] === 0x08
						? EV3_REPLY.SYSTEM_REPLY
						: EV3_REPLY.SYSTEM_REPLY_ERROR;
				} else {
					replyType = EV3_REPLY.DIRECT_REPLY;
					const directPayloadText = Buffer.from(request.payload).toString('utf8').toLowerCase();
					if (directPayloadText.includes('.rbf')) {
						runProgramCommandCount += 1;
					}
					replyPayload = Uint8Array.from(capabilityPayload);
				}

				socket.write(Buffer.from(encodeEv3Packet(request.messageCounter, replyType, replyPayload)));
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Fake EV3 TCP server failed to expose listen address.');
	}

	return {
		port: address.port,
		getRunProgramCommandCount: () => runProgramCommandCount,
		getAcceptedConnectionCount: () => acceptedConnectionCount,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}

function startFakeDiscoveryBeacon(discoveryPort: number, tcpPort: number): () => void {
	const socket = dgram.createSocket('udp4');
	const beacon = Buffer.from(
		`Serial-Number: 0016535D7E2D\r\nPort: ${tcpPort}\r\nProtocol: WiFi\r\nName: EV3\r\n\r\n`
	);
	const timer = setInterval(() => {
		socket.send(beacon, discoveryPort, '127.0.0.1');
	}, 80);

	return () => {
		clearInterval(timer);
		socket.close();
	};
}

async function withWorkspaceSettings<T>(
	settings: Record<string, unknown>,
	run: () => Promise<T>
): Promise<T> {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	const previousValues = new Map<string, unknown>();
	const keys = Object.keys(settings);
	const applyOrder = [...keys].sort((a, b) => {
		if (a === 'transport.mode' && b !== 'transport.mode') {
			return 1;
		}
		if (b === 'transport.mode' && a !== 'transport.mode') {
			return -1;
		}
		return 0;
	});
	const restoreOrder = [...applyOrder].reverse();

	for (const key of keys) {
		const inspected = cfg.inspect(key);
		previousValues.set(key, inspected?.workspaceValue);
	}

	for (const key of applyOrder) {
		await cfg.update(key, settings[key], vscode.ConfigurationTarget.Workspace);
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 150));

	try {
		return await run();
	} finally {
		for (const key of restoreOrder) {
			await cfg.update(key, previousValues.get(key), vscode.ConfigurationTarget.Workspace);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 150));
	}
}

async function withReconnectPromptChoice<T>(
	choice: 'Reconnect all' | 'Later',
	run: () => Promise<T>
): Promise<{ result: T; promptCount: number }> {
	type ShowInformationMessageFn = (...args: any[]) => Thenable<any>;
	const windowAny = vscode.window as unknown as {
		showInformationMessage: ShowInformationMessageFn;
	};
	const windowRecord = vscode.window as unknown as Record<string, unknown>;
	const originalShowInformationMessage = windowAny.showInformationMessage;
	let promptCount = 0;
	const patchedShowInformationMessage = ((...args: any[]) => {
		const message = args[0];
		if (typeof message === 'string' && message.startsWith('Connection settings changed. Reconnect ')) {
			promptCount += 1;
			return Promise.resolve(choice);
		}
		return originalShowInformationMessage(...args);
	}) as ShowInformationMessageFn;
	const setShowInformationMessage = (fn: ShowInformationMessageFn): void => {
		try {
			windowAny.showInformationMessage = fn;
		} catch {
			// Fall back to defineProperty below.
		}
		if (windowAny.showInformationMessage === fn) {
			return;
		}
		Object.defineProperty(windowRecord, 'showInformationMessage', {
			value: fn,
			configurable: true,
			writable: true
		});
		if (windowAny.showInformationMessage !== fn) {
			throw new Error('Unable to patch vscode.window.showInformationMessage for host test.');
		}
	};

	setShowInformationMessage(patchedShowInformationMessage);
	const probe = await windowAny.showInformationMessage(
		'Connection settings changed. Reconnect 1 brick(s) now to apply them?',
		'Reconnect all',
		'Later'
	);
	if (probe !== choice) {
		throw new Error('Patched reconnect prompt did not return expected choice in host test.');
	}
	promptCount = 0;
	try {
		const result = await run();
		return {
			result,
			promptCount
		};
	} finally {
		setShowInformationMessage(originalShowInformationMessage);
	}
}

function sameFsPath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const normalized = path.normalize(value);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	return normalize(left) === normalize(right);
}

function sameWorkspaceFolders(
	left: readonly vscode.WorkspaceFolder[] | undefined,
	right: readonly vscode.WorkspaceFolder[] | undefined
): boolean {
	const leftFolders = left ?? [];
	const rightFolders = right ?? [];
	if (leftFolders.length !== rightFolders.length) {
		return false;
	}
	for (let index = 0; index < leftFolders.length; index += 1) {
		if (!sameFsPath(leftFolders[index].uri.fsPath, rightFolders[index].uri.fsPath)) {
			return false;
		}
	}
	return true;
}

async function withTemporaryWorkspaceFolder<T>(
	prepare: (workspaceFsPath: string) => Promise<void>,
	run: (workspaceUri: vscode.Uri) => Promise<T>
): Promise<T> {
	const originalFolders = vscode.workspace.workspaceFolders ?? [];
	const tempRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-host-workspace-'));
	const tempRootUri = vscode.Uri.file(tempRootPath);

	await prepare(tempRootPath);

	let replaced = false;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		replaced =
			vscode.workspace.updateWorkspaceFolders(0, originalFolders.length, {
				uri: tempRootUri,
				name: path.basename(tempRootPath)
			}) ?? false;
		if (replaced) {
			break;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 120));
	}
	assert.equal(replaced, true, 'Expected temporary workspace folder update to succeed.');
	await waitForCondition(
		'temporary workspace folder active',
		() => {
			const folders = vscode.workspace.workspaceFolders;
			return !!folders && folders.length === 1 && sameFsPath(folders[0].uri.fsPath, tempRootPath);
		},
		5_000
	);

	try {
		return await run(tempRootUri);
	} finally {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			if (sameWorkspaceFolders(vscode.workspace.workspaceFolders, originalFolders)) {
				break;
			}

			const currentFolders = vscode.workspace.workspaceFolders ?? [];
			vscode.workspace.updateWorkspaceFolders(
				0,
				currentFolders.length,
				...originalFolders.map((folder) => ({
					uri: folder.uri,
					name: folder.name
				}))
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 150));
		}
		await fs.rm(tempRootPath, {
			recursive: true,
			force: true
		});
	}
}

async function testActivation(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `Extension "${EXTENSION_ID}" is not available in extension host.`);

	await extension.activate();
	assert.equal(extension.isActive, true, 'Extension should be active after activation.');
}

async function testCommandsRegistration(): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	assert.ok(commands.includes('ev3-cockpit.connectEV3'));
	assert.ok(commands.includes('ev3-cockpit.deployAndRunExecutable'));
	assert.ok(commands.includes('ev3-cockpit.previewProjectDeploy'));
	assert.ok(commands.includes('ev3-cockpit.deployProject'));
	assert.ok(commands.includes('ev3-cockpit.previewProjectDeployToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployProjectToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployProjectAndRunExecutableToBrick'));
	assert.ok(commands.includes('ev3-cockpit.previewWorkspaceDeploy'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspace'));
	assert.ok(commands.includes('ev3-cockpit.previewWorkspaceDeployToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick'));
	assert.ok(commands.includes('ev3-cockpit.deployProjectAndRunExecutable'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceAndRunExecutable'));
	assert.ok(commands.includes('ev3-cockpit.applyDeployProfile'));
	assert.ok(commands.includes('ev3-cockpit.applyDeployProfileToBrick'));
	assert.ok(commands.includes('ev3-cockpit.runRemoteProgram'));
	assert.ok(commands.includes('ev3-cockpit.stopProgram'));
	assert.ok(commands.includes('ev3-cockpit.restartProgram'));
	assert.ok(commands.includes('ev3-cockpit.reconnectEV3'));
	assert.ok(commands.includes('ev3-cockpit.disconnectEV3'));
	assert.ok(commands.includes('ev3-cockpit.emergencyStop'));
	assert.ok(commands.includes('ev3-cockpit.inspectTransports'));
	assert.ok(commands.includes('ev3-cockpit.transportHealthReport'));
	assert.ok(commands.includes('ev3-cockpit.inspectBrickSessions'));
	assert.ok(commands.includes('ev3-cockpit.revealInBricksTree'));
	assert.ok(commands.includes('ev3-cockpit.browseRemoteFs'));
	assert.ok(commands.includes('ev3-cockpit.refreshBricksView'));
	assert.ok(commands.includes('ev3-cockpit.setBricksTreeFilter'));
	assert.ok(commands.includes('ev3-cockpit.clearBricksTreeFilter'));
	assert.ok(commands.includes('ev3-cockpit.reconnectReadyBricks'));
	assert.ok(commands.includes('ev3-cockpit.deployWorkspaceToReadyBricks'));
	assert.ok(commands.includes('ev3-cockpit.toggleFavoriteBrick'));
	assert.ok(commands.includes('ev3-cockpit.uploadToBrickFolder'));
	assert.ok(commands.includes('ev3-cockpit.deleteRemoteEntryFromTree'));
	assert.ok(commands.includes('ev3-cockpit.runRemoteExecutableFromTree'));
}

async function testEv3FileSystemProvider(): Promise<void> {
	const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
	const fileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/test.txt');

	let failed = false;
	try {
		await vscode.workspace.fs.readDirectory(directoryUri);
	} catch (error) {
		failed = true;
		const message = error instanceof Error ? error.message : String(error);
		assert.match(
			message,
			/no active ev3 connection|not available|filesystem access/i,
			'Expected ev3:// access to fail with a provider-originated message when no connection is active.'
		);
	}
	assert.equal(failed, true, 'ev3:// readDirectory should fail without active connection.');

	let readFailed = false;
	try {
		await vscode.workspace.fs.readFile(fileUri);
	} catch (error) {
		readFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		assert.match(
			message,
			/no active ev3 connection|not available|filesystem access/i,
			'Expected ev3:// readFile to fail with offline provider message.'
		);
	}
	assert.equal(readFailed, true, 'ev3:// readFile should fail without active connection.');

	let writeFailed = false;
	try {
		await vscode.workspace.fs.writeFile(fileUri, new Uint8Array([0x61]));
	} catch (error) {
		writeFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		assert.match(
			message,
			/read-only|no active ev3 connection|not available/i,
			'Expected ev3:// writeFile to fail as read-only/offline.'
		);
	}
	assert.equal(writeFailed, true, 'ev3:// writeFile should fail without active connection.');
}

async function testMockConnectFlowWiresActiveFsProvider(): Promise<void> {
	await withWorkspaceSettings(
		{
			'transport.mode': 'mock'
		},
		async () => {
			await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3');
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			await vscode.commands.executeCommand('ev3-cockpit.emergencyStop');
			await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');

			const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
			let failed = false;
			try {
				await vscode.workspace.fs.readDirectory(directoryUri);
			} catch (error) {
				failed = true;
				const message = error instanceof Error ? error.message : String(error);
				assert.match(
					message,
					/no active ev3 connection|execution failed|payload|reply|status|unexpected|list/i,
					'Expected provider to fail with either offline connection or protocol-layer error.'
				);
			}
			assert.equal(failed, true, 'Mock transport should not fully emulate FS listing yet.');
		}
	);
}

async function testProviderRejectsNonActiveBrickAuthority(): Promise<void> {
	await withWorkspaceSettings(
		{
			'transport.mode': 'mock'
		},
		async () => {
			await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
			await new Promise<void>((resolve) => setTimeout(resolve, 200));

			let failed = false;
			try {
				await vscode.workspace.fs.readDirectory(vscode.Uri.parse('ev3://brick-2/home/root/lms2012/prjs/'));
			} catch (error) {
				failed = true;
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /not available|brick/i);
			} finally {
				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
			}
			assert.equal(failed, true, 'Provider should reject non-active brick authority in current MVP.');
		}
	);
}

async function testTcpConnectFlowWithMockDiscoveryAndServer(): Promise<void> {
	const fakeServer = await startFakeEv3TcpServer();
	const discoveryPort = 33000 + Math.floor(Math.random() * 1000);
	const stopBeacon = startFakeDiscoveryBeacon(discoveryPort, fakeServer.port);

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '',
				'transport.tcp.useDiscovery': true,
				'transport.tcp.discoveryPort': discoveryPort,
				'transport.tcp.discoveryTimeoutMs': 3000,
				'transport.tcp.handshakeTimeoutMs': 3000
			},
			async () => {
				const tcpBrickId = `tcp-${toSafeIdentifierForTest('active:5555')}`;
				await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				const selectedBrickRoot = {
					kind: 'brick',
					brickId: tcpBrickId,
					displayName: 'EV3 TCP (active)',
					role: 'standalone',
					transport: 'tcp',
					status: 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/'
				};
				await vscode.commands.executeCommand('ev3-cockpit.stopProgram', selectedBrickRoot);
				await vscode.commands.executeCommand('ev3-cockpit.emergencyStop', selectedBrickRoot);
				await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', selectedBrickRoot);
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				await vscode.commands.executeCommand('ev3-cockpit.emergencyStop', selectedBrickRoot);

				const rootUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
				const explicitRootUri = vscode.Uri.parse(`ev3://${tcpBrickId}/home/root/lms2012/prjs/`);
				const sourceUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-source.txt');
				const copyUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-copy.txt');
				const renamedUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-renamed.txt');
				const sourceDirUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir');
				const sourceDirFileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir/nested.txt');
				const copiedDirUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-copy');
				const copiedDirFileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-copy/nested.txt');
				const renamedDirUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-renamed');
				const renamedDirFileUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/host-suite-dir-renamed/nested.txt');
				const blockedUri = vscode.Uri.parse('ev3://active/etc/');

				const explicitListing = await vscode.workspace.fs.readDirectory(explicitRootUri);
				assert.ok(Array.isArray(explicitListing));

				await vscode.workspace.fs.writeFile(sourceUri, Buffer.from('host-suite-data', 'utf8'));
				const readBack = await vscode.workspace.fs.readFile(sourceUri);
				assert.equal(Buffer.from(readBack).toString('utf8'), 'host-suite-data');

				await vscode.workspace.fs.copy(sourceUri, copyUri, { overwrite: false });
				await vscode.workspace.fs.rename(copyUri, renamedUri, { overwrite: false });

				const listingBeforeDelete = await vscode.workspace.fs.readDirectory(rootUri);
				assert.ok(listingBeforeDelete.some(([name]) => name === 'host-suite-source.txt'));
				assert.ok(listingBeforeDelete.some(([name]) => name === 'host-suite-renamed.txt'));

				await vscode.workspace.fs.createDirectory(sourceDirUri);
				await vscode.workspace.fs.writeFile(sourceDirFileUri, Buffer.from('host-suite-dir-data', 'utf8'));
				await vscode.workspace.fs.copy(sourceDirUri, copiedDirUri, { overwrite: false });
				const copiedDirData = await vscode.workspace.fs.readFile(copiedDirFileUri);
				assert.equal(Buffer.from(copiedDirData).toString('utf8'), 'host-suite-dir-data');

				await vscode.workspace.fs.rename(copiedDirUri, renamedDirUri, { overwrite: false });
				const renamedDirData = await vscode.workspace.fs.readFile(renamedDirFileUri);
				assert.equal(Buffer.from(renamedDirData).toString('utf8'), 'host-suite-dir-data');

				await assert.rejects(
					async () => {
						await vscode.workspace.fs.delete(renamedDirUri, { recursive: false, useTrash: false });
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not empty|permissions|not allowed|directory/i);
						return true;
					}
				);

				await vscode.workspace.fs.delete(renamedUri, { recursive: false, useTrash: false });
				await vscode.workspace.fs.delete(sourceUri, { recursive: false, useTrash: false });
				await vscode.workspace.fs.delete(renamedDirUri, { recursive: true, useTrash: false });
				await vscode.workspace.fs.delete(sourceDirUri, { recursive: true, useTrash: false });

				const listingAfterDelete = await vscode.workspace.fs.readDirectory(rootUri);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-source.txt'), false);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-renamed.txt'), false);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-dir'), false);
				assert.equal(listingAfterDelete.some(([name]) => name === 'host-suite-dir-renamed'), false);

				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readDirectory(blockedUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /safe mode|outside safe roots|permissions|blocked/i);
						return true;
					}
				);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', selectedBrickRoot);

				const directoryUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');
				try {
					await vscode.workspace.fs.readDirectory(directoryUri);
					assert.fail('ev3:// readDirectory should fail after disconnect.');
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					assert.match(
						message,
						/no active ev3 connection|execution failed|payload|reply|status|unexpected|list/i,
						'Expected provider to fail with either offline connection or protocol-layer error.'
					);
				}
			}
		);
	} finally {
		stopBeacon();
		await fakeServer.close();
	}
}

async function testWorkspaceDeployCommandsWithMockTcp(): Promise<void> {
	const fakeServer = await startFakeEv3TcpServer();
	const discoveryPort = 34000 + Math.floor(Math.random() * 1000);
	const stopBeacon = startFakeDiscoveryBeacon(discoveryPort, fakeServer.port);

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '',
				'transport.tcp.useDiscovery': true,
				'transport.tcp.discoveryPort': discoveryPort,
				'transport.tcp.discoveryTimeoutMs': 3000,
				'transport.tcp.handshakeTimeoutMs': 3000
			},
			async () => {
				await withTemporaryWorkspaceFolder(
					async (workspaceFsPath) => {
						await fs.mkdir(path.join(workspaceFsPath, 'docs'), {
							recursive: true
						});
						await fs.writeFile(path.join(workspaceFsPath, 'main.rbf'), Buffer.from([0x01, 0x02, 0x03, 0x04]));
						await fs.writeFile(path.join(workspaceFsPath, 'docs', 'notes.txt'), 'workspace-v1\n', 'utf8');
					},
					async (workspaceUri) => {
						await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
						await new Promise<void>((resolve) => setTimeout(resolve, 250));

						const remoteProjectRoot = buildRemoteProjectRoot(workspaceUri.fsPath, '/home/root/lms2012/prjs/');
						const remoteProjectUri = vscode.Uri.parse(`ev3://active${remoteProjectRoot}/`);
						const remoteProgramUri = vscode.Uri.parse(`ev3://active${remoteProjectRoot}/main.rbf`);
						const remoteNotesUri = vscode.Uri.parse(`ev3://active${remoteProjectRoot}/docs/notes.txt`);

						try {
							await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeploy');
							await assert.rejects(
								async () => {
									await vscode.workspace.fs.readDirectory(remoteProjectUri);
								},
								(error: unknown) => {
									const message = error instanceof Error ? error.message : String(error);
									assert.match(message, /not found|path not found|status|directory/i);
									return true;
								}
							);

							await vscode.commands.executeCommand('ev3-cockpit.deployWorkspace');

							const deployedProgramV1 = await vscode.workspace.fs.readFile(remoteProgramUri);
							assert.deepEqual(Array.from(deployedProgramV1), [0x01, 0x02, 0x03, 0x04]);
							const deployedNotesV1 = await vscode.workspace.fs.readFile(remoteNotesUri);
							assert.equal(Buffer.from(deployedNotesV1).toString('utf8'), 'workspace-v1\n');

							await fs.writeFile(path.join(workspaceUri.fsPath, 'main.rbf'), Buffer.from([0x05, 0x06, 0x07, 0x08]));
							await fs.writeFile(path.join(workspaceUri.fsPath, 'docs', 'notes.txt'), 'workspace-v2\n', 'utf8');

							const runCountBefore = fakeServer.getRunProgramCommandCount();
							await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutable');
							const runCountAfter = fakeServer.getRunProgramCommandCount();
							assert.ok(
								runCountAfter > runCountBefore,
								'Expected deployWorkspaceAndRunExecutable to send at least one direct run command.'
							);

							const deployedProgramV2 = await vscode.workspace.fs.readFile(remoteProgramUri);
							assert.deepEqual(Array.from(deployedProgramV2), [0x05, 0x06, 0x07, 0x08]);
							const deployedNotesV2 = await vscode.workspace.fs.readFile(remoteNotesUri);
							assert.equal(Buffer.from(deployedNotesV2).toString('utf8'), 'workspace-v2\n');

							await vscode.workspace.fs.delete(remoteProjectUri, {
								recursive: true,
								useTrash: false
							});
						} finally {
							await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
						}
					}
				);
			}
		);
	} finally {
		stopBeacon();
		await fakeServer.close();
	}
}

async function testMultiBrickSelectedDeployCommandsWithMockTcp(): Promise<void> {
	const fakeServerA = await startFakeEv3TcpServer();
	const fakeServerB = await startFakeEv3TcpServer();

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(workspaceFolder, 'Expected at least one workspace folder for multi-brick host test.');
	const workspaceUri = workspaceFolder.uri;
	const workspaceFsPath = workspaceUri.fsPath;
	const localProgramPath = path.join(workspaceFsPath, 'host-multi-brick-main.rbf');
	const localNotesPath = path.join(workspaceFsPath, 'host-multi-brick-notes.txt');

	await fs.mkdir(workspaceFsPath, { recursive: true });
	await fs.writeFile(localProgramPath, Buffer.from([0x10, 0x11, 0x12, 0x13]));
	await fs.writeFile(localNotesPath, 'multi-brick-v1\n', 'utf8');

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '127.0.0.1',
				'transport.tcp.useDiscovery': false,
				'transport.tcp.handshakeTimeoutMs': 3000,
				'transport.tcp.port': fakeServerA.port,
				'deploy.includeGlobs': ['host-multi-brick-*']
			},
			async () => {
				const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
				const connectWithPort = async (port: number): Promise<void> => {
					await cfg.update('transport.tcp.port', port, vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 150));
					await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
					await new Promise<void>((resolve) => setTimeout(resolve, 250));
				};

				const makeBrickRootNode = (brickId: string) => ({
					kind: 'brick',
					brickId,
					displayName: `EV3 TCP (${brickId})`,
					role: 'standalone',
					transport: 'tcp',
					status: 'READY',
					isActive: false,
					rootPath: '/home/root/lms2012/prjs/'
				});

				const remoteProjectRoot = buildRemoteProjectRoot(workspaceUri.fsPath, '/home/root/lms2012/prjs/');
				const brickAId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerA.port}`)}`;
				const brickBId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerB.port}`)}`;
				const brickANode = makeBrickRootNode(brickAId);
				const brickBNode = makeBrickRootNode(brickBId);

				const brickAProjectUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/`);
				const brickARootUri = vscode.Uri.parse(`ev3://${brickAId}/home/root/lms2012/prjs/`);
				const brickBRootUri = vscode.Uri.parse(`ev3://${brickBId}/home/root/lms2012/prjs/`);
				const brickAProgramUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/host-multi-brick-main.rbf`);
				const brickBProgramUri = vscode.Uri.parse(`ev3://${brickBId}${remoteProjectRoot}/host-multi-brick-main.rbf`);
				const brickAUniqueUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/host-multi-brick-only-a.txt`);
				const brickBUniqueUri = vscode.Uri.parse(`ev3://${brickBId}${remoteProjectRoot}/host-multi-brick-only-a.txt`);

				await connectWithPort(fakeServerA.port);
				await connectWithPort(fakeServerB.port);
				await vscode.workspace.fs.readDirectory(brickARootUri);
				await vscode.workspace.fs.readDirectory(brickBRootUri);

				await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToBrick', brickANode);

				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readDirectory(brickAProjectUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not found|path not found|status|directory/i);
						return true;
					}
				);
				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickANode);

				const brickAProgramV1 = await vscode.workspace.fs.readFile(brickAProgramUri);
				assert.deepEqual(Array.from(brickAProgramV1), [0x10, 0x11, 0x12, 0x13]);
				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readFile(brickBProgramUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not found|path not found|status|file/i);
						return true;
					}
				);

				const runCountABefore = fakeServerA.getRunProgramCommandCount();
				const runCountBBefore = fakeServerB.getRunProgramCommandCount();
				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick', brickANode);
				assert.ok(
					fakeServerA.getRunProgramCommandCount() > runCountABefore,
					'Expected selected-brick deploy+run to target brick A.'
				);
				assert.equal(
					fakeServerB.getRunProgramCommandCount(),
					runCountBBefore,
					'Expected selected-brick deploy+run to not affect brick B.'
				);

				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick', brickBNode);
				const brickBProgramV1 = await vscode.workspace.fs.readFile(brickBProgramUri);
				assert.deepEqual(Array.from(brickBProgramV1), [0x10, 0x11, 0x12, 0x13]);

				await vscode.workspace.fs.writeFile(brickAUniqueUri, Buffer.from('only-on-a', 'utf8'));
				const uniqueOnA = await vscode.workspace.fs.readFile(brickAUniqueUri);
				assert.equal(Buffer.from(uniqueOnA).toString('utf8'), 'only-on-a');
				await assert.rejects(
					async () => {
						await vscode.workspace.fs.readFile(brickBUniqueUri);
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						assert.match(message, /not found|path not found|status|file/i);
						return true;
					}
				);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', brickANode);
				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', brickBNode);
			}
		);
	} finally {
		await fs.rm(localProgramPath, { force: true });
		await fs.rm(localNotesPath, { force: true });
		await fakeServerA.close();
		await fakeServerB.close();
	}
}

async function testBatchCommandsWithMultiBrickMockTcp(): Promise<void> {
	const fakeServerA = await startFakeEv3TcpServer();
	const fakeServerB = await startFakeEv3TcpServer();

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(workspaceFolder, 'Expected workspace folder for batch host test.');
	const workspaceUri = workspaceFolder.uri;
	const workspaceFsPath = workspaceUri.fsPath;
	const localProgramPath = path.join(workspaceFsPath, 'host-batch-main.rbf');
	const localNotesPath = path.join(workspaceFsPath, 'host-batch-notes.txt');

	await fs.mkdir(workspaceFsPath, { recursive: true });
	await fs.writeFile(localProgramPath, Buffer.from([0x21, 0x22, 0x23, 0x24]));
	await fs.writeFile(localNotesPath, 'batch-v1\n', 'utf8');

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '127.0.0.1',
				'transport.tcp.useDiscovery': false,
				'transport.tcp.handshakeTimeoutMs': 3000,
				'transport.tcp.port': fakeServerA.port,
				'deploy.includeGlobs': ['host-batch-*']
			},
			async () => {
				const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
				const connectWithPort = async (port: number): Promise<void> => {
					await cfg.update('transport.tcp.port', port, vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 150));
					await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
					await new Promise<void>((resolve) => setTimeout(resolve, 250));
				};

				const remoteProjectRoot = buildRemoteProjectRoot(workspaceUri.fsPath, '/home/root/lms2012/prjs/');
				const brickAId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerA.port}`)}`;
				const brickBId = `tcp-${toSafeIdentifierForTest(`127.0.0.1:${fakeServerB.port}`)}`;
				const brickARootUri = vscode.Uri.parse(`ev3://${brickAId}/home/root/lms2012/prjs/`);
				const brickBRootUri = vscode.Uri.parse(`ev3://${brickBId}/home/root/lms2012/prjs/`);
				const brickAProgramUri = vscode.Uri.parse(`ev3://${brickAId}${remoteProjectRoot}/host-batch-main.rbf`);
				const brickBProgramUri = vscode.Uri.parse(`ev3://${brickBId}${remoteProjectRoot}/host-batch-main.rbf`);

				await connectWithPort(fakeServerA.port);
				await connectWithPort(fakeServerB.port);
				await vscode.workspace.fs.readDirectory(brickARootUri);
				await vscode.workspace.fs.readDirectory(brickBRootUri);

				await vscode.commands.executeCommand('ev3-cockpit.reconnectReadyBricks', [brickAId, brickBId]);
				await vscode.workspace.fs.readDirectory(brickARootUri);
				await vscode.workspace.fs.readDirectory(brickBRootUri);

				await cfg.update('transport.tcp.host', 'localhost', vscode.ConfigurationTarget.Workspace);
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				await vscode.workspace.fs.readDirectory(brickARootUri);
				await vscode.workspace.fs.readDirectory(brickBRootUri);

				await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToReadyBricks', [brickAId, brickBId]);
				const brickAProgram = await vscode.workspace.fs.readFile(brickAProgramUri);
				const brickBProgram = await vscode.workspace.fs.readFile(brickBProgramUri);
				assert.deepEqual(Array.from(brickAProgram), [0x21, 0x22, 0x23, 0x24]);
				assert.deepEqual(Array.from(brickBProgram), [0x21, 0x22, 0x23, 0x24]);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', {
					kind: 'brick',
					brickId: brickAId,
					displayName: `EV3 TCP (${brickAId})`,
					role: 'standalone',
					transport: 'tcp',
					status: 'READY',
					isActive: false,
					rootPath: '/home/root/lms2012/prjs/'
				});
				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', {
					kind: 'brick',
					brickId: brickBId,
					displayName: `EV3 TCP (${brickBId})`,
					role: 'standalone',
					transport: 'tcp',
					status: 'READY',
					isActive: false,
					rootPath: '/home/root/lms2012/prjs/'
				});
			}
		);
	} finally {
		await fs.rm(localProgramPath, { force: true });
		await fs.rm(localNotesPath, { force: true });
		await fakeServerA.close();
		await fakeServerB.close();
	}
}

async function testConfigChangeReconnectPromptBranchesWithMockTcp(): Promise<void> {
	const fakeServerA = await startFakeEv3TcpServer();
	const fakeServerB = await startFakeEv3TcpServer();

	try {
		await withWorkspaceSettings(
			{
				'transport.mode': 'tcp',
				'transport.timeoutMs': 3000,
				'transport.tcp.host': '127.0.0.1',
				'transport.tcp.useDiscovery': false,
				'transport.tcp.handshakeTimeoutMs': 3000,
				'transport.tcp.port': fakeServerA.port
			},
			async () => {
				const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
				const activeRootUri = vscode.Uri.parse('ev3://active/home/root/lms2012/prjs/');

				await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				await vscode.workspace.fs.readDirectory(activeRootUri);
				assert.ok(
					fakeServerA.getAcceptedConnectionCount() >= 1,
					'Expected initial tcp connect to open at least one socket on server A.'
				);

				const deferredPrompt = await withReconnectPromptChoice('Later', async () => {
					await cfg.update('transport.tcp.port', fakeServerB.port, vscode.ConfigurationTarget.Workspace);
					await new Promise<void>((resolve) => setTimeout(resolve, 350));
				});
				assert.equal(
					deferredPrompt.promptCount,
					1,
					'Expected reconnect prompt to appear once when relevant transport config changes.'
				);
				assert.equal(
					fakeServerB.getAcceptedConnectionCount(),
					0,
					'Expected Later choice to keep existing session without reconnecting to new endpoint.'
				);
				await vscode.workspace.fs.readDirectory(activeRootUri);

				const reconnectPrompt = await withReconnectPromptChoice('Reconnect all', async () => {
					await cfg.update('transport.tcp.host', 'localhost', vscode.ConfigurationTarget.Workspace);
					await waitForCondition(
						'reconnect all should open socket on server B',
						() => fakeServerB.getAcceptedConnectionCount() >= 1,
						6_000
					);
				});
				assert.equal(reconnectPrompt.promptCount, 1, 'Expected reconnect prompt to appear once for reconnect-all branch.');
				await vscode.workspace.fs.readDirectory(activeRootUri);

				await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
			}
		);
	} finally {
		await fakeServerA.close();
		await fakeServerB.close();
	}
}

async function testCommandsWithoutHardware(): Promise<void> {
	await withWorkspaceSettings(
		{
			'transport.mode': 'mock',
			'transport.timeoutMs': 200
		},
		async () => {
			await vscode.commands.executeCommand('ev3-cockpit.deployAndRunExecutable');
			await vscode.commands.executeCommand('ev3-cockpit.previewProjectDeploy');
			await vscode.commands.executeCommand('ev3-cockpit.deployProject');
			await vscode.commands.executeCommand('ev3-cockpit.previewProjectDeployToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployProjectToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployProjectAndRunExecutableToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeploy');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspace');
			await vscode.commands.executeCommand('ev3-cockpit.previewWorkspaceDeployToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutableToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.deployProjectAndRunExecutable');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceAndRunExecutable');
			await vscode.commands.executeCommand('ev3-cockpit.applyDeployProfileToBrick');
			await vscode.commands.executeCommand('ev3-cockpit.runRemoteProgram');
			await vscode.commands.executeCommand('ev3-cockpit.stopProgram');
			await vscode.commands.executeCommand('ev3-cockpit.restartProgram');
			await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3');
			await vscode.commands.executeCommand('ev3-cockpit.emergencyStop');
			await vscode.commands.executeCommand('ev3-cockpit.inspectTransports');
			await vscode.commands.executeCommand('ev3-cockpit.transportHealthReport');
			await vscode.commands.executeCommand('ev3-cockpit.inspectBrickSessions');
			await vscode.commands.executeCommand('ev3-cockpit.revealInBricksTree');
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			assert.ok(workspaceFolder, 'Expected workspace folder for diagnostics report verification.');
			const diagnosticsReportPath = path.join(
				workspaceFolder.uri.fsPath,
				'artifacts',
				'diagnostics',
				'brick-sessions-report.json'
			);
			const diagnosticsReportRaw = await fs.readFile(diagnosticsReportPath, 'utf8');
			const diagnosticsReport = JSON.parse(diagnosticsReportRaw) as {
				generatedAtIso?: string;
				bricks?: unknown[];
				runtimeSessions?: unknown[];
			};
			assert.equal(typeof diagnosticsReport.generatedAtIso, 'string');
			assert.ok(Array.isArray(diagnosticsReport.bricks));
			assert.ok(Array.isArray(diagnosticsReport.runtimeSessions));
			await vscode.commands.executeCommand('ev3-cockpit.browseRemoteFs');
			await vscode.commands.executeCommand('ev3-cockpit.refreshBricksView');
			await vscode.commands.executeCommand('ev3-cockpit.setBricksTreeFilter', 'host-batch');
			await vscode.commands.executeCommand('ev3-cockpit.clearBricksTreeFilter');
			await vscode.commands.executeCommand('ev3-cockpit.reconnectReadyBricks');
			await vscode.commands.executeCommand('ev3-cockpit.deployWorkspaceToReadyBricks');
			await vscode.commands.executeCommand('ev3-cockpit.toggleFavoriteBrick');
			await vscode.commands.executeCommand('ev3-cockpit.uploadToBrickFolder');
			await vscode.commands.executeCommand('ev3-cockpit.deleteRemoteEntryFromTree');
			await vscode.commands.executeCommand('ev3-cockpit.runRemoteExecutableFromTree');
		}
	);
}

async function runCase(name: string, fn: () => Promise<void>): Promise<boolean> {
	const start = Date.now();
	try {
		await fn();
		const elapsed = (Date.now() - start).toFixed(1);
		console.log(`✔ ${name} (${elapsed}ms)`);
		return true;
	} catch (error) {
		const elapsed = (Date.now() - start).toFixed(1);
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		console.error(`✗ ${name} (${elapsed}ms)\n  ${message}`);
		return false;
	}
}

export async function run(): Promise<void> {
	await waitForCondition(
		'extension registration',
		() => vscode.extensions.getExtension(EXTENSION_ID) !== undefined
	);

	const cases: Array<[string, () => Promise<void>]> = [
		['activation', testActivation],
		['commands registration', testCommandsRegistration],
		['commands without hardware', testCommandsWithoutHardware],
		['ev3 filesystem provider offline', testEv3FileSystemProvider],
		['mock connect flow wires active fs provider', testMockConnectFlowWiresActiveFsProvider],
		['provider rejects non-active brick authority', testProviderRejectsNonActiveBrickAuthority],
		['tcp connect flow with mock discovery and server', testTcpConnectFlowWithMockDiscoveryAndServer],
		['workspace deploy commands with mock tcp', testWorkspaceDeployCommandsWithMockTcp],
		['config reconnect prompt branches with mock tcp', testConfigChangeReconnectPromptBranchesWithMockTcp],
		['multi-brick selected deploy commands with mock tcp', testMultiBrickSelectedDeployCommandsWithMockTcp],
		['batch commands with multi-brick mock tcp', testBatchCommandsWithMultiBrickMockTcp],
	];

	let passed = 0;
	let failed = 0;
	for (const [name, fn] of cases) {
		const ok = await runCase(name, fn);
		if (ok) {
			passed += 1;
		} else {
			failed += 1;
		}
	}

	console.log(`\nℹ host tests ${cases.length}`);
	console.log(`ℹ pass ${passed}`);
	console.log(`ℹ fail ${failed}`);

	if (failed > 0) {
		throw new Error(`${failed} host test(s) failed.`);
	}
}
