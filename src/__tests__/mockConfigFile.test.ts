/**
 * The simulated bricks a workspace defines for itself (IMPLEMENTATION_PLAN 1.6.10): a missing file
 * keeps the built-in set; a broken one keeps it too and says why.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_MOCK_CONFIG, MOCK_CONFIG_FILE, loadMockConfigFile, validateMockConfig } from '../core/mock';

const notThere = (): never => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); };
const files = (byPath: Record<string, string>) => (file: string): string => {
	if (file in byPath) { return byPath[file]; }
	return notThere();
};
const brick = { id: 'sim-1', displayName: 'SIM1', battery: { level: 80 }, motorPorts: [], sensorPorts: [] };
const ROOT = path.join('ws', 'one');
const OTHER = path.join('ws', 'two');

describe('Mock bricks from the workspace (1.6.10)', () => {
	it('keeps the built-in set when no folder has the file', () => {
		assert.deepEqual(loadMockConfigFile([ROOT, OTHER], notThere), { kind: 'absent' });
	});

	it('loads the first folder\'s file that exists', () => {
		const result = loadMockConfigFile([ROOT, OTHER], files({
			[path.join(OTHER, MOCK_CONFIG_FILE)]: JSON.stringify({ transport: 'mock', bricks: [brick] }),
		}));
		assert.equal(result.kind, 'loaded');
		assert.equal(result.kind === 'loaded' && result.config.bricks[0].displayName, 'SIM1');
		assert.equal(result.kind === 'loaded' && result.file, path.join(OTHER, MOCK_CONFIG_FILE));
	});

	it('says why a file that is not JSON was not used', () => {
		const result = loadMockConfigFile([ROOT], files({ [path.join(ROOT, MOCK_CONFIG_FILE)]: '{ bricks: [' }));
		assert.equal(result.kind, 'invalid');
		assert.match(result.kind === 'invalid' ? result.reason : '', /not valid JSON/);
	});

	it('says why a file that fails the schema was not used', () => {
		const result = loadMockConfigFile([ROOT], files({
			[path.join(ROOT, MOCK_CONFIG_FILE)]: JSON.stringify({ transport: 'mock', bricks: [{ ...brick, battery: { level: 140 } }] }),
		}));
		assert.equal(result.kind, 'invalid');
		assert.match(result.kind === 'invalid' ? result.reason : '', /battery\.level/);
	});

	it('refuses what a hand-written file can get wrong beyond the required fields (review)', () => {
		const broken: Record<string, unknown>[] = [
			{ ...brick, filesystem: {} },
			{ ...brick, bluetoothPeers: 42 },
			{ ...brick, error: null },
			{ ...brick, loss: { enabled: true, visibleMs: -1, hiddenMs: 100 } },
			{ ...brick, loss: { enabled: true, visibleMs: 0, hiddenMs: 0 } },
			{ ...brick, sensorPorts: [{ port: '1', dynamic: { kind: 'sine' } }] },
			{ ...brick, sensorPorts: [{ port: '1', dynamic: { kind: 'square', low: 0, high: 1, periodMs: -5 } }] },
			{ ...brick, parentId: 'nobody' },
		];
		for (const bad of broken) {
			const result = loadMockConfigFile([ROOT], files({ [path.join(ROOT, MOCK_CONFIG_FILE)]: JSON.stringify({ transport: 'mock', bricks: [bad] }) }));
			assert.equal(result.kind, 'invalid', `accepted ${JSON.stringify(bad)}`);
		}
		const twice = loadMockConfigFile([ROOT], files({ [path.join(ROOT, MOCK_CONFIG_FILE)]: JSON.stringify({ transport: 'mock', bricks: [brick, brick] }) }));
		assert.match(twice.kind === 'invalid' ? twice.reason : '', /twice/);
	});

	it('still takes the built-in set', () => {
		assert.doesNotThrow(() => validateMockConfig(DEFAULT_MOCK_CONFIG));
	});

	it('takes a daisy chain only as a USB chain is built: one brick per layer, no loop, at most three below the master', () => {
		const chained = (id: string, parentId?: string) => ({ ...brick, id, ...(parentId ? { parentId } : {}) });
		const check = (bricks: unknown[]) => { try { validateMockConfig({ transport: 'mock', bricks }); return ''; } catch (e) { return (e as Error).message; } };

		assert.equal(check([chained('M'), chained('A', 'M'), chained('B', 'A'), chained('C', 'B')]), '', 'three below the master');
		assert.match(check([chained('M'), chained('A', 'M'), chained('B', 'M')]), /"M".*one brick/);
		assert.match(check([chained('A', 'B'), chained('B', 'A')]), /loop/);
		assert.match(check([chained('M'), chained('A', 'M'), chained('B', 'A'), chained('C', 'B'), chained('D', 'C')]), /"D".*three/);
	});

	it('says why a file that cannot be read was not used, and does not look further', () => {
		const result = loadMockConfigFile([ROOT, OTHER], (file) => {
			if (file.startsWith(ROOT)) { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }
			return JSON.stringify({ transport: 'mock', bricks: [brick] });
		});
		assert.equal(result.kind, 'invalid');
		assert.match(result.kind === 'invalid' ? result.reason : '', /cannot be read/);
	});
});
