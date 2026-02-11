import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { MessageCounter } from '../scheduler/messageCounter';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { SchedulerError } from '../scheduler/types';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from '../scheduler/orphanRecovery';
import { LoggingOrphanRecoveryStrategy } from '../activation/helpers';
import { ExtensionError } from '../errors/ExtensionError';
import { isTransientDeployError, isDeployTransientTransportError } from '../fs/deployResilience';
import { FakeDisposable, FakeEventEmitter, sleep } from './testHelpers';

// ─── 1. COUNTER_EXHAUSTED error path ────────────────────────────────────────

test('MessageCounter.allocate throws with descriptive message when exhausted', () => {
	const counter = new MessageCounter();
	for (let i = 0; i < 65_536; i++) {
		counter.allocate();
	}
	assert.throws(() => counter.allocate(), (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /exhausted/i);
		return true;
	});
});

test('MessageCounter recovers after releasing one slot from exhaustion', () => {
	const counter = new MessageCounter();
	const allocated: number[] = [];
	for (let i = 0; i < 65_536; i++) {
		allocated.push(counter.allocate());
	}
	assert.throws(() => counter.allocate());

	counter.release(allocated[0]);
	const newSlot = counter.allocate();
	assert.equal(typeof newSlot, 'number');
	assert.equal(counter.isPending(newSlot), true);
});

test('CommandScheduler rejects with COUNTER_EXHAUSTED when counter is fully consumed', async () => {
	const counter = new MessageCounter();
	// Exhaust all slots externally
	for (let i = 0; i < 65_536; i++) {
		counter.allocate();
	}

	const scheduler = new CommandScheduler({ messageCounter: counter });

	await assert.rejects(
		scheduler.enqueue({
			id: 'exhausted-1',
			lane: 'normal',
			execute: async () => 'should-not-run'
		}),
		(error: unknown) => {
			assert.ok(error instanceof SchedulerError);
			assert.equal(error.code, 'COUNTER_EXHAUSTED');
			assert.equal(error.requestId, 'exhausted-1');
			assert.match(error.message, /messageCounter/i);
			return true;
		}
	);

	scheduler.dispose();
});

// ─── 2. Orphan recovery action paths ────────────────────────────────────────

test('Orphan recovery receives correct context on timeout', async () => {
	const recoveryContexts: OrphanRecoveryContext[] = [];
	const strategy: OrphanRecoveryStrategy = {
		async recover(ctx) {
			recoveryContexts.push(ctx);
		}
	};

	const scheduler = new CommandScheduler({
		defaultTimeoutMs: 15,
		orphanRecoveryStrategy: strategy
	});

	await assert.rejects(
		scheduler.enqueue({
			id: 'orphan-timeout-ctx',
			lane: 'high',
			execute: async ({ signal }) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
				})
		})
	);

	await sleep(20);
	assert.equal(recoveryContexts.length, 1);
	assert.equal(recoveryContexts[0].requestId, 'orphan-timeout-ctx');
	assert.equal(recoveryContexts[0].lane, 'high');
	assert.equal(recoveryContexts[0].reason, 'timeout');
	scheduler.dispose();
});

test('Orphan recovery receives cancelled reason when request is externally aborted during execution', async () => {
	const recoveryContexts: OrphanRecoveryContext[] = [];
	const strategy: OrphanRecoveryStrategy = {
		async recover(ctx) {
			recoveryContexts.push(ctx);
		}
	};

	const scheduler = new CommandScheduler({
		orphanRecoveryStrategy: strategy,
		defaultTimeoutMs: 5000
	});

	const controller = new AbortController();

	const promise = scheduler.enqueue({
		id: 'orphan-cancelled-ctx',
		lane: 'normal',
		signal: controller.signal,
		execute: async ({ signal }) =>
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			})
	});

	// Wait for execution to start, then abort externally
	await sleep(10);
	controller.abort();

	await assert.rejects(promise);
	await sleep(20);

	assert.equal(recoveryContexts.length, 1);
	assert.equal(recoveryContexts[0].reason, 'cancelled');
	scheduler.dispose();
});

test('LoggingOrphanRecoveryStrategy logs and resolves without throwing', async () => {
	const logMessages: Array<{ message: string; meta?: Record<string, unknown> }> = [];
	const strategy = new LoggingOrphanRecoveryStrategy((message, meta) => {
		logMessages.push({ message, meta });
	});

	await assert.doesNotReject(async () => {
		await strategy.recover({
			requestId: 'log-test-1',
			lane: 'normal',
			reason: 'timeout'
		});
	});

	assert.equal(logMessages.length, 1);
	assert.match(logMessages[0].message, /orphan/i);
	assert.equal(logMessages[0].meta?.requestId, 'log-test-1');
	assert.equal(logMessages[0].meta?.lane, 'normal');
	assert.equal(logMessages[0].meta?.reason, 'timeout');
});

