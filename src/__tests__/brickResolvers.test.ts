import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

interface LoggerMock {
	info: string[];
	warn: string[];
	error: string[];
	debug: string[];
	trace: string[];
}

interface BrickSnapshotLike {
	status: string;
	rootPath?: string;
}

interface BrickRegistryMock {
	getActiveBrickId: () => string | undefined;
	resolveFsService: (brickId: string) => unknown;
	resolveControlService: (brickId: string) => unknown;
	getSnapshot: (brickId: string) => BrickSnapshotLike | undefined;
}

interface ConfigInspectMock {
	workspaceFolderValue?: unknown;
	workspaceValue?: unknown;
}

interface ScaffoldOptions {
	activeBrickId?: string;
	fsServices?: Record<string, unknown>;
	controlServices?: Record<string, unknown>;
	snapshots?: Record<string, BrickSnapshotLike>;
	configValues?: Record<string, unknown>;
	configInspect?: ConfigInspectMock;
	schedulerTimeoutMs?: number;
	featureDefaultRoots?: string[];
	warningChoice?: string;
	assertRemoteExecutablePath?: (remotePath: string) => void;
}

interface ScaffoldState {
	readonly logger: LoggerMock;
	readonly configUpdates: Array<{ key: string; value: unknown; target: unknown }>;
	readonly warningCalls: Array<{ message: string; options: { modal: boolean } }>;
}

interface BrickResolversModule {
	createBrickResolvers: (deps: { brickRegistry: BrickRegistryMock; getLogger: () => LoggerMock }) => {
		resolveProbeTimeoutMs: () => number;
		resolveCurrentTransportMode: () => string;
		resolveConnectedBrickDescriptor: (
			rootPath: string,
			profile?: {
				displayName?: string;
				transport: { mode: 'usb' | 'bluetooth' | 'tcp' | 'mock'; tcpHost?: string; tcpPort?: number; bluetoothPort?: string; usbPath?: string };
				rootPath?: string;
			}
		) => { brickId: string; displayName: string; transport: string; rootPath: string };
		resolveConcreteBrickId: (brickId: string) => string;
		resolveBrickIdFromCommandArg: (arg: unknown) => string;
		resolveFsAccessContext: (arg: unknown) => { brickId: string; authority: string; fsService: unknown } | { error: string };
		resolveControlAccessContext: (
			arg: unknown
		) => { brickId: string; authority: string; controlService: unknown } | { error: string };
		resolveDeployTargetFromArg: (arg: unknown) =>
			| { brickId: string; authority: string; rootPath?: string; fsService: unknown }
			| { error: string };
		normalizeRunExecutablePath: (input: string) => string;
		resolveDefaultRunDirectory: (brickId: string) => string;
		resolveFsModeTarget: () => unknown;
		ensureFullFsModeConfirmation: () => Promise<boolean>;
	};
}

function createLoggerMock(): LoggerMock {
	return {
		info: [],
		warn: [],
		error: [],
		debug: [],
		trace: []
	};
}

function createBrickRegistryMock(options: ScaffoldOptions): BrickRegistryMock {
	const activeBrickId = options.activeBrickId;
	const fsServices = options.fsServices ?? {};
	const controlServices = options.controlServices ?? {};
	const snapshots = options.snapshots ?? {};

	const resolveConcrete = (brickId: string): string =>
		brickId === 'active' ? activeBrickId ?? brickId : brickId;

	return {
		getActiveBrickId: () => activeBrickId,
		resolveFsService: (brickId: string) => fsServices[resolveConcrete(brickId)],
		resolveControlService: (brickId: string) => controlServices[resolveConcrete(brickId)],
		getSnapshot: (brickId: string) => snapshots[resolveConcrete(brickId)]
	};
}

