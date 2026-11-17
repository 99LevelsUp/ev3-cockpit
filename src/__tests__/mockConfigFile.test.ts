/**
 * The simulated bricks a workspace defines for itself (IMPLEMENTATION_PLAN 1.6.10): a missing file
 * keeps the built-in set; a broken one keeps it too and says why.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { MOCK_CONFIG_FILE, loadMockConfigFile } from '../mock';

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

	it('says why a file that cannot be read was not used, and does not look further', () => {
		const result = loadMockConfigFile([ROOT, OTHER], (file) => {
			if (file.startsWith(ROOT)) { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }
			return JSON.stringify({ transport: 'mock', bricks: [brick] });
		});
		assert.equal(result.kind, 'invalid');
		assert.match(result.kind === 'invalid' ? result.reason : '', /cannot be read/);
	});
});
