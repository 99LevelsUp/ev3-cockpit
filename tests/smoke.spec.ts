import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildMockBricksFromConfig } from '../src/mock/mockCatalog';

test('mock bricks config is valid', async () => {
	const configPath = path.resolve(__dirname, '..', 'config', 'mock-bricks.json');
	const raw = await fs.readFile(configPath, 'utf8');
	const parsed = JSON.parse(raw) as unknown;
	const bricks = buildMockBricksFromConfig(parsed);

	const expectedRoles: Record<string, 'master' | 'slave'> = {
		Bender: 'master',
		Marvin: 'master',
		R2D2: 'master',
		SkyNet: 'master',
		T800: 'slave',
		T1000: 'slave'
	};

	const actualNames = bricks.map((entry) => entry.displayName).sort();
	const expectedNames = Object.keys(expectedRoles).sort();
	expect(actualNames).toEqual(expectedNames);

	for (const entry of bricks) {
		expect(entry.role).toBe(expectedRoles[entry.displayName]);
	}
});