test('LoggingOrphanRecoveryStrategy handles cancelled reason with error context', async () => {
	const logMessages: Array<{ message: string; meta?: Record<string, unknown> }> = [];
	const strategy = new LoggingOrphanRecoveryStrategy((message, meta) => {
		logMessages.push({ message, meta });
	});

	await strategy.recover({
		requestId: 'log-cancel-1',
		lane: 'emergency',
		reason: 'cancelled',
		error: new Error('user abort')
	});

	assert.equal(logMessages.length, 1);
	assert.equal(logMessages[0].meta?.reason, 'cancelled');
});

test('Failed recovery strategy causes all queued requests to be dropped with ORPHAN_RISK', async () => {
	const failingStrategy: OrphanRecoveryStrategy = {
		async recover() {
			throw new Error('recovery infrastructure failure');
		}
	};

	const scheduler = new CommandScheduler({
		defaultTimeoutMs: 15,
		orphanRecoveryStrategy: failingStrategy
	});

	const timeoutPromise = scheduler.enqueue({
		id: 'timeout-trigger',
		lane: 'normal',
		execute: async ({ signal }) =>
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			})
	});

	// Queue a low-priority request while timeout is in-flight
	const lowPromise = scheduler.enqueue({
		id: 'low-queued-for-drop',
		lane: 'low',
		execute: async () => 'should-not-run'
	});

	await assert.rejects(timeoutPromise, (err: unknown) => {
		assert.ok(err instanceof SchedulerError);
		assert.equal(err.code, 'TIMEOUT');
		return true;
	});

	await assert.rejects(lowPromise, (err: unknown) => {
		assert.ok(err instanceof SchedulerError);
		assert.equal(err.code, 'ORPHAN_RISK');
		return true;
	});

	scheduler.dispose();
});

// ─── 3. FsAvailabilityError branches ────────────────────────────────────────

type UriLike = { authority: string; path: string; toString: () => string };

function makeUri(remotePath: string): UriLike {
	return {
		authority: 'active',
		path: remotePath,
		toString: () => `ev3://active${remotePath}`
	};
}

function createVscodeMock() {
	class FileSystemError extends Error {
		public readonly code: string;
		public constructor(code: string, message: string) {
			super(message);
			this.name = 'FileSystemError';
			this.code = code;
		}
		public static FileNotFound(uri: { toString: () => string }): FileSystemError {
			return new FileSystemError('FileNotFound', `File not found: ${uri.toString()}`);
		}
		public static FileExists(uri: { toString: () => string }): FileSystemError {
			return new FileSystemError('FileExists', `File exists: ${uri.toString()}`);
		}
		public static NoPermissions(message: string): FileSystemError {
			return new FileSystemError('NoPermissions', message);
		}
		public static Unavailable(message: string): FileSystemError {
			return new FileSystemError('Unavailable', message);
		}
	}

	return {
		Disposable: FakeDisposable,
		EventEmitter: FakeEventEmitter,
		FileSystemError,
		FileType: { File: 0, Directory: 1 },
		FileChangeType: { Created: 1, Changed: 2, Deleted: 3 }
	};
}

type FsProviderModule = {
	Ev3FileSystemProvider: new (resolver: (brickId: string) => Promise<unknown>) => unknown;
	FsAvailabilityError: new (code: string, message: string) => Error;
};

async function withMockedProvider<T>(run: (mod: FsProviderModule) => Promise<T>): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;
	const vscodeMock = createVscodeMock();

	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('../fs/ev3FileSystemProvider') as FsProviderModule;
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('FsAvailabilityError NO_ACTIVE_BRICK on write maps to NoPermissions', async () => {
	await withMockedProvider(async ({ Ev3FileSystemProvider, FsAvailabilityError }) => {
		const provider = new Ev3FileSystemProvider(async () => {
			throw new FsAvailabilityError('NO_ACTIVE_BRICK', 'No active brick');
		}) as unknown as {
			writeFile: (uri: UriLike, content: Uint8Array, options: { create: boolean; overwrite: boolean }) => Promise<void>;
		};

		await assert.rejects(
			provider.writeFile(makeUri('/home/root/test.bin'), new Uint8Array([1]), { create: true, overwrite: true }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.equal((err as Error & { code: string }).code, 'NoPermissions');
				assert.match(err.message, /read-only/i);
				return true;
			}
		);
	});
});

test('FsAvailabilityError NO_ACTIVE_BRICK on read maps to Unavailable', async () => {
	await withMockedProvider(async ({ Ev3FileSystemProvider, FsAvailabilityError }) => {
		const provider = new Ev3FileSystemProvider(async () => {
			throw new FsAvailabilityError('NO_ACTIVE_BRICK', 'No active EV3 Brick');
		}) as unknown as {
			readFile: (uri: UriLike) => Promise<Uint8Array>;
		};

		await assert.rejects(
			provider.readFile(makeUri('/home/root/test.bin')),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.equal((err as Error & { code: string }).code, 'Unavailable');
				return true;
			}
		);
	});
});

