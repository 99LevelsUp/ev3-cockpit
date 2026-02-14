import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { concatBytes, gv0, lc0, uint16le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import type { BrickRegistry } from './brickRegistry';
import type { BrickSessionManager } from './brickSessionManager';
import type { CommandScheduler } from '../scheduler/commandScheduler';
import type { BrickTelemetryStore } from './brickTelemetryStore';
import type { BrickFilesystemNode, BrickFilesystemRoot } from './brickDefinition';
import type { MotorPort } from './motorTypes';
import { MOTOR_PORTS } from './motorTypes';
import type { SensorInfo } from './sensorTypes';
import { isSensorConnected, sensorTypeName } from './sensorTypes';
import type { Logger } from '../diagnostics/logger';
import type { RemoteFsService } from '../fs/remoteFsService';
import { readFeatureConfig } from '../config/featureConfig';
import type { Lane } from '../scheduler/types';

const OP_UI_READ = 0x81;
const OP_MEMORY_USAGE = 0xc5;
const OP_INPUT_DEVICE_LIST = 0x98;
const OP_INPUT_DEVICE = 0x99;
const OP_OUTPUT_GET_COUNT = 0xb3;
const INPUT_DEVICE_SUB = {
	GET_TYPEMODE: 0x05
} as const;

const UI_READ_SUB = {
	GET_IBATT: 0x02,
	GET_IMOTOR: 0x07,
	GET_SDCARD: 0x1d
} as const;

type TaskKey = 'fastDevices' | 'fastValues' | 'medium' | 'slow' | 'extraSlow' | 'static';

interface BrickTelemetryState {
	lastRun: Record<TaskKey, number>;
	inFlight: Set<TaskKey>;
	lastDeviceTypes?: number[];
	lastTacho?: Partial<Record<MotorPort, number>>;
	lastLayerTacho?: Map<string, number>;
	inputTypeModes?: Map<string, { typeCode: number; mode: number }>;
	fsQueueSlow?: Array<{ path: string; depth: number }>;
	fsQueueExtra?: Array<{ path: string; depth: number }>;
	fsCache?: Map<string, FsNode[]>;
	fsRootErrors?: Map<string, string>;
	fsRootPaths?: string[];
	fsVisited?: Set<string>;
	fsEntriesRemaining?: number;
	fsTruncated?: boolean;
}

export interface BrickTelemetryPollerConfig {
	enabled: boolean;
	fastDeviceIntervalMs: number;
	fastValuesIntervalMs: number;
	mediumIntervalMs: number;
	slowIntervalMs: number;
	extraSlowIntervalMs: number;
	staticIntervalMs: number;
	fsDepth: number;
	fsMaxEntries: number;
	fsBatchSize: number;
	queueLimitSlow: number;
	queueLimitMedium: number;
	queueLimitInactiveFast: number;
}

export interface BrickTelemetryPollerOptions {
	brickRegistry: BrickRegistry;
	sessionManager: BrickSessionManager<CommandScheduler, Ev3CommandClient, any>;
	telemetryStore: BrickTelemetryStore;
	config: BrickTelemetryPollerConfig;
	defaultTimeoutMs: number;
	onTelemetryChange?: (brickId: string) => void;
	logger?: Logger;
}

const DEFAULT_TICK_MS = 100;

function shouldRun(lastRun: number, intervalMs: number): boolean {
	if (intervalMs <= 0) {
		return lastRun === 0;
	}
	return Date.now() - lastRun >= intervalMs;
}

function sameStringArray(left?: string[], right?: string[]): boolean {
	if (left === right) {
		return true;
	}
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) {
			return false;
		}
	}
	return true;
}

function mapDeviceIndexToInput(index: number): { layer: number; port: number } | undefined {
	if (index < 0 || index >= 16) {
		return undefined;
	}
	return { layer: Math.floor(index / 4), port: index % 4 };
}

function mapDeviceIndexToOutput(index: number): { layer: number; portIndex: number } | undefined {
	if (index < 16 || index >= 32) {
		return undefined;
	}
	const local = index - 16;
	return { layer: Math.floor(local / 4), portIndex: local % 4 };
}

function mapLayerPortToMotorPort(portIndex: number): MotorPort | undefined {
	switch (portIndex) {
		case 0:
			return 'A';
		case 1:
			return 'B';
		case 2:
			return 'C';
		case 3:
			return 'D';
		default:
			return undefined;
	}
}

function parseLayerBrickId(brickId: string): { masterId: string; layer: number } | undefined {
	const marker = '-layer-';
	const idx = brickId.lastIndexOf(marker);
	if (idx <= 0) {
		return undefined;
	}
	const layerText = brickId.slice(idx + marker.length);
	const layer = Number(layerText);
	if (!Number.isFinite(layer) || layer <= 0) {
		return undefined;
	}
	return { masterId: brickId.slice(0, idx), layer };
}

function buildLayerBrickId(masterId: string, layer: number): string {
	return `${masterId}-layer-${layer}`;
}

