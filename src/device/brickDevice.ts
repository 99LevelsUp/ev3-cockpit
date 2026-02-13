import { buildCapabilityProfile } from '../compat/capabilityProfile';
import { BrickSettingsService } from './brickSettingsService';
import {
	BrickSnapshot,
	BrickDisplayInfo,
	BrickDefinitionNode,
	BrickUiSettings,
	BrickPower,
	BrickIdentity,
	BrickVersions,
	BrickStorage,
	BrickPortsSnapshot,
	BrickFilesystemSnapshot
} from './brickDefinition';
import { MotorService } from './motorService';
import { SensorService } from './sensorService';
import { RemoteFsService } from '../fs/remoteFsService';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { concatBytes, gv0, uint16le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import type { TransportAdapter } from '../transport/transportAdapter';

export interface BrickDevice {
	readonly brickId: string;
	readonly displayName: string;
	readonly transport: string;
	load(): Promise<void>;
	getSnapshot(): BrickSnapshot;
	applySettings(update: BrickSettingsUpdate): Promise<void>;
}

export interface BrickSettingsUpdate {
	name?: string;
	ui?: BrickUiSettings;
}

export interface PhysicalBrickDeviceOptions {
	brickId: string;
	displayName: string;
	transport: string;
	detail?: string;
	layer?: number;
	createAdapter: () => TransportAdapter;
	timeoutMs?: number;
	fsRoots?: string[];
	fsDepth?: number;
	fsMaxEntries?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_FS_ROOTS = ['/home/root/lms2012/prjs/', '/media/card/'];
const DEFAULT_FS_DEPTH = 4;
const DEFAULT_FS_MAX_ENTRIES = 2000;
const DISPLAY_INFO: BrickDisplayInfo = {
	width: 178,
	height: 128,
	bpp: 1,
	bufferBytes: 2944
};

const OP_UI_READ = 0x81;
const OP_MEMORY_USAGE = 0xc5;
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

async function readUiFloat32(client: Ev3CommandClient, subcode: number, timeoutMs: number): Promise<number> {
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([OP_UI_READ, subcode]),
		gv0(0)
	);
	const result = await client.send({
		id: `device-ui-f32-${subcode.toString(16)}`,
		lane: 'normal',
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

async function readUiByte(client: Ev3CommandClient, subcode: number, timeoutMs: number): Promise<number> {
	const payload = concatBytes(
		uint16le(1),
		new Uint8Array([OP_UI_READ, subcode]),
		gv0(0)
	);
	const result = await client.send({
		id: `device-ui-byte-${subcode.toString(16)}`,
		lane: 'normal',
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

async function readMemoryUsage(client: Ev3CommandClient, timeoutMs: number): Promise<{
	totalBytes: number;
	freeBytes: number;
}> {
	const payload = concatBytes(
		uint16le(8),
		new Uint8Array([OP_MEMORY_USAGE]),
		gv0(0),
		gv0(4)
	);
	const result = await client.send({
		id: 'device-memory-usage',
		lane: 'normal',
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
	return {
		totalBytes: view.getUint32(0, true),
		freeBytes: view.getUint32(4, true)
	};
}

async function probeSensorLayer(
	client: Ev3CommandClient,
	layer: number,
	port: number,
	timeoutMs: number
): Promise<{ port: number; typeCode: number; mode: number; connected: boolean; typeName?: string }> {
	const payload = concatBytes(
		uint16le(2),
		new Uint8Array([OP_INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
		new Uint8Array([layer & 0xff]),
		new Uint8Array([port & 0xff]),
		gv0(0),
		gv0(1)
	);
	const result = await client.send({
		id: `device-sensor-${layer}-${port}`,
		lane: 'normal',
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`Sensor probe failed (layer=${layer}, port=${port}).`);
	}
	const typeCode = result.reply.payload.length >= 1 ? result.reply.payload[0] : 0;
	const mode = result.reply.payload.length >= 2 ? result.reply.payload[1] : 0;
	return {
		port,
		typeCode,
		mode,
		connected: typeCode !== 0,
		typeName: undefined
	};
}

async function readTachoLayer(
	client: Ev3CommandClient,
	layer: number,
	portIndex: number,
	timeoutMs: number
): Promise<number> {
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([OP_OUTPUT_GET_COUNT]),
		new Uint8Array([layer & 0xff]),
		new Uint8Array([portIndex & 0xff]),
		gv0(0)
	);
	const result = await client.send({
		id: `device-tacho-${layer}-${portIndex}`,
		lane: 'normal',
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`Tacho read failed (layer=${layer}, port=${portIndex}).`);
	}
	const payloadBytes = result.reply.payload;
	if (payloadBytes.length < 4) {
		return 0;
	}
	return new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength).getInt32(0, true);
}

async function listFilesystemTree(
	fsService: RemoteFsService,
	rootPath: string,
	maxDepth: number,
	maxEntries: number
): Promise<{ nodes: BrickFilesystemSnapshot['roots'][number]['nodes']; truncated: boolean }> {
	let truncated = false;
	let entriesRemaining = Math.max(0, maxEntries);

	const walk = async (currentPath: string, depth: number): Promise<BrickFilesystemSnapshot['roots'][number]['nodes']> => {
		if (entriesRemaining <= 0) {
			truncated = true;
			return [];
		}
		if (depth < 0) {
			truncated = true;
			return [];
		}
		const listing = await fsService.listDirectory(currentPath);
		const nodes: BrickFilesystemSnapshot['roots'][number]['nodes'] = [];

		for (const folder of listing.folders) {
			if (folder === '.' || folder === '..') {
				continue;
			}
			if (entriesRemaining <= 0) {
				truncated = true;
				break;
			}
			entriesRemaining -= 1;
			const childPath = `${currentPath.replace(/\/$/, '')}/${folder}`;
			const children = depth === 0 ? [] : await walk(childPath, depth - 1);
			nodes.push({
				type: 'dir',
				name: folder,
				children
			});
		}

		for (const file of listing.files) {
			if (file.name === '.' || file.name === '..') {
				continue;
			}
			if (entriesRemaining <= 0) {
				truncated = true;
				break;
			}
			entriesRemaining -= 1;
			nodes.push({
				type: 'file',
				name: file.name,
				sizeBytes: file.size,
				md5: file.md5
			});
		}

		return nodes;
	};

	const nodes = await walk(rootPath, maxDepth);
	return { nodes, truncated };
}

export class PhysicalBrickDevice implements BrickDevice {
	public readonly brickId: string;
	public readonly displayName: string;
	public readonly transport: string;
	public readonly detail?: string;
	private readonly layer: number;
	private readonly createAdapter: () => TransportAdapter;
	private readonly timeoutMs: number;
	private readonly fsRoots: string[];
	private readonly fsDepth: number;
	private readonly fsMaxEntries: number;
	private snapshot?: BrickSnapshot;

	public constructor(options: PhysicalBrickDeviceOptions) {
		this.brickId = options.brickId;
		this.displayName = options.displayName;
		this.transport = options.transport;
		this.detail = options.detail;
		this.layer = options.layer ?? 0;
		this.createAdapter = options.createAdapter;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fsRoots = options.fsRoots ?? DEFAULT_FS_ROOTS;
		this.fsDepth = options.fsDepth ?? DEFAULT_FS_DEPTH;
		this.fsMaxEntries = options.fsMaxEntries ?? DEFAULT_FS_MAX_ENTRIES;
	}

	public async load(): Promise<void> {
		const scheduler = new CommandScheduler({ defaultTimeoutMs: this.timeoutMs });
		const client = new Ev3CommandClient({ scheduler, transport: this.createAdapter() });
		const errors: string[] = [];
		try {
			await client.open();
			const capabilityResult = await client.send({
				id: 'device-capability',
				lane: 'high',
				idempotent: true,
				timeoutMs: this.timeoutMs,
				type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
				payload: buildCapabilityProbeDirectPayload()
			});
			if (capabilityResult.reply.type !== EV3_REPLY.DIRECT_REPLY) {
				throw new Error('Capability probe unexpected reply type.');
			}
			const capability = parseCapabilityProbeReply(capabilityResult.reply.payload);
			const profile = buildCapabilityProfile(capability, 'auto');

			const settingsService = new BrickSettingsService({
				commandClient: client,
				defaultTimeoutMs: Math.max(this.timeoutMs, profile.recommendedTimeoutMs)
			});
			const sensorService = new SensorService({
				commandClient: client,
				defaultTimeoutMs: Math.max(this.timeoutMs, profile.recommendedTimeoutMs)
			});
			const motorService = new MotorService({
				commandClient: client,
				defaultTimeoutMs: Math.max(this.timeoutMs, profile.recommendedTimeoutMs)
			});
			const fsService = new RemoteFsService({
				commandClient: client,
				capabilityProfile: profile,
				fsConfig: {
					mode: 'full',
					defaultRoots: [...DEFAULT_FS_ROOTS],
					fullModeConfirmationRequired: true
				},
				defaultTimeoutMs: Math.max(this.timeoutMs, profile.recommendedTimeoutMs)
			});

			let identity: BrickIdentity | undefined;
			let power: BrickPower | undefined;
			let ui: BrickUiSettings | undefined;
			let storage: BrickStorage | undefined;
			let ports: BrickPortsSnapshot | undefined;
			let filesystem: BrickFilesystemSnapshot | undefined;
			let versions: BrickVersions | undefined;

			if (this.layer === 0) {
				try {
					const brickName = await settingsService.getBrickName();
					identity = { name: brickName };
				} catch (error) {
					errors.push(`brickName: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					const battery = await settingsService.getBatteryInfo();
					power = {
						...power,
						batteryVoltage: battery.voltage,
						batteryLevel: battery.level
					};
				} catch (error) {
					errors.push(`battery: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					power = {
						...power,
						batteryCurrent: await readUiFloat32(client, UI_READ_SUB.GET_IBATT, this.timeoutMs)
					};
				} catch (error) {
					errors.push(`batteryCurrent: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					power = {
						...power,
						motorCurrent: await readUiFloat32(client, UI_READ_SUB.GET_IMOTOR, this.timeoutMs)
					};
				} catch (error) {
					errors.push(`motorCurrent: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					ui = {
						...ui,
						volume: await settingsService.getVolume()
					};
				} catch (error) {
					errors.push(`volume: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					ui = {
						...ui,
						sleepMinutes: await settingsService.getSleepTimer()
					};
				} catch (error) {
					errors.push(`sleepMinutes: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					storage = {
						...storage,
						sdPresent: (await readUiByte(client, UI_READ_SUB.GET_SDCARD, this.timeoutMs)) === 1
					};
				} catch (error) {
					errors.push(`sdPresent: ${error instanceof Error ? error.message : String(error)}`);
				}

				try {
					const memoryUsage = await readMemoryUsage(client, this.timeoutMs);
					storage = {
						...storage,
						totalMemoryBytes: memoryUsage.totalBytes,
						freeMemoryBytes: memoryUsage.freeBytes
					};
				} catch (error) {
					errors.push(`memoryUsage: ${error instanceof Error ? error.message : String(error)}`);
				}

				versions = {
					osVersion: capability.osVersion,
					osBuild: capability.osBuild,
					fwVersion: capability.fwVersion,
					fwBuild: capability.fwBuild,
					hwVersion: capability.hwVersion
				};
			} else {
				errors.push(`layer-${this.layer}: settings/capability are master-only in current implementation.`);
			}

			try {
				if (this.layer === 0) {
					const sensors = await sensorService.probeAll();
					ports = {
						...ports,
						sensors: sensors.map((sensor) => ({
							port: sensor.port,
							typeCode: sensor.typeCode,
							mode: sensor.mode,
							connected: sensor.connected,
							typeName: sensor.typeName
						}))
					};
				} else {
					const sensors = await Promise.all(
						[0, 1, 2, 3].map((port) => probeSensorLayer(client, this.layer, port, this.timeoutMs))
					);
					ports = {
						...ports,
						sensors: sensors.map((sensor) => ({
							port: sensor.port,
							typeCode: sensor.typeCode,
							mode: sensor.mode,
							connected: sensor.connected,
							typeName: sensor.typeName
						}))
					};
				}
			} catch (error) {
				errors.push(`sensors: ${error instanceof Error ? error.message : String(error)}`);
			}

			try {
				const motors = await Promise.all(
					['A', 'B', 'C', 'D'].map(async (port, index) => {
						if (this.layer === 0) {
							const reading = await motorService.readTacho(port as 'A' | 'B' | 'C' | 'D');
							return { port, tachoPosition: reading.position };
						}
						const position = await readTachoLayer(client, this.layer, index, this.timeoutMs);
						return { port, tachoPosition: position };
					})
				);
				ports = {
					...ports,
					motors
				};
			} catch (error) {
				errors.push(`motors: ${error instanceof Error ? error.message : String(error)}`);
			}

			try {
				const roots = this.fsRoots;
				const fsRoots: BrickFilesystemSnapshot['roots'] = [];
				for (const root of roots) {
					try {
						const tree = await listFilesystemTree(fsService, root, this.fsDepth, this.fsMaxEntries);
						fsRoots.push({
							path: root,
							nodes: tree.nodes,
							truncated: tree.truncated
						});
					} catch (error) {
						fsRoots.push({
							path: root,
							nodes: [],
							truncated: true,
							error: error instanceof Error ? error.message : String(error)
						});
					}
				}
				filesystem = { roots: fsRoots };
			} catch (error) {
				errors.push(`filesystem: ${error instanceof Error ? error.message : String(error)}`);
			}

			this.snapshot = {
				brickId: this.brickId,
				displayName: identity?.name ?? this.displayName,
				transport: this.transport,
				detail: this.detail,
				capturedAtIso: new Date().toISOString(),
				identity,
				versions,
				power,
				storage,
				ui,
				display: DISPLAY_INFO,
				ports,
				filesystem,
				errors: errors.length > 0 ? errors : undefined
			};
		} finally {
			await client.close().catch(() => undefined);
			scheduler.dispose();
		}
	}

	public getSnapshot(): BrickSnapshot {
		if (!this.snapshot) {
			throw new Error('Brick snapshot not loaded yet.');
		}
		return this.snapshot;
	}

	public async applySettings(update: BrickSettingsUpdate): Promise<void> {
		const scheduler = new CommandScheduler({ defaultTimeoutMs: this.timeoutMs });
		const client = new Ev3CommandClient({ scheduler, transport: this.createAdapter() });
		try {
			await client.open();
			const settingsService = new BrickSettingsService({
				commandClient: client,
				defaultTimeoutMs: this.timeoutMs
			});
			if (typeof update.name === 'string' && update.name.trim().length > 0) {
				await settingsService.setBrickName(update.name);
			}
			if (update.ui?.volume !== undefined) {
				await settingsService.setVolume(update.ui.volume);
			}
			if (update.ui?.sleepMinutes !== undefined) {
				await settingsService.setSleepTimer(update.ui.sleepMinutes);
			}
		} finally {
			await client.close().catch(() => undefined);
			scheduler.dispose();
		}
	}
}

export interface MockBrickDeviceOptions {
	brickId: string;
	displayName: string;
	transport: string;
	detail?: string;
	node: BrickDefinitionNode;
}

export class MockBrickDevice implements BrickDevice {
	public readonly brickId: string;
	public readonly displayName: string;
	public readonly transport: string;
	public readonly detail?: string;
	private snapshot: BrickSnapshot;

	public constructor(options: MockBrickDeviceOptions) {
		this.brickId = options.brickId;
		this.displayName = options.displayName;
		this.transport = options.transport;
		this.detail = options.detail;
		this.snapshot = {
			brickId: options.brickId,
			displayName: options.displayName,
			transport: options.transport,
			detail: options.detail,
			capturedAtIso: new Date().toISOString(),
			...options.node
		};
	}

	public async load(): Promise<void> {
		this.snapshot = {
			...this.snapshot,
			capturedAtIso: new Date().toISOString()
		};
	}

	public getSnapshot(): BrickSnapshot {
		return this.snapshot;
	}

	public async applySettings(update: BrickSettingsUpdate): Promise<void> {
		const nextIdentity: BrickIdentity | undefined = update.name
			? { ...(this.snapshot.identity ?? {}), name: update.name }
			: this.snapshot.identity;
		const nextUi: BrickUiSettings | undefined = update.ui
			? { ...(this.snapshot.ui ?? {}), ...update.ui }
			: this.snapshot.ui;
		this.snapshot = {
			...this.snapshot,
			identity: nextIdentity,
			ui: nextUi,
			capturedAtIso: new Date().toISOString()
		};
	}
}