function createScaffold(options: ScaffoldOptions): {
	deps: { brickRegistry: BrickRegistryMock; getLogger: () => LoggerMock };
	state: ScaffoldState;
	vscodeMock: unknown;
} {
	const logger = createLoggerMock();
	const brickRegistry = createBrickRegistryMock(options);
	const configValues: Record<string, unknown> = {
		'transport.mode': 'usb',
		'transport.bluetooth.probeTimeoutMs': 8_000,
		'fs.mode': 'safe',
		'fs.fullMode.confirmationRequired': true,
		'transport.tcp.host': '',
		'transport.tcp.port': 5555,
		'transport.bluetooth.port': '',
		'transport.usb.path': '',
		...(options.configValues ?? {})
	};
	const configUpdates: Array<{ key: string; value: unknown; target: unknown }> = [];
	const warningCalls: Array<{ message: string; options: { modal: boolean } }> = [];

	const configuration = {
		get: (key: string, fallback?: unknown): unknown => (key in configValues ? configValues[key] : fallback),
		inspect: (_key: string): ConfigInspectMock => options.configInspect ?? {},
		update: async (key: string, value: unknown, target: unknown): Promise<void> => {
			configUpdates.push({ key, value, target });
			configValues[key] = value;
		}
	};

	const vscodeMock = {
		workspace: {
			getConfiguration: () => configuration
		},
		window: {
			showWarningMessage: async (message: string, warningOptions: { modal: boolean }): Promise<string | undefined> => {
				warningCalls.push({ message, options: warningOptions });
				return options.warningChoice;
			}
		},
		Uri: {
			parse: (value: string): { path: string; toString: () => string } => {
				const match = /^[^:]+:\/\/[^/]*(\/.*)$/i.exec(value);
				return {
					path: match?.[1] ?? '/',
					toString: () => value
				};
			}
		},
		ConfigurationTarget: {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3
		}
	};

	return {
		deps: {
			brickRegistry,
			getLogger: () => ({
				info: (message: string) => logger.info.push(message),
				warn: (message: string) => logger.warn.push(message),
				error: (message: string) => logger.error.push(message),
				debug: (message: string) => logger.debug.push(message),
				trace: (message: string) => logger.trace.push(message)
			}) as unknown as LoggerMock
		},
		state: {
			logger,
			configUpdates,
			warningCalls
		},
		vscodeMock
	};
}

async function withMockedBrickResolvers<T>(
	options: ScaffoldOptions,
	run: (context: {
		module: BrickResolversModule;
		deps: { brickRegistry: BrickRegistryMock; getLogger: () => LoggerMock };
		state: ScaffoldState;
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;
	const scaffold = createScaffold(options);
	const modulePath = require.resolve('../activation/brickResolvers');

	delete require.cache[modulePath];
	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return scaffold.vscodeMock;
		}
		if (request === '../config/schedulerConfig') {
			return {
				readSchedulerConfig: () => ({
					timeoutMs: options.schedulerTimeoutMs ?? 2_000
				})
			};
		}
		if (request === '../config/featureConfig') {
			return {
				readFeatureConfig: () => ({
					fs: {
						defaultRoots: options.featureDefaultRoots ?? ['/home/root/lms2012/prjs/']
					}
				})
			};
		}
		if (request === '../fs/remoteExecutable') {
			return {
				assertRemoteExecutablePath: (remotePath: string): void => {
					options.assertRemoteExecutablePath?.(remotePath);
				}
			};
		}
		if (request === '../ui/brickTreeProvider') {
			return {
				isBrickRootNode: (value: unknown) => Boolean(value && typeof value === 'object' && (value as { kind?: string }).kind === 'brick'),
				isBrickDirectoryNode: (value: unknown) =>
					Boolean(value && typeof value === 'object' && (value as { kind?: string }).kind === 'directory'),
				isBrickFileNode: (value: unknown) => Boolean(value && typeof value === 'object' && (value as { kind?: string }).kind === 'file')
			};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const module = require('../activation/brickResolvers') as BrickResolversModule;
		return await run({
			module,
			deps: scaffold.deps,
			state: scaffold.state
		});
	} finally {
		moduleAny._load = originalLoad;
		delete require.cache[modulePath];
	}
}

test('brickResolvers scaffold initializes module with controlled mocks', async () => {
	await withMockedBrickResolvers(
		{
			activeBrickId: 'usb-main',
			schedulerTimeoutMs: 1500
		},
		async ({ module, deps, state }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.equal(typeof resolvers.resolveProbeTimeoutMs, 'function');
			assert.equal(typeof resolvers.resolveFsAccessContext, 'function');
			assert.equal(resolvers.resolveProbeTimeoutMs(), 1500);
			assert.equal(resolvers.resolveConcreteBrickId('active'), 'usb-main');
			assert.equal(resolvers.resolveDefaultRunDirectory('active'), '/home/root/lms2012/prjs/');
			assert.equal(state.warningCalls.length, 0);
		}
	);
});

test('brickResolvers resolves active FS/control/deploy contexts in success path', async () => {
	const fsService = { id: 'fs-main' };
	const controlService = { id: 'control-main' };

	await withMockedBrickResolvers(
		{
			activeBrickId: 'usb-main',
			fsServices: { 'usb-main': fsService },
			controlServices: { 'usb-main': controlService },
			snapshots: {
				'usb-main': {
					status: 'READY',
					rootPath: '/home/root/lms2012/prjs/'
				}
			}
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);

			const fsContext = resolvers.resolveFsAccessContext('active');
			assert.deepEqual(fsContext, {
				brickId: 'usb-main',
				authority: 'active',
				fsService
			});

			const controlContext = resolvers.resolveControlAccessContext('active');
			assert.deepEqual(controlContext, {
				brickId: 'usb-main',
				authority: 'active',
				controlService
			});

			const deployContext = resolvers.resolveDeployTargetFromArg('active');
			assert.deepEqual(deployContext, {
				brickId: 'usb-main',
				authority: 'active',
				rootPath: '/home/root/lms2012/prjs/',
				fsService
			});
		}
	);
});