async function readUiFloat32(
	client: Ev3CommandClient,
	subcode: number,
	timeoutMs: number,
	lane: Lane
): Promise<number> {
	const payload = concatBytes(uint16le(4), new Uint8Array([OP_UI_READ, subcode]), gv0(0));
	const result = await client.send({
		id: `telemetry-ui-f32-${subcode.toString(16)}`,
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`UI_READ 0x${subcode.toString(16)} unexpected reply type.`);
	}
	const payloadBytes = result.reply.payload;
	if (payloadBytes.length < 4) {
		throw new Error(`UI_READ 0x${subcode.toString(16)} reply too short.`);
	}
	return new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength).getFloat32(0, true);
}

async function readUiByte(
	client: Ev3CommandClient,
	subcode: number,
	timeoutMs: number,
	lane: Lane
): Promise<number> {
	const payload = concatBytes(uint16le(1), new Uint8Array([OP_UI_READ, subcode]), gv0(0));
	const result = await client.send({
		id: `telemetry-ui-byte-${subcode.toString(16)}`,
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`UI_READ 0x${subcode.toString(16)} unexpected reply type.`);
	}
	return result.reply.payload.length >= 1 ? result.reply.payload[0] : 0;
}

async function readMemoryUsage(
	client: Ev3CommandClient,
	timeoutMs: number,
	lane: Lane
): Promise<{ totalBytes: number; freeBytes: number }> {
	const payload = concatBytes(
		uint16le(8),
		new Uint8Array([OP_MEMORY_USAGE]),
		gv0(0),
		gv0(4)
	);
	const result = await client.send({
		id: 'telemetry-memory-usage',
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error('MEMORY_USAGE unexpected reply type.');
	}
	if (result.reply.payload.length < 8) {
		throw new Error('MEMORY_USAGE reply too short.');
	}
	const view = new DataView(
		result.reply.payload.buffer,
		result.reply.payload.byteOffset,
		result.reply.payload.byteLength
	);
	return { totalBytes: view.getUint32(0, true), freeBytes: view.getUint32(4, true) };
}

async function readInputDeviceList(
	client: Ev3CommandClient,
	timeoutMs: number,
	lane: Lane
): Promise<{ types: number[]; changed: number }> {
	const length = 31;
	const payload = concatBytes(
		uint16le(length + 1),
		new Uint8Array([OP_INPUT_DEVICE_LIST, length]),
		gv0(0),
		gv0(length)
	);
	const result = await client.send({
		id: 'telemetry-device-list',
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error('INPUT_DEVICE_LIST unexpected reply type.');
	}
	const payloadBytes = result.reply.payload;
	if (payloadBytes.length < length + 1) {
		throw new Error('INPUT_DEVICE_LIST reply too short.');
	}
	return {
		types: Array.from(payloadBytes.slice(0, length)),
		changed: payloadBytes[length] ?? 0
	};
}

async function probeInputTypeMode(
	client: Ev3CommandClient,
	layer: number,
	port: number,
	timeoutMs: number,
	lane: Lane
): Promise<{ layer: number; port: number; typeCode: number; mode: number }> {
	const payload = concatBytes(
		uint16le(2),
		new Uint8Array([OP_INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE, layer & 0xff, port & 0xff]),
		gv0(0),
		gv0(1)
	);
	const result = await client.send({
		id: `telemetry-typemode-${layer}-${port}`,
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`GET_TYPEMODE failed (layer=${layer}, port=${port}).`);
	}
	const payloadBytes = result.reply.payload;
	return {
		layer,
		port,
		typeCode: payloadBytes.length >= 1 ? payloadBytes[0] : 0,
		mode: payloadBytes.length >= 2 ? payloadBytes[1] : 0
	};
}

async function readInputSi(
	client: Ev3CommandClient,
	layer: number,
	port: number,
	typeCode: number,
	mode: number,
	timeoutMs: number,
	lane: Lane
): Promise<number> {
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([0x9a]),
		lc0(layer),
		lc0(port),
		lc0(typeCode > 31 ? 0 : typeCode),
		lc0(mode > 31 ? 0 : mode),
		gv0(0)
	);
	const result = await client.send({
		id: `telemetry-readsi-${layer}-${port}`,
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`INPUT_READ_SI failed (layer=${layer}, port=${port}).`);
	}
	if (result.reply.payload.length < 4) {
		throw new Error(`INPUT_READ_SI reply too short (layer=${layer}, port=${port}).`);
	}
	return new DataView(result.reply.payload.buffer, result.reply.payload.byteOffset, result.reply.payload.byteLength)
		.getFloat32(0, true);
}

async function readOutputTacho(
	client: Ev3CommandClient,
	layer: number,
	portIndex: number,
	timeoutMs: number,
	lane: Lane
): Promise<number> {
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([OP_OUTPUT_GET_COUNT]),
		lc0(layer),
		lc0(portIndex),
		gv0(0)
	);
	const result = await client.send({
		id: `telemetry-tacho-${layer}-${portIndex}`,
		lane,
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`OUTPUT_GET_COUNT failed (layer=${layer}, port=${portIndex}).`);
	}
	if (result.reply.payload.length < 4) {
		throw new Error(`OUTPUT_GET_COUNT reply too short (layer=${layer}, port=${portIndex}).`);
	}
	return new DataView(result.reply.payload.buffer, result.reply.payload.byteOffset, result.reply.payload.byteLength)
		.getInt32(0, true);
}


