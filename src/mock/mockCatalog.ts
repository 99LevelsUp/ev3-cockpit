import type { BrickRole } from '../device/brickRegistry';

export interface MockBrickDefinition {
	brickId: string;
	displayName: string;
	role: BrickRole;
	parentDisplayName?: string;
}

export interface MockBrickConfigNode {
	name?: unknown;
	bricks?: unknown;
}

interface MockBrickConfigRoot {
	bricks?: unknown;
}

let cachedMockBricks: MockBrickDefinition[] = [];

export function setMockBricks(bricks: MockBrickDefinition[]): void {
	cachedMockBricks = Array.isArray(bricks) ? bricks : [];
}

export function getMockBricks(): MockBrickDefinition[] {
	return cachedMockBricks;
}

function normalizeName(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function toSafeIdentifier(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized || 'mock';
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function resolveRootNodes(raw: unknown): unknown[] {
	if (Array.isArray(raw)) {
		return raw;
	}
	if (raw && typeof raw === 'object') {
		const root = raw as MockBrickConfigRoot;
		return toArray(root.bricks);
	}
	return [];
}

export function buildMockBricksFromConfig(raw: unknown): MockBrickDefinition[] {
	const roots = resolveRootNodes(raw);
	const results: MockBrickDefinition[] = [];
	const usedIds = new Set<string>();

	const reserveId = (base: string): string => {
		if (!usedIds.has(base)) {
			usedIds.add(base);
			return base;
		}
		let index = 2;
		while (usedIds.has(`${base}-${index}`)) {
			index += 1;
		}
		const next = `${base}-${index}`;
		usedIds.add(next);
		return next;
	};

	const visit = (nodes: unknown[], parentId: string | undefined, parentDisplayName: string | undefined): void => {
		nodes.forEach((node, index) => {
			const record = node as MockBrickConfigNode;
			const name = normalizeName(record?.name) ?? 'Mock';
			const token = toSafeIdentifier(name === 'Mock' ? `mock-${index + 1}` : name);
			const baseId = parentId ? `${parentId}-${token}` : `mock-${token}`;
			const brickId = reserveId(baseId);
			const role: BrickRole = parentId ? 'slave' : 'master';
			results.push({
				brickId,
				displayName: name,
				role,
				parentDisplayName
			});
			const children = toArray(record?.bricks);
			if (children.length > 0) {
				visit(children, brickId, name);
			}
		});
	};

	visit(roots, undefined, undefined);
	return results;
}

export function resolveMockRole(brickId: string): BrickRole {
	const match = cachedMockBricks.find((entry) => entry.brickId === brickId);
	if (match) {
		return match.role;
	}
	if (brickId.startsWith('mock-')) {
		return 'slave';
	}
	return 'standalone';
}

export function resolveMockDisplayName(brickId: string): string {
	const match = cachedMockBricks.find((entry) => entry.brickId === brickId);
	return match?.displayName ?? brickId;
}

export function isMockBrickId(brickId: string): boolean {
	return brickId.startsWith('mock-');
}
