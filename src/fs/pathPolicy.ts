import { ExtensionError } from '../errors/ExtensionError';
import { FsMode } from '../config/featureConfig';

const HARD_BLOCK_PREFIXES = ['/proc', '/sys', '/dev'];
const SAFE_BLOCK_PREFIXES = ['/boot', '/etc', '/bin', '/sbin', '/usr', '/var'];

export interface FsPolicyConfig {
	mode: FsMode;
	safeRoots: string[];
}

export interface FsAccessDecision {
	allowed: boolean;
	normalizedPath: string;
	reason?: string;
	asciiSafe: boolean;
}

function hasPrefixPath(path: string, prefix: string): boolean {
	if (path === prefix) {
		return true;
	}
	return path.startsWith(`${prefix}/`);
}

function normalizePrefix(prefix: string): string {
	const normalized = canonicalizeEv3Path(prefix);
	if (normalized === '/') {
		return normalized;
	}
	return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function canonicalizeEv3Path(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		throw new Error('Path must be non-empty.');
	}

	const unified = trimmed.replace(/\\/g, '/');
	const absolute = unified.startsWith('/') ? unified : `/${unified}`;
	const hasTrailingSlash = absolute.length > 1 && absolute.endsWith('/');

	const segments = absolute.split('/');
	const stack: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (stack.length === 0) {
				throw new Error(`Path escapes root via '..': "${rawPath}".`);
			}
			stack.pop();
			continue;
		}
		stack.push(segment);
	}

	if (stack.length === 0) {
		return '/';
	}

	const normalized = `/${stack.join('/')}`;
	return hasTrailingSlash ? `${normalized}/` : normalized;
}

export function isAsciiSafePath(path: string): boolean {
	return /^[\x20-\x7E]+$/.test(path);
}

export class PathPolicyError extends ExtensionError {
	public constructor(message: string) {
		super('PATH_POLICY', message);
		this.name = 'PathPolicyError';
	}
}

export function evaluateFsAccess(rawPath: string, config: FsPolicyConfig): FsAccessDecision {
	const normalizedPath = canonicalizeEv3Path(rawPath);
	const pathPrefix = normalizePrefix(normalizedPath);
	const asciiSafe = isAsciiSafePath(normalizedPath);

	for (const blocked of HARD_BLOCK_PREFIXES) {
		if (hasPrefixPath(pathPrefix, blocked)) {
			return {
				allowed: false,
				normalizedPath,
				reason: `Path "${normalizedPath}" is blocked (${blocked}).`,
				asciiSafe
			};
		}
	}

	if (config.mode === 'full') {
		return {
			allowed: true,
			normalizedPath,
			asciiSafe
		};
	}

	for (const blocked of SAFE_BLOCK_PREFIXES) {
		if (hasPrefixPath(pathPrefix, blocked)) {
			return {
				allowed: false,
				normalizedPath,
				reason: `Path "${normalizedPath}" is not allowed in safe mode.`,
				asciiSafe
			};
		}
	}

	const safeRoots = config.safeRoots.map(normalizePrefix);
	const insideAllowedRoot = safeRoots.some((root) => {
		if (root === '/') {
			return true;
		}
		return hasPrefixPath(pathPrefix, root);
	});

	if (!insideAllowedRoot) {
		return {
			allowed: false,
			normalizedPath,
			reason: `Path "${normalizedPath}" is outside safe roots.`,
			asciiSafe
		};
	}

	return {
		allowed: true,
		normalizedPath,
		asciiSafe
	};
}