test('FsAvailabilityError BRICK_UNAVAILABLE maps to Unavailable regardless of access', async () => {
	await withMockedProvider(async ({ Ev3FileSystemProvider, FsAvailabilityError }) => {
		const provider = new Ev3FileSystemProvider(async () => {
			throw new FsAvailabilityError('BRICK_UNAVAILABLE', 'Brick disconnected');
		}) as unknown as {
			readFile: (uri: UriLike) => Promise<Uint8Array>;
			writeFile: (uri: UriLike, content: Uint8Array, options: { create: boolean; overwrite: boolean }) => Promise<void>;
		};

		await assert.rejects(
			provider.readFile(makeUri('/home/root/test.bin')),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.equal((err as Error & { code: string }).code, 'Unavailable');
				return true;
			}
		);

		await assert.rejects(
			provider.writeFile(makeUri('/home/root/test.bin'), new Uint8Array([1]), { create: true, overwrite: true }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.equal((err as Error & { code: string }).code, 'Unavailable');
				return true;
			}
		);
	});
});

test('FsAvailabilityError BRICK_NOT_REGISTERED maps to Unavailable', async () => {
	await withMockedProvider(async ({ Ev3FileSystemProvider, FsAvailabilityError }) => {
		const provider = new Ev3FileSystemProvider(async () => {
			throw new FsAvailabilityError('BRICK_NOT_REGISTERED', 'Unknown brick ID xyz');
		}) as unknown as {
			readFile: (uri: UriLike) => Promise<Uint8Array>;
		};

		await assert.rejects(
			provider.readFile(makeUri('/home/root/test.bin')),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.equal((err as Error & { code: string }).code, 'Unavailable');
				assert.match(err.message, /Unknown brick/i);
				return true;
			}
		);
	});
});

// ─── 4. Deploy resilience false-negative scenarios ──────────────────────────

test('isDeployTransientTransportError rejects near-miss pattern "adapter is open"', () => {
	assert.equal(isDeployTransientTransportError('adapter is open'), false);
});

test('isDeployTransientTransportError rejects "transport is closed"', () => {
	assert.equal(isDeployTransientTransportError('transport is closed'), false);
});

test('isDeployTransientTransportError rejects "send completed"', () => {
	assert.equal(isDeployTransientTransportError('send completed'), false);
});

test('isDeployTransientTransportError rejects "unknown error code 999" (non-matching code)', () => {
	assert.equal(isDeployTransientTransportError('unknown error code 999'), false);
});

test('isDeployTransientTransportError rejects empty string', () => {
	assert.equal(isDeployTransientTransportError(''), false);
});

test('isTransientDeployError returns true for ExtensionError with TIMEOUT code', () => {
	const err = new ExtensionError('TIMEOUT', 'something timed out');
	assert.equal(isTransientDeployError(err), true);
});

test('isTransientDeployError returns true for ExtensionError with EXECUTION_FAILED code', () => {
	const err = new ExtensionError('EXECUTION_FAILED', 'command failed');
	assert.equal(isTransientDeployError(err), true);
});

test('isTransientDeployError returns false for ExtensionError with non-transient code', () => {
	const err = new ExtensionError('INVALID_ARGUMENT', 'bad argument');
	assert.equal(isTransientDeployError(err), false);
});

test('isTransientDeployError falls back to message regex for plain Error with transient message', () => {
	const err = new Error('TCP connect timeout after 3000ms');
	assert.equal(isTransientDeployError(err), true);
});

test('isTransientDeployError returns false for plain Error with non-transient message', () => {
	const err = new Error('Path "/etc" is outside safe roots.');
	assert.equal(isTransientDeployError(err), false);
});

test('isTransientDeployError handles non-Error thrown string with transient content', () => {
	assert.equal(isTransientDeployError('ECONNRESET'), true);
});

test('isTransientDeployError handles non-Error thrown string without transient content', () => {
	assert.equal(isTransientDeployError('some random string'), false);
});

test('isTransientDeployError handles non-Error thrown object via String coercion', () => {
	assert.equal(isTransientDeployError({ toString: () => 'socket hang up' }), true);
});

test('isTransientDeployError returns false for non-Error thrown object with no match', () => {
	assert.equal(isTransientDeployError({ toString: () => 'permission denied' }), false);
});

test('isTransientDeployError returns false for null', () => {
	assert.equal(isTransientDeployError(null), false);
});

test('isTransientDeployError returns false for undefined', () => {
	assert.equal(isTransientDeployError(undefined), false);
});
