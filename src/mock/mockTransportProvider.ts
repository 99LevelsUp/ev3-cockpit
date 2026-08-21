import {
	Transport, PresenceState, BrickKey, makeBrickKey,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, PortState,
	BrickCommand, BrickResponse, SendCommandOptions, CommandChannelLike,
} from '../contracts';
import { TransportError, ConnectionError } from '../errors';
import { MockConfig, MockBrickConfig, MockPortConfig } from './mockConfig';
import { evaluateDynamic } from './dynamics';
import { MockFilesystem } from './mockFilesystem';

/** The one handle the mock hands out; it stores whole files and has no handle table. */
const MOCK_FILE_HANDLE = 1;

interface MockBrickState {
	readonly config: MockBrickConfig;
	readonly filesystem: MockFilesystem;
	connected: boolean;
}

/**
 * Mock transport provider.
 *
 * Simulates brick discovery, connection, telemetry dynamics,
 * configurable errors, and periodic loss / recovery.
 */
export interface MockTransportOptions {
	/** Random number generator (0–1). Defaults to Math.random. Inject for deterministic tests. */
	random?: () => number;
}

export class MockTransportProvider implements TransportProvider {
	readonly transport = Transport.Mock;
	readonly capabilities: TransportCapabilities = {
		supportsForget: false,
		supportsSignalInfo: false,
	};

	private readonly bricks = new Map<BrickKey, MockBrickState>();
	private readonly random: () => number;
	private disposed = false;

	constructor(config: MockConfig, options?: MockTransportOptions) {
		this.random = options?.random ?? Math.random;
		for (const brickCfg of config.bricks) {
			const key = makeBrickKey(Transport.Mock, brickCfg.id);
			this.bricks.set(key, {
				config: brickCfg,
				filesystem: new MockFilesystem(brickCfg.filesystem),
				connected: false,
			});
		}
	}

	// ── Discovery ───────────────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/require-await
	async discover(): Promise<DiscoveryScanResult> {
		this.assertNotDisposed();
		const now = Date.now();
		const items: DiscoveryItem[] = [];

		for (const [brickKey, state] of this.bricks) {
			if (this.isHidden(state, now)) {
				continue; // brick is "temporarily disappeared"
			}
			items.push(this.toDiscoveryItem(brickKey, state, now));
		}

		return { transport: Transport.Mock, items };
	}

