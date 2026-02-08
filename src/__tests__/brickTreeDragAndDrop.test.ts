import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

async function withModule<T>(
	run: (mod: {
		parseUriListPayload: (payload: string) => string[];
		parseTreeDragPayload: (payload: string) => Array<{ kind: string; brickId: string; remotePath: string }>;
		isDirectoryDropIntoSelf: (sourceDirectoryPath: string, destinationDirectoryPath: string) => boolean;
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;
	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return {};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('../ui/brickTreeDragAndDrop') as {
			parseUriListPayload: (payload: string) => string[];
			parseTreeDragPayload: (payload: string) => Array<{ kind: string; brickId: string; remotePath: string }>;
			isDirectoryDropIntoSelf: (sourceDirectoryPath: string, destinationDirectoryPath: string) => boolean;
		};
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('parseUriListPayload returns non-comment URI lines', async () => {
	await withModule(async ({ parseUriListPayload }) => {
		const parsed = parseUriListPayload('# comment\r\nfile:///tmp/a.rbf\r\n\r\nfile:///tmp/b.txt\r\n');
		assert.deepEqual(parsed, ['file:///tmp/a.rbf', 'file:///tmp/b.txt']);
	});
});

test('parseTreeDragPayload filters unsupported entries', async () => {
	await withModule(async ({ parseTreeDragPayload }) => {
		const parsed = parseTreeDragPayload(
			JSON.stringify([
				{ kind: 'file', brickId: 'usb-1', remotePath: '/home/root/lms2012/prjs/a.rbf' },
				{ kind: 'directory', brickId: 'usb-1', remotePath: '/home/root/lms2012/prjs/Demo' },
				{ kind: 'message', brickId: 'usb-1', remotePath: '/ignore' },
				{ kind: 'file', brickId: 1, remotePath: '/ignore' }
			])
		);
		assert.deepEqual(parsed, [
			{ kind: 'file', brickId: 'usb-1', remotePath: '/home/root/lms2012/prjs/a.rbf' },
			{ kind: 'directory', brickId: 'usb-1', remotePath: '/home/root/lms2012/prjs/Demo' }
		]);
	});
});

test('isDirectoryDropIntoSelf detects recursive move target', async () => {
	await withModule(async ({ isDirectoryDropIntoSelf }) => {
		assert.equal(isDirectoryDropIntoSelf('/root/demo', '/root/demo'), true);
		assert.equal(isDirectoryDropIntoSelf('/root/demo', '/root/demo/sub'), true);
		assert.equal(isDirectoryDropIntoSelf('/root/demo', '/root/other'), false);
	});
});
