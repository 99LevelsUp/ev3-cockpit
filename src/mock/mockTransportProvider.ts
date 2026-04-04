import {
	Transport, PresenceState, BrickKey, makeBrickKey,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, PortState,
	BrickCommand, BrickResponse,
} from '../contracts';
import { TransportError, ConnectionError } from '../errors';
import { MockConfig, MockBrickConfig, MockPortConfig } from './mockConfig';
import { evaluateDynamic } from './dynamics';
import { MockFilesystem } from './mockFilesystem';

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
export class MockTransportProvider implements TransportProvider {
	readonly transport = Transport.Mock;
	readonly capabilities: TransportCapabilities = {
		supportsSignalInfo: false,
	};

	private readonly bricks = new Map<BrickKey, MockBrickState>();
	private disposed = false;

	constructor(config: MockConfig) {
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

		if (state.config.error && Math.random() < state.config.error.connectFailRate) {
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
	async send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse> {
		this.assertNotDisposed();
		const state = this.requireBrick(brickKey);

		if (!state.connected) {
			throw new TransportError(`Brick ${brickKey} is not connected`);
		}

		if (state.config.error && Math.random() < state.config.error.sendFailRate) {
			throw new TransportError(`Mock send failure for ${brickKey}`);
		}

		const now = Date.now();

		switch (command.kind) {
		case 'battery':
			return { kind: 'battery', level: state.config.batteryLevel, voltage: state.config.batteryVoltage };

		case 'ports':
			return {
				kind: 'ports',
				motorPorts: this.evaluatePorts(state.config.motorPorts, now),
				sensorPorts: this.evaluatePorts(state.config.sensorPorts, now),
			};

		case 'buttons':
			return { kind: 'buttons', state: state.config.buttons ?? {} };

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

	/** Get current port values for a mock brick. */
	getPortValues(brickKey: BrickKey): { motorPorts: PortState[]; sensorPorts: PortState[] } | undefined {
		const state = this.bricks.get(brickKey);
		if (!state) { return undefined; }
		const now = Date.now();
		return {
			motorPorts: this.evaluatePorts(state.config.motorPorts, now),
			sensorPorts: this.evaluatePorts(state.config.sensorPorts, now),
		};
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