type FsNode = BrickFilesystemNode;

function normalizeFsPath(base: string, child: string): string {
	return `${base.replace(/\/$/, '')}/${child}`;
}

function initFsScan(state: BrickTelemetryState, roots: string[], maxEntries: number): void {
	state.fsQueueSlow = [];
	state.fsQueueExtra = [];
	state.fsCache = new Map<string, FsNode[]>();
	state.fsRootErrors = new Map<string, string>();
	state.fsVisited = new Set<string>();
	state.fsEntriesRemaining = Math.max(0, maxEntries);
	state.fsTruncated = false;
	state.fsRootPaths = [...roots];
	for (const root of roots) {
		state.fsQueueSlow?.push({ path: root, depth: 0 });
		state.fsVisited?.add(root);
	}
}

function enqueueFsDir(
	state: BrickTelemetryState,
	path: string,
	depth: number
): void {
	if (!state.fsVisited) {
		state.fsVisited = new Set<string>();
	}
	if (state.fsVisited.has(path)) {
		return;
	}
	state.fsVisited.add(path);
	if (depth <= 1) {
		state.fsQueueSlow?.push({ path, depth });
	} else {
		state.fsQueueExtra?.push({ path, depth });
	}
}

async function listFsDirectory(
	fsService: RemoteFsService,
	state: BrickTelemetryState,
	entry: { path: string; depth: number },
	maxDepth: number
): Promise<void> {
	if (state.fsEntriesRemaining === undefined || state.fsEntriesRemaining <= 0) {
		state.fsTruncated = true;
		return;
	}
	const listing = await fsService.listDirectory(entry.path);
	const nodes: FsNode[] = [];
	for (const folder of listing.folders) {
		if (folder === '.' || folder === '..') {
			continue;
		}
		if (!state.fsEntriesRemaining || state.fsEntriesRemaining <= 0) {
			state.fsTruncated = true;
			break;
		}
		state.fsEntriesRemaining -= 1;
		nodes.push({ type: 'dir', name: folder, children: [] });
		const nextDepth = entry.depth + 1;
		if (nextDepth <= maxDepth) {
			enqueueFsDir(state, normalizeFsPath(entry.path, folder), nextDepth);
		}
	}
	for (const file of listing.files) {
		if (file.name === '.' || file.name === '..') {
			continue;
		}
		if (!state.fsEntriesRemaining || state.fsEntriesRemaining <= 0) {
			state.fsTruncated = true;
			break;
		}
		state.fsEntriesRemaining -= 1;
		nodes.push({
			type: 'file',
			name: file.name,
			sizeBytes: file.size,
			md5: file.md5
		});
	}
	state.fsCache?.set(entry.path, nodes);
}

function buildFsTree(state: BrickTelemetryState, rootPath: string): BrickFilesystemNode[] {
	const cache = state.fsCache;
	if (!cache) {
		return [];
	}
	const nodes = cache.get(rootPath);
	if (!nodes) {
		return [];
	}
	return nodes.map((node) => {
		if (node.type === 'dir') {
			const childPath = normalizeFsPath(rootPath, node.name);
			return {
				type: 'dir',
				name: node.name,
				children: buildFsTree(state, childPath)
			};
		}
		return {
			type: 'file',
			name: node.name,
			sizeBytes: node.sizeBytes,
			md5: node.md5
		};
	});
}

export class BrickTelemetryPoller {
	private readonly brickRegistry: BrickRegistry;
	private readonly sessionManager: BrickSessionManager<CommandScheduler, Ev3CommandClient, any>;
	private readonly telemetryStore: BrickTelemetryStore;
	private readonly config: BrickTelemetryPollerConfig;
	private readonly defaultTimeoutMs: number;
	private readonly onTelemetryChange?: (brickId: string) => void;
	private readonly logger?: Logger;
	private timer?: NodeJS.Timeout;
	private readonly state = new Map<string, BrickTelemetryState>();

	public constructor(options: BrickTelemetryPollerOptions) {
		this.brickRegistry = options.brickRegistry;
		this.sessionManager = options.sessionManager;
		this.telemetryStore = options.telemetryStore;
		this.config = options.config;
		this.defaultTimeoutMs = options.defaultTimeoutMs;
		this.onTelemetryChange = options.onTelemetryChange;
		this.logger = options.logger;
	}

