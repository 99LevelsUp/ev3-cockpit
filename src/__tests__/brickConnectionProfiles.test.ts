import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createFakeMemento } from './testHelpers';

async function withProfileModule<T>(
	run: (mod: {
		BrickConnectionProfileStore: new (storage: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> }) => {
			get: (brickId: string) => { displayName: string; rootPath: string; transport: { mode?: string; tcpHost?: string; tcpPort?: number; tcpUseDiscovery?: boolean } } | undefined;
			list: () => Array<{ displayName: string }>;
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
					displayName: string;
					rootPath: string;
					transport: { mode?: string; tcpHost?: string; tcpPort?: number; tcpUseDiscovery?: boolean };
				} | undefined;
				list: () => Array<{ displayName: string }>;
				upsert: (profile: unknown) => Promise<void>;
			};
		};
		return await run(profileModule);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('BrickConnectionProfileStore upsert persists and normalizes values', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento();
		const store = new BrickConnectionProfileStore(memento);

		await store.upsert({
			brickId: ' tcp-a ',
			displayName: ' EV3 A ',
			savedAtIso: '2026-02-09T00:00:00.000Z',
			rootPath: 'home/root/lms2012/prjs',
			transport: {
				mode: 'tcp',
				tcpHost: ' 127.0.0.1 ',
				tcpPort: 5555.7,
				tcpUseDiscovery: true
			}
		});

		const profile = store.get('tcp-a');
		assert.ok(profile);
		assert.equal(profile?.displayName, 'EV3 A');
		assert.equal(profile?.rootPath, '/home/root/lms2012/prjs/');
		assert.equal(profile?.transport.mode, 'tcp');
		assert.equal(profile?.transport.tcpHost, '127.0.0.1');
		assert.equal(profile?.transport.tcpPort, 5555);
		assert.equal(profile?.transport.tcpUseDiscovery, true);
	});
});

test('BrickConnectionProfileStore loads only valid entries from storage', async () => {
	await withProfileModule(async ({ BrickConnectionProfileStore }) => {
		const memento = createFakeMemento({
			'ev3-cockpit.connectionProfiles.v1': {
				profiles: [
					{
						brickId: 'usb-auto',
						displayName: 'EV3 USB',
						savedAtIso: '2026-02-09T00:00:00.000Z',
						rootPath: '/home/root/lms2012/prjs/',
						transport: { mode: 'usb', usbPath: 'auto' }
					},
					{
						invalid: true
					}
				]
			}
		});

		const store = new BrickConnectionProfileStore(memento);
		assert.equal(store.list().length, 1);
		assert.equal(store.get('usb-auto')?.displayName, 'EV3 USB');
	});
});
