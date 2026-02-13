import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildMockBricksFromConfig } from '../src/mock/mockCatalog';

test('mock bricks config is valid', async () => {
	const configPath = path.resolve(__dirname, '..', 'config', 'mock-bricks.json');
	const raw = await fs.readFile(configPath, 'utf8');
	const parsed = JSON.parse(raw) as unknown;
	const bricks = buildMockBricksFromConfig(parsed);

	expect(bricks.map((entry) => entry.displayName)).toEqual([
		'Mock 1',
		'Mock 1.1',
		'Mock 1.1.1',
		'Mock 2',
		'Mock 2.1',
		'Mock 2.2',
		'Mock 3'
	]);

	expect(bricks.map((entry) => entry.role)).toEqual([
		'master',
		'slave',
		'slave',
		'master',
		'slave',
		'slave',
		'master'
	]);
});