test('brickResolvers resolves brick id from string and tree node args', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.equal(resolvers.resolveBrickIdFromCommandArg(' brick-x '), 'brick-x');
		assert.equal(resolvers.resolveBrickIdFromCommandArg({ kind: 'brick', brickId: 'brick-root', rootPath: '/home/root/lms2012/prjs/' }), 'brick-root');
		assert.equal(
			resolvers.resolveBrickIdFromCommandArg({
				kind: 'directory',
				brickId: 'brick-dir',
				remotePath: '/home/root/lms2012/prjs/Demo'
			}),
			'brick-dir'
		);
		assert.equal(
			resolvers.resolveBrickIdFromCommandArg({
				kind: 'file',
				brickId: 'brick-file',
				remotePath: '/home/root/lms2012/prjs/Demo/main.rbf'
			}),
			'brick-file'
		);
	});
});

test('brickResolvers resolves connected descriptor by transport mode', async () => {
	await withMockedBrickResolvers(
		{
			configValues: {
				'transport.mode': 'tcp',
				'transport.tcp.host': '192.168.0.10',
				'transport.tcp.port': 5566
			}
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			const tcp = resolvers.resolveConnectedBrickDescriptor('/home/root/lms2012/prjs/');
			assert.equal(tcp.transport, 'tcp');
			assert.equal(tcp.rootPath, '/home/root/lms2012/prjs/');
			assert.match(tcp.brickId, /^tcp-/);
			assert.match(tcp.displayName, /192\.168\.0\.10:5566/);

			const bt = resolvers.resolveConnectedBrickDescriptor('/home/root/lms2012/prjs/', {
				transport: { mode: 'bluetooth', bluetoothPort: 'COM9' },
				rootPath: '/media/card/'
			});
			assert.equal(bt.transport, 'bluetooth');
			assert.equal(bt.rootPath, '/media/card/');
			assert.match(bt.brickId, /^bluetooth-/);

			const usb = resolvers.resolveConnectedBrickDescriptor('/home/root/lms2012/prjs/', {
				transport: { mode: 'usb', usbPath: 'hid#ev3' }
			});
			assert.equal(usb.transport, 'usb');
			assert.match(usb.brickId, /^usb-/);

			const mock = resolvers.resolveConnectedBrickDescriptor('/home/root/lms2012/prjs/', {
				transport: { mode: 'mock' }
			});
			assert.equal(mock.transport, 'mock');
			assert.equal(mock.brickId, 'mock-active');
		}
	);
});

test('brickResolvers uses remembered Brick name as descriptor displayName', async () => {
	await withMockedBrickResolvers(
		{
			configValues: {
				'transport.mode': 'usb',
				'transport.usb.path': 'hid#main'
			}
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			const descriptor = resolvers.resolveConnectedBrickDescriptor('/home/root/lms2012/prjs/', {
				displayName: 'MyBrick',
				transport: { mode: 'usb', usbPath: 'hid#main' }
			});
			assert.equal(descriptor.displayName, 'MyBrick');
		}
	);
});