	public start(): void {
		if (!this.config.enabled) {
			return;
		}
		if (this.timer) {
			return;
		}
		const tick = () => {
			this.poll().catch((error) => {
				this.logger?.warn('Telemetry poller tick failed.', {
					error: error instanceof Error ? error.message : String(error)
				});
			});
			this.timer = setTimeout(tick, DEFAULT_TICK_MS);
			this.timer.unref?.();
		};
		tick();
	}

	public stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	public dispose(): void {
		this.stop();
	}

	private async poll(): Promise<void> {
		const brickIds = this.sessionManager.listSessionBrickIds();
		const activeSet = new Set(brickIds);
		this.telemetryStore.pruneMissing(activeSet);
		for (const brickId of brickIds) {
			const snapshot = this.brickRegistry.getSnapshot(brickId);
			if (!snapshot || snapshot.status !== 'READY') {
				continue;
			}
			const session = this.sessionManager.getSession(brickId);
			if (!session) {
				continue;
			}
			const state = this.ensureState(brickId);
			const queueSize = session.scheduler.getQueueSize();
			const isActive = snapshot.isActive;
			this.maybeSchedule(brickId, session.commandClient, state, 'static', isActive, queueSize);
			this.maybeSchedule(brickId, session.commandClient, state, 'fastDevices', isActive, queueSize);
			this.maybeSchedule(brickId, session.commandClient, state, 'fastValues', isActive, queueSize);
			this.maybeSchedule(brickId, session.commandClient, state, 'medium', isActive, queueSize);
			this.maybeSchedule(brickId, session.commandClient, state, 'slow', isActive, queueSize);
			this.maybeSchedule(brickId, session.commandClient, state, 'extraSlow', isActive, queueSize);
		}
	}

	private ensureState(brickId: string): BrickTelemetryState {
		const existing = this.state.get(brickId);
		if (existing) {
			return existing;
		}
		const fresh: BrickTelemetryState = {
			lastRun: {
				fastDevices: 0,
				fastValues: 0,
				medium: 0,
				slow: 0,
				extraSlow: 0,
				static: 0
			},
			inFlight: new Set<TaskKey>(),
			lastTacho: {},
			lastLayerTacho: new Map<string, number>(),
			inputTypeModes: new Map<string, { typeCode: number; mode: number }>()
		};
		this.state.set(brickId, fresh);
		return fresh;
	}

	private maybeSchedule(
		brickId: string,
		client: Ev3CommandClient,
		state: BrickTelemetryState,
		task: TaskKey,
		isActive: boolean,
		queueSize: number
	): void {
		const interval = this.resolveInterval(task);
		if (!shouldRun(state.lastRun[task], interval)) {
			return;
		}
		if (state.inFlight.has(task)) {
			return;
		}
		if (this.shouldSkipTask(task, isActive, queueSize)) {
			return;
		}
		state.inFlight.add(task);
		const lane = this.resolveLane(task, isActive);
		void this.runTask(brickId, client, state, task, lane)
			.catch((error) => {
				this.logger?.debug('Telemetry task failed', {
					brickId,
					task,
					error: error instanceof Error ? error.message : String(error)
				});
			})
			.finally(() => {
				state.inFlight.delete(task);
				state.lastRun[task] = Date.now();
			});
	}

	private resolveInterval(task: TaskKey): number {
		switch (task) {
			case 'fastDevices':
				return this.config.fastDeviceIntervalMs;
			case 'fastValues':
				return this.config.fastValuesIntervalMs;
			case 'medium':
				return this.config.mediumIntervalMs;
			case 'slow':
				return this.config.slowIntervalMs;
			case 'extraSlow':
				return this.config.extraSlowIntervalMs;
			case 'static':
				return this.config.staticIntervalMs;
			default:
				return 0;
		}
	}

	private resolveLane(task: TaskKey, isActive: boolean): Lane {
		if (isActive) {
			if (task === 'fastDevices' || task === 'fastValues') {
				return 'high';
			}
			if (task === 'medium') {
				return 'normal';
			}
			return 'low';
		}
		if (task === 'fastDevices' || task === 'fastValues') {
			return 'normal';
		}
		return 'low';
	}

	private shouldSkipTask(task: TaskKey, isActive: boolean, queueSize: number): boolean {
		if (task === 'slow' || task === 'extraSlow') {
			return queueSize >= this.config.queueLimitSlow;
		}
		if (task === 'medium') {
			return queueSize >= this.config.queueLimitMedium;
		}
		if (!isActive && (task === 'fastDevices' || task === 'fastValues')) {
			return queueSize >= this.config.queueLimitInactiveFast;
		}
		return false;
	}

	private async runTask(
		brickId: string,
		client: Ev3CommandClient,
		state: BrickTelemetryState,
		task: TaskKey,
		lane: Lane
	): Promise<void> {
		switch (task) {
			case 'fastDevices':
				await this.runFastDeviceList(brickId, client, state, lane);
				return;
			case 'fastValues':
				await this.runFastValues(brickId, client, state, lane);
				return;
			case 'medium':
				await this.runMedium(brickId, lane);
				return;
			case 'slow':
				await this.runSlow(brickId, client, state, lane);
				return;
			case 'extraSlow':
				await this.runExtraSlow(brickId, state, lane);
				return;
			case 'static':
				await this.runStatic(brickId, client, lane);
				return;
			default:
				return;
		}
	}