	// ── Connect / Disconnect ────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/require-await
	async connect(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		const state = this.requireBrick(brickKey);

		if (state.config.error && this.random() < state.config.error.connectFailRate) {
			throw new ConnectionError(`Mock connect failure for ${brickKey}`);
		}

		state.connected = true;
		return { brickKey, transport: Transport.Mock };
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async disconnect(brickKey: BrickKey): Promise<void> {
		this.assertNotDisposed();
		const state = this.requireBrick(brickKey);
		state.connected = false;
	}

	// ── Send ────────────────────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/require-await
	/**
	 * The mock answers commands, not packets.
	 *
	 * Real transports are byte movers and the command layer frames for them. A mock
	 * brick exists to simulate what a command *means*, so making it decode real EV3
	 * framing back into commands would be work in service of nothing. It therefore
	 * supplies its own channel and leaves `sendPacket` unusable.
	 */
	createCommandChannel(brickKey: BrickKey): CommandChannelLike {
		return {
			execute: (command, options) => this.executeCommand(brickKey, command, options),
		};
	}

	sendPacket(): Promise<Uint8Array> {
		return Promise.reject(new TransportError(
			'The mock provider has no wire format. Use createCommandChannel().'
		));
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async executeCommand(
		brickKey: BrickKey,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse> {
		this.assertNotDisposed();
		// The real adapters reject an aborted send before dispatch. A mock that
		// answers anyway teaches Phase 4 consumers the wrong contract.
		if (options?.signal?.aborted) {
			throw new TransportError(`Mock send to ${brickKey} was aborted.`);
		}
		const state = this.requireBrick(brickKey);

		if (!state.connected) {
			throw new TransportError(`Brick ${brickKey} is not connected`);
		}

		if (state.config.error && this.random() < state.config.error.sendFailRate) {
			throw new TransportError(`Mock send failure for ${brickKey}`);
		}

		const now = Date.now();

		// A brick in its hidden phase is gone from the user's point of view. Answering
		// sends anyway meant the heartbeat never missed, so loss and reconnect were
		// unreachable from the mock -- the one transport the tests can drive.
		if (this.isHidden(state, now)) {
			throw new TransportError(`Mock brick ${brickKey} is currently unreachable.`);
		}

		switch (command.kind) {
		case 'battery':
			return { kind: 'battery', level: state.config.battery.level, voltage: state.config.battery.voltage };

		case 'ports':
			return {
				kind: 'ports',
				motorPorts: this.evaluatePorts(state.config.motorPorts, now),
				sensorPorts: this.evaluatePorts(state.config.sensorPorts, now),
			};

		case 'buttons':
			// EV3 buttons are hardware constants — not configurable per brick.
			return { kind: 'buttons', state: { left: false, right: false, up: false, down: false, enter: false, back: false } };

		case 'info':
			return { kind: 'info', displayName: state.config.displayName, firmwareVersion: state.config.firmwareVersion };

		case 'fs:list':
			return { kind: 'fs:list', entries: state.filesystem.list(command.path || '/') };

		case 'fs:read': {
			const content = state.filesystem.read(command.path);
			if (content === undefined) {
				throw new TransportError(`File not found: ${command.path}`);
			}
			return { kind: 'fs:read', content };
		}

		// Handle-level transfer steps. The mock keeps no handle table — it stores whole
		// files — so a transfer completes in its first step. These cases exist so a
		// consumer sees the same command surface, and so the exhaustive switch does not
		// silently lose a case when the union grows.
		case 'fs:beginWrite':
			state.filesystem.write(
				command.path,
				Buffer.from(command.chunk).toString('utf8'),
			);
			return {
				kind: 'fs:beginWrite',
				handle: MOCK_FILE_HANDLE,
				endOfFile: command.chunk.length >= command.totalBytes,
			};

		case 'fs:continueWrite':
			return { kind: 'fs:continueWrite', handle: command.handle, endOfFile: true };

		case 'fs:beginRead': {
			const whole = state.filesystem.read(command.path);
			if (whole === undefined) {
				throw new TransportError(`File not found: ${command.path}`);
			}
			const body = Buffer.from(whole, 'utf8');
			const chunk = body.subarray(0, command.wantBytes);
			return {
				kind: 'fs:beginRead',
				handle: MOCK_FILE_HANDLE,
				totalBytes: body.length,
				endOfFile: chunk.length >= body.length,
				chunk: new Uint8Array(chunk),
			};
		}

		case 'fs:continueRead':
			return {
				kind: 'fs:continueRead',
				handle: command.handle,
				endOfFile: true,
				chunk: new Uint8Array(0),
			};

		case 'fs:closeHandle':
			return { kind: 'fs:closeHandle' };

		case 'fs:write':
			state.filesystem.write(command.path, command.content);
			return { kind: 'fs:write' };

		case 'fs:exists':
			return { kind: 'fs:exists', exists: state.filesystem.exists(command.path) };

		case 'fs:delete':
			return { kind: 'fs:delete', deleted: state.filesystem.delete(command.path) };
		}
	}

	// ── Recover ─────────────────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/require-await
	async recover(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		const state = this.requireBrick(brickKey);
		state.connected = true;
		return { brickKey, transport: Transport.Mock };
	}

	// ── Extra: direct access for testing ────────────────────────────

	/** Get the filesystem for a mock brick (for test assertions). */
	getFilesystem(brickKey: BrickKey): MockFilesystem | undefined {
		return this.bricks.get(brickKey)?.filesystem;
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		this.disposed = true;
		this.bricks.clear();
	}

	// ── Internals ───────────────────────────────────────────────────

	private requireBrick(brickKey: BrickKey): MockBrickState {
		const state = this.bricks.get(brickKey);
		if (!state) {
			throw new TransportError(`Unknown mock brick: ${brickKey}`);
		}
		return state;
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new TransportError('MockTransportProvider has been disposed');
		}
	}

	private isHidden(state: MockBrickState, now: number): boolean {
		const loss = state.config.loss;
		if (!loss || !loss.enabled) { return false; }

		const cycle = loss.visibleMs + loss.hiddenMs;
		const phase = now % cycle;
		return phase >= loss.visibleMs;
	}

	private toDiscoveryItem(brickKey: BrickKey, state: MockBrickState, now: number): DiscoveryItem {
		return {
			brickKey,
			displayName: state.config.displayName,
			transport: Transport.Mock,
			presenceState: PresenceState.Available,
			remembered: false,
			connected: state.connected,
			favorite: false,
			availableTransports: [Transport.Mock],
			lastSeenAt: now,
		};
	}

	private evaluatePorts(ports: ReadonlyArray<MockPortConfig>, now: number): PortState[] {
		return ports.map(p => ({
			port: p.port,
			peripheralType: p.peripheralType,
			value: evaluateDynamic(p.dynamic, now),
			unit: p.unit,
			timestamp: now,
		}));
	}
}