test('brickResolvers normalizes executable paths and validates normalized value', async () => {
	const validatedPaths: string[] = [];
	await withMockedBrickResolvers(
		{
			assertRemoteExecutablePath: (remotePath) => {
				validatedPaths.push(remotePath);
			}
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			const fromUri = resolvers.normalizeRunExecutablePath('ev3://active/home/root/lms2012/prjs/demo.rbf');
			const fromRelative = resolvers.normalizeRunExecutablePath('home/root/lms2012/prjs/demo.rbf');
			assert.equal(fromUri, '/home/root/lms2012/prjs/demo.rbf');
			assert.equal(fromRelative, '/home/root/lms2012/prjs/demo.rbf');
		}
	);
	assert.deepEqual(validatedPaths, ['/home/root/lms2012/prjs/demo.rbf', '/home/root/lms2012/prjs/demo.rbf']);
});

test('brickResolvers confirms full filesystem mode when user accepts', async () => {
	await withMockedBrickResolvers(
		{
			configValues: {
				'fs.mode': 'full',
				'fs.fullMode.confirmationRequired': true
			},
			warningChoice: 'Enable Full Mode'
		},
		async ({ module, deps, state }) => {
			const resolvers = module.createBrickResolvers(deps);
			const allowed = await resolvers.ensureFullFsModeConfirmation();
			assert.equal(allowed, true);
			assert.equal(state.warningCalls.length, 1);
			assert.equal(state.configUpdates.length, 0);
			assert.equal(state.logger.info.length, 1);
			assert.equal(state.logger.warn.length, 0);
		}
	);
});

test('brickResolvers returns active/offline error contexts when services are unavailable', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.deepEqual(resolvers.resolveFsAccessContext(undefined), {
			error: 'No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.'
		});
		assert.deepEqual(resolvers.resolveControlAccessContext(undefined), {
			error: 'No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.'
		});
		assert.deepEqual(resolvers.resolveDeployTargetFromArg(undefined), {
			error: 'No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.'
		});
	});
});

test('brickResolvers returns status-aware error for known brick without service', async () => {
	await withMockedBrickResolvers(
		{
			snapshots: {
				'brick-offline': {
					status: 'UNAVAILABLE'
				}
			}
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.deepEqual(resolvers.resolveFsAccessContext('brick-offline'), {
				error: 'Brick "brick-offline" is currently unavailable.'
			});
			assert.deepEqual(resolvers.resolveControlAccessContext('brick-offline'), {
				error: 'Brick "brick-offline" is currently unavailable.'
			});
		}
	);
});

test('brickResolvers returns not-connected error for unknown explicit brick', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.deepEqual(resolvers.resolveFsAccessContext('brick-missing'), {
			error: 'Brick "brick-missing" is not connected.'
		});
		assert.deepEqual(resolvers.resolveControlAccessContext('brick-missing'), {
			error: 'Brick "brick-missing" is not connected.'
		});
	});
});

test('brickResolvers rejects empty executable path', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.throws(() => resolvers.normalizeRunExecutablePath('   '), /must not be empty/i);
	});
});

test('brickResolvers reverts full filesystem mode when user rejects confirmation', async () => {
	await withMockedBrickResolvers(
		{
			configValues: {
				'fs.mode': 'full',
				'fs.fullMode.confirmationRequired': true
			},
			configInspect: {
				workspaceValue: 'full'
			}
		},
		async ({ module, deps, state }) => {
			const resolvers = module.createBrickResolvers(deps);
			const allowed = await resolvers.ensureFullFsModeConfirmation();
			assert.equal(allowed, false);
			assert.equal(state.warningCalls.length, 1);
			assert.equal(state.configUpdates.length, 1);
			assert.deepEqual(state.configUpdates[0], {
				key: 'fs.mode',
				value: 'safe',
				target: 2
			});
			assert.equal(state.logger.warn.length, 1);
			assert.equal(state.logger.info.length, 0);
		}
	);
});

// --- Additional brickResolvers tests ---

test('brickResolvers resolveConcreteBrickId returns brickId as-is when not active', async () => {
	await withMockedBrickResolvers(
		{ activeBrickId: 'usb-main' },
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.equal(resolvers.resolveConcreteBrickId('tcp-custom'), 'tcp-custom');
		}
	);
});

test('brickResolvers resolveConcreteBrickId returns active when no active brick set', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.equal(resolvers.resolveConcreteBrickId('active'), 'active');
	});
});

test('brickResolvers resolveBrickIdFromCommandArg returns active for undefined', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.equal(resolvers.resolveBrickIdFromCommandArg(undefined), 'active');
	});
});

