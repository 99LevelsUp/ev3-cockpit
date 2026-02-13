import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../diagnostics/logger';
import { buildMockBricksFromConfig, type MockBrickDefinition } from '../mock/mockCatalog';

const RELATIVE_MOCK_BRICKS_PATH = path.join('config', 'mock-bricks.json');

export function readMockBricksConfig(extensionRootPath: string, logger?: Logger): MockBrickDefinition[] {
	const configPath = path.join(extensionRootPath, RELATIVE_MOCK_BRICKS_PATH);
	try {
		const rawText = fs.readFileSync(configPath, 'utf8');
		const parsed = JSON.parse(rawText) as unknown;
		return buildMockBricksFromConfig(parsed);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger?.warn('Mock bricks config fallback to empty list.', {
			configPath,
			reason
		});
		return [];
	}
}