	private async runFastDeviceList(
		brickId: string,
		client: Ev3CommandClient,
		state: BrickTelemetryState,
		lane: Lane
	): Promise<void> {
		const list = await readInputDeviceList(client, this.defaultTimeoutMs, lane);
		const deviceTypes = list.types;
		const changed = list.changed;
		const lastTypes = state.lastDeviceTypes;
		state.lastDeviceTypes = deviceTypes;

		const changedInputs: Array<{ layer: number; port: number }> = [];
		if (lastTypes) {
			for (let i = 0; i < deviceTypes.length; i += 1) {
				if (deviceTypes[i] !== lastTypes[i]) {
					const input = mapDeviceIndexToInput(i);
					if (input) {
						changedInputs.push(input);
					}
				}
			}
		} else {
			for (let i = 0; i < deviceTypes.length; i += 1) {
				if (deviceTypes[i] !== 126) {
					const input = mapDeviceIndexToInput(i);
					if (input) {
						changedInputs.push(input);
					}
				}
			}
		}

		for (const input of changedInputs) {
			try {
				const info = await probeInputTypeMode(client, input.layer, input.port, this.defaultTimeoutMs, lane);
				const key = `${info.layer}:${info.port}`;
				state.inputTypeModes?.set(key, { typeCode: info.typeCode, mode: info.mode });
			} catch {
				// ignore per-port failures
			}
		}

		const mergedInputs: Array<{ layer: number; port: number; typeCode: number; mode: number }> = [];
		if (state.inputTypeModes && state.inputTypeModes.size > 0) {
			for (const [key, value] of state.inputTypeModes.entries()) {
				const [layerText, portText] = key.split(':');
				const layer = Number(layerText);
				const port = Number(portText);
				if (Number.isFinite(layer) && Number.isFinite(port)) {
					mergedInputs.push({ layer, port, typeCode: value.typeCode, mode: value.mode });
				}
			}
		}

		const changedAny = this.telemetryStore.update(brickId, {
			deviceTypes,
			deviceTypesChanged: changed,
			layeredInputs: mergedInputs.length > 0 ? mergedInputs : undefined
		});
		if (changedAny) {
			this.onTelemetryChange?.(brickId);
		}
	}

