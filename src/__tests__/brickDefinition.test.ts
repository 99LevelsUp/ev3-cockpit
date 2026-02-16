import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	BrickSnapshot,
	BrickDefinitionNode,
	BrickFilesystemNode,
	BrickFilesystemDir,
	BrickFilesystemFile
} from '../device/brickDefinition';

test('BrickSnapshot satisfies BrickDefinitionNode', () => {
	const snapshot: BrickSnapshot = {
		brickId: 'ev3-001',
		displayName: 'My EV3',
		transport: 'usb',
		capturedAtIso: new Date().toISOString()
	};
	const node: BrickDefinitionNode = snapshot;
	assert.equal(node.name, undefined);
});

test('minimal BrickSnapshot has brickId', () => {
	const snapshot: BrickSnapshot = {
		brickId: 'ev3-002',
		displayName: 'Test Brick',
		transport: 'tcp',
		capturedAtIso: '2025-01-01T00:00:00Z'
	};
	assert.equal(snapshot.brickId, 'ev3-002');
	assert.equal(snapshot.displayName, 'Test Brick');
});

test('BrickFilesystemNode union accepts dir and file', () => {
	const file: BrickFilesystemFile = { type: 'file', name: 'main.py' };
	const dir: BrickFilesystemDir = { type: 'dir', name: 'projects', children: [file] };

	const nodes: BrickFilesystemNode[] = [dir, file];
	assert.equal(nodes.length, 2);
	assert.equal(nodes[0].type, 'dir');
	assert.equal(nodes[1].type, 'file');
});
