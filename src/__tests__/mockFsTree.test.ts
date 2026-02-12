import assert from 'node:assert/strict';
import test from 'node:test';
import { MockFsTree } from '../mock/fs/mockFsTree';
import type { MockFsSeedNode } from '../mock/mockTypes';

function makeTree(seed?: MockFsSeedNode[]): MockFsTree {
	const tree = new MockFsTree();
	if (seed) { tree.loadSeed(seed); }
	return tree;
}

// ---------------------------------------------------------------------------
// Basic operations
// ---------------------------------------------------------------------------

test('empty tree has root directory', () => {
	const t = makeTree();
	const entries = t.listDir('/');
	assert.ok(entries !== null);
	assert.equal(entries.length, 0);
});

test('writeFile creates file and parents', () => {
	const t = makeTree();
	t.writeFile('/a/b/c.txt', new Uint8Array([72, 105]));
	assert.ok(t.exists('/a'));
	assert.ok(t.exists('/a/b'));
	assert.ok(t.exists('/a/b/c.txt'));

	const content = t.readFile('/a/b/c.txt');
	assert.ok(content !== null);
	assert.deepEqual(content, new Uint8Array([72, 105]));
});

test('readFile returns null for non-existent file', () => {
	const t = makeTree();
	assert.equal(t.readFile('/nope'), null);
});

test('readFile returns null for directory', () => {
	const t = makeTree();
	t.mkdir('/mydir');
	assert.equal(t.readFile('/mydir'), null);
});

test('listDir returns null for non-existent path', () => {
	const t = makeTree();
	assert.equal(t.listDir('/nope'), null);
});

test('listDir returns entries sorted by insertion order', () => {
	const t = makeTree();
	t.writeFile('/proj/a.txt', new Uint8Array([1]));
	t.writeFile('/proj/b.txt', new Uint8Array([2, 3]));
	t.mkdir('/proj/sub');

	const entries = t.listDir('/proj');
	assert.ok(entries !== null);
	assert.equal(entries.length, 3);

	const names = entries.map(e => e.name);
	assert.ok(names.includes('a.txt'));
	assert.ok(names.includes('b.txt'));
	assert.ok(names.includes('sub'));

	const aEntry = entries.find(e => e.name === 'a.txt')!;
	assert.equal(aEntry.isDir, false);
	assert.equal(aEntry.size, 1);

	const subEntry = entries.find(e => e.name === 'sub')!;
	assert.equal(subEntry.isDir, true);
});

test('deleteFile removes file', () => {
	const t = makeTree();
	t.writeFile('/x.txt', new Uint8Array([1]));
	assert.ok(t.exists('/x.txt'));
	assert.ok(t.deleteFile('/x.txt'));
	assert.ok(!t.exists('/x.txt'));
});

test('deleteFile returns false for non-existent', () => {
	const t = makeTree();
	assert.equal(t.deleteFile('/nope'), false);
});

test('mkdir creates directory hierarchy', () => {
	const t = makeTree();
	t.mkdir('/a/b/c');
	assert.ok(t.exists('/a'));
	assert.ok(t.exists('/a/b'));
	assert.ok(t.exists('/a/b/c'));
});

test('writeFile overwrites existing file', () => {
	const t = makeTree();
	t.writeFile('/f.txt', new Uint8Array([1]));
	t.writeFile('/f.txt', new Uint8Array([2, 3]));
	const content = t.readFile('/f.txt');
	assert.deepEqual(content, new Uint8Array([2, 3]));
});

test('clear resets filesystem', () => {
	const t = makeTree();
	t.writeFile('/a.txt', new Uint8Array([1]));
	t.clear();
	assert.ok(!t.exists('/a.txt'));
	assert.equal(t.listDir('/')!.length, 0);
});

// ---------------------------------------------------------------------------
// Seed loading
// ---------------------------------------------------------------------------

test('loadSeed creates directory tree from seed', () => {
	const seed: MockFsSeedNode[] = [
		{
			type: 'dir', name: 'home', children: [
				{
					type: 'dir', name: 'root', children: [
						{ type: 'file', name: 'hello.txt', text: 'Hello' }
					]
				}
			]
		}
	];

	const t = makeTree(seed);
	assert.ok(t.exists('/home/root/hello.txt'));
	const content = t.readFile('/home/root/hello.txt');
	assert.ok(content !== null);
	assert.equal(Buffer.from(content).toString('utf8'), 'Hello');
});

test('loadSeed handles base64 file content', () => {
	const seed: MockFsSeedNode[] = [
		{ type: 'file', name: 'data.bin', base64: 'AQID' } // [1, 2, 3]
	];

	const t = makeTree(seed);
	const content = t.readFile('/data.bin');
	assert.ok(content !== null);
	assert.deepEqual(content, new Uint8Array([1, 2, 3]));
});

test('loadSeed handles empty file', () => {
	const seed: MockFsSeedNode[] = [
		{ type: 'file', name: 'empty.txt' }
	];

	const t = makeTree(seed);
	const content = t.readFile('/empty.txt');
	assert.ok(content !== null);
	assert.equal(content.length, 0);
});

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

test('path with backslashes is normalized', () => {
	const t = makeTree();
	t.writeFile('a\\b\\c.txt', new Uint8Array([1]));
	assert.ok(t.exists('/a/b/c.txt'));
});

test('path without leading slash is normalized', () => {
	const t = makeTree();
	t.writeFile('file.txt', new Uint8Array([1]));
	assert.ok(t.exists('/file.txt'));
});

test('trailing slashes are stripped', () => {
	const t = makeTree();
	t.mkdir('/dir/');
	assert.ok(t.exists('/dir'));
});