	private async runFastValues(
		brickId: string,
		client: Ev3CommandClient,
		state: BrickTelemetryState,
		lane: Lane
	): Promise<void> {
		const sensorService = this.brickRegistry.resolveSensorService(brickId);
		const motorService = this.brickRegistry.resolveMotorService(brickId);
		const settingsService = this.brickRegistry.resolveSettingsService(brickId);
		const buttonService = this.brickRegistry.resolveButtonService(brickId);
		const ledService = this.brickRegistry.resolveLedService(brickId);

		const sensors: SensorInfo[] = [];

		const motors: { port: MotorPort; speed: number; running: boolean; layer?: number }[] = [];
		const deviceTypes = this.telemetryStore.getSnapshot(brickId)?.deviceTypes;
		if (deviceTypes) {
			for (let port = 0; port < 4; port += 1) {
				const typeCode = deviceTypes[port] ?? 0;
				const key = `0:${port}`;
				const mode = state.inputTypeModes?.get(key)?.mode ?? 0;
				sensors.push({
					port: port as 0 | 1 | 2 | 3,
					typeCode,
					mode,
					connected: isSensorConnected(typeCode),
					typeName: sensorTypeName(typeCode)
				});
			}
		} else if (sensorService) {
			try {
				sensors.push(...await sensorService.probeAll());
			} catch {
				// ignore
			}
		}
		if (deviceTypes) {
			for (let i = 0; i < MOTOR_PORTS.length; i += 1) {
				const index = 16 + i;
				if (deviceTypes[index] !== 126) {
					const port = MOTOR_PORTS[i];
					motors.push({ port, speed: 0, running: false });
				}
			}
		}

		if (motorService && deviceTypes) {
			for (let i = 0; i < MOTOR_PORTS.length; i += 1) {
				const index = 16 + i;
				if (deviceTypes[index] === 126) {
					continue;
				}
				const port = MOTOR_PORTS[i];
				try {
					const position = await motorService.readTacho(port);
					const last = state.lastTacho?.[port] ?? position.position;
					const running = position.position !== last;
					state.lastTacho = { ...state.lastTacho, [port]: position.position };
					const entry = motors.find((m) => m.port === port);
					if (entry) {
						entry.running = running;
					}
				} catch {
					// ignore tacho failures
				}
			}
		}

		const layeredSensorReadings: Array<{
			layer: number;
			port: number;
			typeCode: number;
			mode: number;
			value: number;
			timestampMs: number;
		}> = [];
		const layerSensors = new Map<number, SensorInfo[]>();
		const layerMotors = new Map<number, { port: MotorPort; speed: number; running: boolean }[]>();
		if (deviceTypes) {
			for (let i = 0; i < 16 && i < deviceTypes.length; i += 1) {
				const input = mapDeviceIndexToInput(i);
				if (!input || input.layer === 0) {
					continue;
				}
				const typeCode = deviceTypes[i];
				if (typeCode === 126 || typeCode === 127 || typeCode === 0) {
					continue;
				}
				const key = `${input.layer}:${input.port}`;
				let mode = state.inputTypeModes?.get(key)?.mode;
				if (mode === undefined) {
					try {
						const info = await probeInputTypeMode(client, input.layer, input.port, this.defaultTimeoutMs, lane);
						mode = info.mode;
						state.inputTypeModes?.set(key, { typeCode: info.typeCode, mode: info.mode });
					} catch {
						mode = undefined;
					}
				}
				if (mode === undefined) {
					continue;
				}
				if (typeCode <= 31 && mode <= 31) {
					try {
						const value = await readInputSi(
							client,
							input.layer,
							input.port,
							typeCode,
							mode,
							this.defaultTimeoutMs,
							lane
						);
						layeredSensorReadings.push({
							layer: input.layer,
							port: input.port,
							typeCode,
							mode,
							value,
							timestampMs: Date.now()
						});
					} catch {
						// ignore per-port failures
					}
				}
			}

			for (let layer = 1; layer <= 3; layer += 1) {
				const sensorsForLayer: SensorInfo[] = [];
				let hasDeviceListInput = false;
				for (let port = 0; port < 4; port += 1) {
					const index = layer * 4 + port;
					const typeCode = deviceTypes[index] ?? 0;
					if (typeCode !== 126 && typeCode !== 127 && typeCode !== 0) {
						hasDeviceListInput = true;
					}
					const key = `${layer}:${port}`;
					const mode = state.inputTypeModes?.get(key)?.mode ?? 0;
					sensorsForLayer.push({
						port: port as 0 | 1 | 2 | 3,
						layer,
						typeCode,
						mode,
						connected: isSensorConnected(typeCode),
						typeName: sensorTypeName(typeCode)
					});
				}
				if (!hasDeviceListInput) {
					for (let port = 0; port < 4; port += 1) {
						try {
							const info = await probeInputTypeMode(client, layer, port, this.defaultTimeoutMs, lane);
							const key = `${layer}:${port}`;
							state.inputTypeModes?.set(key, { typeCode: info.typeCode, mode: info.mode });
							const idx = sensorsForLayer.findIndex((entry) => entry.port === port);
							if (idx >= 0) {
								sensorsForLayer[idx] = {
									port: port as 0 | 1 | 2 | 3,
									layer,
									typeCode: info.typeCode,
									mode: info.mode,
									connected: isSensorConnected(info.typeCode),
									typeName: sensorTypeName(info.typeCode)
								};
							}
						} catch {
							// ignore per-port failures
						}
					}
				}
				layerSensors.set(layer, sensorsForLayer);
			}

			for (let layer = 1; layer <= 3; layer += 1) {
				let hasDeviceListOutput = false;
				for (let portIndex = 0; portIndex < 4; portIndex += 1) {
					const index = 16 + layer * 4 + portIndex;
					const typeCode = deviceTypes[index] ?? 0;
					if (typeCode !== 126 && typeCode !== 127 && typeCode !== 0) {
						hasDeviceListOutput = true;
					}
				}

				for (let portIndex = 0; portIndex < 4; portIndex += 1) {
					const motorPort = mapLayerPortToMotorPort(portIndex);
					if (!motorPort) {
						continue;
					}
					let typeCode = deviceTypes[16 + layer * 4 + portIndex] ?? 0;
					if (!hasDeviceListOutput) {
						try {
							const outputProbe = await probeInputTypeMode(
								client,
								layer,
								16 + portIndex,
								this.defaultTimeoutMs,
								lane
							);
							typeCode = outputProbe.typeCode;
						} catch {
							// ignore per-port failures
						}
					}
					if (typeCode === 126 || typeCode === 127 || typeCode === 0) {
						continue;
					}
					const entry = { port: motorPort, speed: 0, running: false };
					const existing = layerMotors.get(layer) ?? [];
					existing.push(entry);
					layerMotors.set(layer, existing);
					try {
						const position = await readOutputTacho(
							client,
							layer,
							portIndex,
							this.defaultTimeoutMs,
							lane
						);
						const key = `${layer}:${motorPort}`;
						const last = state.lastLayerTacho?.get(key) ?? position;
						entry.running = position !== last;
						state.lastLayerTacho?.set(key, position);
					} catch {
						// ignore per-port failures
					}
				}
			}
		}

		let volume: number | undefined;
		if (settingsService) {
			try {
				volume = await settingsService.getVolume();
			} catch {
				volume = undefined;
			}
		}
		const existingUi = this.telemetryStore.getSnapshot(brickId)?.ui;

		let buttonState;
		if (buttonService) {
			try {
				buttonState = await buttonService.readButton();
			} catch {
				buttonState = undefined;
			}
		}

		const ledPattern = ledService?.getLastPattern();

		const mergedSensors = sensors.length > 0 ? sensors.slice() : [];
		for (const [layer, list] of layerSensors.entries()) {
			for (const sensor of list) {
				mergedSensors.push({
					...sensor,
					layer
				});
			}
		}

		const mergedMotors = motors.length > 0 ? motors.slice() : [];
		for (const [layer, list] of layerMotors.entries()) {
			for (const motor of list) {
				mergedMotors.push({
					...motor,
					layer
				});
			}
		}

		const changedAny = this.telemetryStore.update(brickId, {
			sensors: mergedSensors.length > 0 ? mergedSensors : undefined,
			motors: mergedMotors.length > 0 ? mergedMotors : undefined,
			layeredSensorReadings: layeredSensorReadings.length > 0 ? layeredSensorReadings : undefined,
			ui: volume !== undefined ? { ...existingUi, volume } : existingUi,
			button: buttonState ?? this.telemetryStore.getSnapshot(brickId)?.button,
			led: ledPattern ?? this.telemetryStore.getSnapshot(brickId)?.led
		});
		if (changedAny) {
			this.onTelemetryChange?.(brickId);
		}
	}

