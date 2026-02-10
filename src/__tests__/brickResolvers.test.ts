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
		resolveConcreteBrickId: (brickId: string) => string;
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
		'transport.mode': 'auto',
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