test('brickResolvers resolveBrickIdFromCommandArg returns active for empty string', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.equal(resolvers.resolveBrickIdFromCommandArg('   '), 'active');
	});
});

test('brickResolvers resolveBrickIdFromCommandArg returns active for non-matching object', async () => {
	await withMockedBrickResolvers({}, async ({ module, deps }) => {
		const resolvers = module.createBrickResolvers(deps);
		assert.equal(resolvers.resolveBrickIdFromCommandArg({ kind: 'unknown' }), 'active');
		assert.equal(resolvers.resolveBrickIdFromCommandArg(42), 'active');
		assert.equal(resolvers.resolveBrickIdFromCommandArg(null), 'active');
	});
});

test('brickResolvers resolveCurrentTransportMode returns configured mode', async () => {
	await withMockedBrickResolvers(
		{ configValues: { 'transport.mode': 'usb' } },
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.equal(resolvers.resolveCurrentTransportMode(), 'usb');
		}
	);
});

test('brickResolvers resolveCurrentTransportMode returns unknown for invalid value', async () => {
	await withMockedBrickResolvers(
		{ configValues: { 'transport.mode': 'invalid-mode' } },
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.equal(resolvers.resolveCurrentTransportMode(), 'unknown');
		}
	);
});

test('brickResolvers resolveProbeTimeoutMs uses bluetooth probe for bluetooth mode', async () => {
	await withMockedBrickResolvers(
		{
			configValues: {
				'transport.mode': 'bluetooth',
				'transport.bluetooth.probeTimeoutMs': 12_000
			},
			schedulerTimeoutMs: 2_000
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.equal(resolvers.resolveProbeTimeoutMs(), 12_000);
		}
	);
});

test('brickResolvers resolveProbeTimeoutMs uses base timeout for non-bluetooth mode', async () => {
	await withMockedBrickResolvers(
		{
			configValues: { 'transport.mode': 'usb' },
			schedulerTimeoutMs: 3_000
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			assert.equal(resolvers.resolveProbeTimeoutMs(), 3_000);
		}
	);
});

test('brickResolvers resolveConnectedBrickDescriptor unknown transport falls back to usb', async () => {
	await withMockedBrickResolvers(
		{ configValues: { 'transport.mode': 'unknown-value' } },
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			const desc = resolvers.resolveConnectedBrickDescriptor('/home/root/lms2012/prjs/');
			assert.equal(desc.brickId, 'usb-active');
			assert.equal(desc.transport, 'usb');
			assert.equal(desc.displayName, 'EV3 USB');
		}
	);
});

test('brickResolvers resolveDeployTargetFromArg extracts rootPath from directory node', async () => {
	const fsService = { id: 'fs-main' };
	await withMockedBrickResolvers(
		{
			activeBrickId: 'usb-main',
			fsServices: { 'usb-main': fsService },
			snapshots: { 'usb-main': { status: 'READY', rootPath: '/home/root/lms2012/prjs/' } }
		},
		async ({ module, deps }) => {
			const resolvers = module.createBrickResolvers(deps);
			const result = resolvers.resolveDeployTargetFromArg({
				kind: 'directory',
				brickId: 'usb-main',
				remotePath: '/home/root/lms2012/prjs/MyProject'
			});
			assert.equal('error' in result, false);
			if (!('error' in result)) {
				assert.equal(result.rootPath, '/home/root/lms2012/prjs/MyProject');
			}
		}
	);
});

test('brickResolvers ensureFullFsModeConfirmation skips when mode is safe', async () => {
	await withMockedBrickResolvers(
		{
			configValues: { 'fs.mode': 'safe' }
		},
		async ({ module, deps, state }) => {
			const resolvers = module.createBrickResolvers(deps);
			const allowed = await resolvers.ensureFullFsModeConfirmation();
			assert.equal(allowed, true);
			assert.equal(state.warningCalls.length, 0);
		}
	);
});

test('brickResolvers ensureFullFsModeConfirmation skips when confirmation not required', async () => {
	await withMockedBrickResolvers(
		{
			configValues: {
				'fs.mode': 'full',
				'fs.fullMode.confirmationRequired': false
			}
		},
		async ({ module, deps, state }) => {
			const resolvers = module.createBrickResolvers(deps);
			const allowed = await resolvers.ensureFullFsModeConfirmation();
			assert.equal(allowed, true);
			assert.equal(state.warningCalls.length, 0);
		}
	);
});