	private async runMedium(_brickId: string, _lane: Lane): Promise<void> {
		return;
	}

	private async runSlow(
		brickId: string,
		client: Ev3CommandClient,
		state: BrickTelemetryState,
		lane: Lane
	): Promise<void> {
		const settingsService = this.brickRegistry.resolveSettingsService(brickId);
		const fsService = this.brickRegistry.resolveFsService(brickId);
		if (!settingsService && !fsService) {
			return;
		}
		const updates: Record<string, unknown> = {};

		if (settingsService) {
			try {
				const name = await settingsService.getBrickName();
				updates.identity = { ...(updates.identity as object), name };
			} catch {
				// ignore
			}
			try {
				const battery = await settingsService.getBatteryInfo();
				updates.power = {
					...(updates.power as object),
					batteryVoltage: battery.voltage,
					batteryLevel: battery.level
				};
			} catch {
				// ignore
			}
			try {
				const sleepMinutes = await settingsService.getSleepTimer();
				const existingUi = this.telemetryStore.getSnapshot(brickId)?.ui;
				updates.ui = { ...existingUi, sleepMinutes };
			} catch {
				// ignore
			}
		}

		try {
			updates.power = {
				...(updates.power as object),
				batteryCurrent: await readUiFloat32(client, UI_READ_SUB.GET_IBATT, this.defaultTimeoutMs, lane)
			};
		} catch {
			// ignore
		}

		try {
			updates.power = {
				...(updates.power as object),
				motorCurrent: await readUiFloat32(client, UI_READ_SUB.GET_IMOTOR, this.defaultTimeoutMs, lane)
			};
		} catch {
			// ignore
		}

		try {
			updates.storage = {
				...(updates.storage as object),
				sdPresent: (await readUiByte(client, UI_READ_SUB.GET_SDCARD, this.defaultTimeoutMs, lane)) === 1
			};
		} catch {
			// ignore
		}

		try {
			const memory = await readMemoryUsage(client, this.defaultTimeoutMs, lane);
			updates.storage = {
				...(updates.storage as object),
				totalMemoryBytes: memory.totalBytes,
				freeMemoryBytes: memory.freeBytes
			};
		} catch {
			// ignore
		}

		if (Object.keys(updates).length === 0) {
			if (fsService && this.config.fsMaxEntries > 0) {
				await this.runFilesystemScan(brickId, fsService, state, lane, 'slow');
			}
			return;
		}
		const changedAny = this.telemetryStore.update(brickId, updates as never);
		if (changedAny) {
			this.onTelemetryChange?.(brickId);
		}
		if (fsService && this.config.fsMaxEntries > 0) {
			await this.runFilesystemScan(brickId, fsService, state, lane, 'slow');
		}
	}

	private async runExtraSlow(brickId: string, state: BrickTelemetryState, lane: Lane): Promise<void> {
		const fsService = this.brickRegistry.resolveFsService(brickId);
		if (!fsService || this.config.fsMaxEntries <= 0) {
			return;
		}
		await this.runFilesystemScan(brickId, fsService, state, lane, 'extra');
	}

