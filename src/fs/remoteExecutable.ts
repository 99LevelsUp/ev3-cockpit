import * as path from 'node:path';
import type { RemoteFsService } from './remoteFsService';

export interface RemoteFileType {
	readonly id: string;
	readonly extensions: readonly string[];
	matches(remotePath: string): boolean;
}

export interface ExecutableRemoteFileType extends RemoteFileType {
	run(fsService: RemoteFsService, remotePath: string): Promise<void>;
}

export interface RemoteExecutableSpec {
	remotePath: string;
	typeId: string;
}

abstract class ExtensionRemoteFileType implements RemoteFileType {
	public abstract readonly id: string;
	public abstract readonly extensions: readonly string[];

	public matches(remotePath: string): boolean {
		const extension = path.posix.extname(remotePath).toLowerCase();
		return this.extensions.includes(extension);
	}
}

class RbfRemoteFileType extends ExtensionRemoteFileType implements ExecutableRemoteFileType {
	public readonly id = 'rbf';
	public readonly extensions = ['.rbf'] as const;

	public async run(fsService: RemoteFsService, remotePath: string): Promise<void> {
		await fsService.runProgram(remotePath);
	}
}

const EXECUTABLE_TYPES: readonly ExecutableRemoteFileType[] = [new RbfRemoteFileType()];

function resolveExecutableRemoteType(remotePath: string): ExecutableRemoteFileType | undefined {
	return EXECUTABLE_TYPES.find((type) => type.matches(remotePath));
}

export function supportedExecutableExtensions(): string[] {
	return [...new Set(EXECUTABLE_TYPES.flatMap((type) => [...type.extensions]))].sort((a, b) => a.localeCompare(b));
}

export function isRemoteExecutablePath(remotePath: string): boolean {
	return resolveExecutableRemoteType(remotePath) !== undefined;
}

export function assertRemoteExecutablePath(remotePath: string): RemoteExecutableSpec {
	const type = resolveExecutableRemoteType(remotePath);
	if (!type) {
		throw new Error(
			`Unsupported executable file type. Supported extensions: ${supportedExecutableExtensions().join(', ')}.`
		);
	}
	return {
		remotePath,
		typeId: type.id
	};
}

export async function runRemoteExecutable(fsService: RemoteFsService, remotePath: string): Promise<RemoteExecutableSpec> {
	const type = resolveExecutableRemoteType(remotePath);
	if (!type) {
		throw new Error(
			`Unsupported executable file type. Supported extensions: ${supportedExecutableExtensions().join(', ')}.`
		);
	}

	await type.run(fsService, remotePath);
	return {
		remotePath,
		typeId: type.id
	};
}
