import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createFakeMemento } from './testHelpers';

async function withProfileModule<T>(
	run: (mod: {
		BrickConnectionProfileStore: new (storage: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> }) => {
			get: (brickId: string) => { brickId: string; displayName: string; rootPath: string; transport: { mode?: string; tcpHost?: string; tcpPort?: number; btPort?: string; usbPath?: string; tcpUseDiscovery?: boolean; tcpSerialNumber?: string } } | undefined;
			list: () => Array<{ brickId: string; displayName: string }>;
			upsert: (profile: unknown) => Promise<void>;
		};
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;

	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return {
				workspace: {
					getConfiguration: () => ({
						get: () => undefined
					})
				}
			};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const profileModule = require('../device/brickConnectionProfiles') as {
			BrickConnectionProfileStore: new (storage: {
				get<T>(key: string): T | undefined;
				update(key: string, value: unknown): Promise<void>;
			}) => {
				get: (brickId: string) => {
					brickId: string;
					displayName: string;
					rootPath: string;
					transport: { mode?: string; tcpHost?: string; tcpPort?: number; btPort?: string; usbPath?: string; tcpUseDiscovery?: boolean; tcpSerialNumber?: string };
				} | undefined;
				list: () => Array<{ brickId: string; displayName: string }>;
				upsert: (profile: unknown) => Promise<void>;
			};
		};
		return await run(profileModule);
	} finally {
		moduleAny._load = originalLoad;
	}
}

// --- Profile store edge cases ---

test('BrickConnectionProfileStore ignores upsert with empty brickId', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		await store.upsert({
			brickId: '   ',
			displayName: 'Ghost',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: '/home/',
			transport: { mode: 'usb' }
		});
		assert.equal(store.list().length, 0);
	});
});

test('BrickConnectionProfileStore sanitizes transport mode to usb for invalid value', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		await store.upsert({
			brickId: 'brick-1',
			displayName: 'Test',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: '/home/',
			transport: { mode: 'invalid-mode' }
		});
		const profile = store.get('brick-1');
		assert.ok(profile);
		assert.equal(profile.transport.mode, 'usb');
	});
});

test('BrickConnectionProfileStore normalizes rootPath with missing slashes', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		await store.upsert({
			brickId: 'brick-2',
			displayName: 'EV3 B',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: 'home/root',
			transport: { mode: 'usb' }
		});
		const profile = store.get('brick-2');
		assert.ok(profile);
		assert.equal(profile.rootPath, '/home/root/');
	});
});

test('BrickConnectionProfileStore clamps negative tcpPort to 1', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		await store.upsert({
			brickId: 'brick-3',
			displayName: 'EV3 C',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: '/',
			transport: { mode: 'tcp', tcpPort: -5 }
		});
		const profile = store.get('brick-3');
		assert.ok(profile);
		assert.equal(profile.transport.tcpPort, 1);
	});
});

test('BrickConnectionProfileStore list returns sorted by displayName', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		await store.upsert({
			brickId: 'z-brick',
			displayName: 'Zeta Brick',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: '/',
			transport: { mode: 'usb' }
		});
		await store.upsert({
			brickId: 'a-brick',
			displayName: 'Alpha Brick',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: '/',
			transport: { mode: 'usb' }
		});
		const list = store.list();
		assert.equal(list.length, 2);
		assert.equal(list[0].displayName, 'Alpha Brick');
		assert.equal(list[1].displayName, 'Zeta Brick');
	});
});

test('BrickConnectionProfileStore trims string fields in transport', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		await store.upsert({
			brickId: 'brick-4',
			displayName: '  EV3 D  ',
			savedAtIso: '2026-01-01T00:00:00.000Z',
			rootPath: '/home/',
			transport: {
				mode: 'bt',
				btPort: '  COM5  ',
				usbPath: '  /dev/hidraw0  ',
				tcpHost: '  192.168.1.1  ',
				tcpSerialNumber: '  ABC123  '
			}
		});
		const profile = store.get('brick-4');
		assert.ok(profile);
		assert.equal(profile.displayName, 'EV3 D');
		assert.equal(profile.transport.btPort, 'COM5');
		assert.equal(profile.transport.usbPath, '/dev/hidraw0');
		assert.equal(profile.transport.tcpHost, '192.168.1.1');
		assert.equal(profile.transport.tcpSerialNumber, 'ABC123');
	});
});

test('BrickConnectionProfileStore get returns undefined for missing brickId', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);
		assert.equal(store.get('nonexistent'), undefined);
	});
});