	private async runFilesystemScan(
		brickId: string,
		fsService: RemoteFsService,
		state: BrickTelemetryState,
		_lane: Lane,
		mode: 'slow' | 'extra'
	): Promise<void> {
		const featureConfig = readFeatureConfig();
		const roots = featureConfig.fs.defaultRoots;
		if (!state.fsRootPaths || !sameStringArray(state.fsRootPaths, roots)) {
			initFsScan(state, roots, this.config.fsMaxEntries);
		}
		if (!state.fsQueueSlow || !state.fsQueueExtra || !state.fsCache) {
			initFsScan(state, roots, this.config.fsMaxEntries);
		}
		const slowQueue = state.fsQueueSlow ?? [];
		const extraQueue = state.fsQueueExtra ?? [];
		if (mode === 'slow' && slowQueue.length === 0 && extraQueue.length === 0) {
			initFsScan(state, roots, this.config.fsMaxEntries);
		}

		const queue = mode === 'slow' ? (state.fsQueueSlow ?? []) : (state.fsQueueExtra ?? []);
		if (queue.length === 0) {
			return;
		}

		const batchSize = Math.max(1, this.config.fsBatchSize);
		for (let i = 0; i < batchSize && queue.length > 0; i += 1) {
			const entry = queue.shift();
			if (!entry) {
				break;
			}
			try {
				await listFsDirectory(fsService, state, entry, this.config.fsDepth);
			} catch (error) {
				if (entry.depth === 0) {
					state.fsRootErrors?.set(
						entry.path,
						error instanceof Error ? error.message : String(error)
					);
				}
			}
		}

		const filesystemRoots: BrickFilesystemRoot[] = roots.map((rootPath) => ({
			path: rootPath,
			nodes: buildFsTree(state, rootPath),
			truncated: state.fsTruncated,
			error: state.fsRootErrors?.get(rootPath)
		}));
		const changedAny = this.telemetryStore.update(brickId, { filesystem: { roots: filesystemRoots } });
		if (changedAny) {
			this.onTelemetryChange?.(brickId);
		}
	}

	private async runStatic(brickId: string, client: Ev3CommandClient, lane: Lane): Promise<void> {
		const existing = this.telemetryStore.getSnapshot(brickId);
		if (existing?.versions && this.config.staticIntervalMs <= 0) {
			return;
		}
		const result = await client.send({
			id: 'telemetry-capability',
			lane,
			idempotent: true,
			timeoutMs: 2000,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload: buildCapabilityProbeDirectPayload()
		});
		if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
			throw new Error('Capability probe unexpected reply type.');
		}
		const capability = parseCapabilityProbeReply(result.reply.payload);
		const changedAny = this.telemetryStore.update(brickId, {
			versions: {
				osVersion: capability.osVersion,
				osBuild: capability.osBuild,
				fwVersion: capability.fwVersion,
				fwBuild: capability.fwBuild,
				hwVersion: capability.hwVersion
			}
		});
		if (changedAny) {
			this.onTelemetryChange?.(brickId);
		}
	}

	private ensureLayerBricks(masterBrickId: string, deviceTypes: number[] | undefined): void {
		if (!deviceTypes || deviceTypes.length === 0) {
			return;
		}
		const masterSnapshot = this.brickRegistry.getSnapshot(masterBrickId);
		if (!masterSnapshot || masterSnapshot.status !== 'READY') {
			return;
		}
		const fsService = this.brickRegistry.resolveFsService(masterBrickId);
		const controlService = this.brickRegistry.resolveControlService(masterBrickId);
		if (!fsService || !controlService) {
			return;
		}

		const layers = new Set<number>();
		for (let i = 0; i < deviceTypes.length; i += 1) {
			const typeCode = deviceTypes[i];
			if (typeCode === 126 || typeCode === 127 || typeCode === 0) {
				continue;
			}
			const input = mapDeviceIndexToInput(i);
			if (input && input.layer > 0) {
				layers.add(input.layer);
				continue;
			}
			const output = mapDeviceIndexToOutput(i);
			if (output && output.layer > 0) {
				layers.add(output.layer);
			}
		}

		for (const layer of layers) {
			const layerBrickId = buildLayerBrickId(masterBrickId, layer);
			if (this.brickRegistry.getSnapshot(layerBrickId)) {
				continue;
			}
			this.brickRegistry.upsertReadyPassive({
				brickId: layerBrickId,
				displayName: `${masterSnapshot.displayName} (Layer ${layer})`,
				role: 'slave',
				transport: masterSnapshot.transport,
				rootPath: masterSnapshot.rootPath,
				fsService,
				controlService
			});
		}
	}

	private updateLayerTelemetry(
		masterBrickId: string,
		layerSensors: Map<number, SensorInfo[]>,
		layerMotors: Map<number, { port: MotorPort; speed: number; running: boolean }[]>
	): void {
		if (layerSensors.size === 0 && layerMotors.size === 0) {
			return;
		}
		for (const [brickId] of this.brickRegistry.listSnapshots().map((s) => [s.brickId] as const)) {
			const parsed = parseLayerBrickId(brickId);
			if (!parsed || parsed.masterId !== masterBrickId) {
				continue;
			}
			const sensors = layerSensors.get(parsed.layer);
			const motors = layerMotors.get(parsed.layer);
			if (!sensors && !motors) {
				continue;
			}
			const changedAny = this.telemetryStore.update(brickId, {
				sensors: sensors,
				motors: motors
			});
			if (changedAny) {
				this.onTelemetryChange?.(brickId);
			}
		}
	}
}
