import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildCapabilityProfile } from '../compat/capabilityProfile';
import { BrickSettingsService } from '../device/brickSettingsService';
import {
	BrickSnapshot,
	BrickFilesystemNode,
	BrickFilesystemRoot
} from '../device/brickDefinition';
import { MotorService } from '../device/motorService';
import { SensorService } from '../device/sensorService';
import { RemoteFsService } from '../fs/remoteFsService';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from '../protocol/capabilityProbe';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { concatBytes, gv0, uint16le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';
import { listSerialCandidates, listTcpDiscoveryCandidates, listUsbHidCandidates } from '../transport/discovery';
import { TcpAdapter } from '../transport/tcpAdapter';
import { UsbHidAdapter } from '../transport/usbHidAdapter';

type TransportKind = 'usb' | 'bt' | 'tcp';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_TCP_DISCOVERY_PORT = 3015;
const DEFAULT_TCP_DISCOVERY_TIMEOUT_MS = 1500;
const DEFAULT_TCP_PORT = 5555;
const DEFAULT_BT_BAUD_RATE = 115200;
const DEFAULT_BT_DTR = false;
const DEFAULT_FS_DEPTH = 6;
const DEFAULT_FS_MAX_ENTRIES = 5000;
const DEFAULT_SAFE_ROOTS = ['/home/root/lms2012/prjs/', '/media/card/'];
const DEFAULT_FS_MODE = 'full';
const DEFAULT_DAISY_ENABLED = true;
const DISPLAY_INFO = {
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
	GET_VBATT: 0x01,
	GET_IBATT: 0x02,
	GET_IMOTOR: 0x07,
	GET_LBATT: 0x12,
	GET_VOLUME: 0x1a,
	GET_SLEEP: 0x0e,
	GET_SDCARD: 0x1d
} as const;

interface BrickCandidate {
	brickId: string;
	displayName: string;
	transport: TransportKind;
	detail: string;
	layer?: number;
	createAdapter: () => UsbHidAdapter | BluetoothSppAdapter | TcpAdapter;
}

function toSafeIdentifier(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized || 'ev3';
}

function isLikelyEv3SerialCandidate(
	candidate: { manufacturer?: string; serialNumber?: string; pnpId?: string },
	preferredPorts: string[],
	port: string
): boolean {
	if (preferredPorts.length > 0) {
		return preferredPorts.includes(port);
	}
	const fingerprint = `${candidate.manufacturer ?? ''} ${candidate.serialNumber ?? ''} ${candidate.pnpId ?? ''}`.toUpperCase();
	return /EV3|LEGO|MINDSTORMS|_005D/.test(fingerprint);
}

function envNumber(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(min, parsed);
}

function envBoolean(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) {
		return fallback;
	}
	if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
		return true;
	}
	if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
		return false;
	}
	return fallback;
}

function envList(name: string, fallback: string[]): string[] {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function envFsMode(): 'safe' | 'full' {
	const raw = process.env.EV3_COCKPIT_INSPECT_FS_MODE?.trim().toLowerCase();
	if (raw === 'safe') {
		return 'safe';
	}
	if (raw === 'full') {
		return 'full';
	}
	return DEFAULT_FS_MODE as 'safe' | 'full';
}

async function readUiFloat32(client: Ev3CommandClient, subcode: number, timeoutMs: number): Promise<number> {
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([OP_UI_READ, subcode]),
		gv0(0)
	);
	const result = await client.send({
		id: `inspect-ui-f32-${subcode.toString(16)}`,
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
		id: `inspect-ui-byte-${subcode.toString(16)}`,
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
		id: 'inspect-memory-usage',
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

interface LayerProbeResult {
	present: boolean;
	latencyMs: number;
	typeCode: number;
	mode: number;
	latencies: number[]; // Multiple measurements
	avgLatency: number;
	stdDevLatency: number;
}

async function probeLayerMultiple(
	client: Ev3CommandClient,
	layer: number,
	timeoutMs: number,
	iterations: number = 5
): Promise<LayerProbeResult> {
	const latencies: number[] = [];
	let typeCode = 0;
	let mode = 0;
	let present = false;

	for (let i = 0; i < iterations; i++) {
		const payload = concatBytes(
			uint16le(2),
			new Uint8Array([OP_INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
			new Uint8Array([layer & 0xff]),
			new Uint8Array([0x00]),
			gv0(0),
			gv0(1)
		);

		const startMs = performance.now();
		try {
			const result = await client.send({
				id: `inspect-layer-${layer}-iter-${i}`,
				lane: 'normal',
				idempotent: true,
				timeoutMs,
				type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
				payload
			});
			const latencyMs = performance.now() - startMs;
			latencies.push(latencyMs);

			if (i === 0) {
				present = result.reply.type === EV3_REPLY.DIRECT_REPLY;
				typeCode = result.reply.payload[0] ?? 0;
				mode = result.reply.payload[1] ?? 0;
			}
		} catch (error) {
			const latencyMs = performance.now() - startMs;
			latencies.push(latencyMs);
			if (i === 0) {
				present = false;
			}
		}
	}

	const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
	const variance = latencies.reduce((sum, lat) => sum + Math.pow(lat - avgLatency, 2), 0) / latencies.length;
	const stdDevLatency = Math.sqrt(variance);

	console.log(
		`[INSPECT] Layer ${layer}: typeCode=${typeCode}, mode=${mode}, avg=${avgLatency.toFixed(1)}ms, stdDev=${stdDevLatency.toFixed(1)}ms, samples=[${latencies.map((l) => l.toFixed(1)).join(', ')}]`
	);

	return {
		present,
		latencyMs: avgLatency,
		typeCode,
		mode,
		latencies,
		avgLatency,
		stdDevLatency
	};
}

async function probeSensorLayer(
	client: Ev3CommandClient,
	layer: number,
	port: number,
	timeoutMs: number
): Promise<{ port: number; typeCode: number; mode: number; connected: boolean }> {
	const payload = concatBytes(
		uint16le(2),
		new Uint8Array([OP_INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
		new Uint8Array([layer & 0xff]),
		new Uint8Array([port & 0xff]),
		gv0(0),
		gv0(1)
	);
	const result = await client.send({
		id: `inspect-sensor-${layer}-${port}`,
		lane: 'normal',
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
		payload
	});
	if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
		throw new Error(`Sensor probe failed (layer=${layer}, port=${port}).`);
	}
	const payloadBytes = result.reply.payload;
	const typeCode = payloadBytes.length >= 1 ? payloadBytes[0] : 0;
	const mode = payloadBytes.length >= 2 ? payloadBytes[1] : 0;
	return {
		port,
		typeCode,
		mode,
		connected: typeCode !== 0
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
		id: `inspect-tacho-${layer}-${portIndex}`,
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
): Promise<{ nodes: BrickFilesystemNode[]; truncated: boolean }> {
	let truncated = false;
	let entriesRemaining = Math.max(0, maxEntries);

	const walk = async (currentPath: string, depth: number): Promise<BrickFilesystemNode[]> => {
		if (entriesRemaining <= 0) {
			truncated = true;
			return [];
		}
		if (depth < 0) {
			truncated = true;
			return [];
		}
		const listing = await fsService.listDirectory(currentPath);
		const nodes: BrickFilesystemNode[] = [];

		for (const folder of listing.folders) {
			if (folder === '.' || folder === '..') {
				continue;
			}
			if (entriesRemaining <= 0) {
				truncated = true;
				break;
			}
			entriesRemaining -= 1;
			const childPath = path.posix.join(currentPath, folder);
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

async function inspectBrick(candidate: BrickCandidate, timeoutMs: number): Promise<BrickSnapshot> {
	const isLayered = typeof candidate.layer === 'number' && candidate.layer > 0;
	const scheduler = new CommandScheduler({ defaultTimeoutMs: timeoutMs });
	const client = new Ev3CommandClient({ scheduler, transport: candidate.createAdapter() });
	const errors: string[] = [];

	try {
		await client.open();
		let capability = {
			osVersion: '',
			osBuild: '',
			fwVersion: '',
			fwBuild: '',
			hwVersion: ''
		};
		if (!isLayered) {
			const capabilityResult = await client.send({
				id: 'inspect-capability',
				lane: 'high',
				idempotent: true,
				timeoutMs,
				type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
				payload: buildCapabilityProbeDirectPayload()
			});
			if (capabilityResult.reply.type !== EV3_REPLY.DIRECT_REPLY) {
				throw new Error('Capability probe unexpected reply type.');
			}
			capability = parseCapabilityProbeReply(capabilityResult.reply.payload);
		} else {
			errors.push(`layer-${candidate.layer}: capability probe is master-only.`);
		}
		const profile = buildCapabilityProfile(capability, 'auto');

		const settingsService = new BrickSettingsService({
			commandClient: client,
			defaultTimeoutMs: Math.max(timeoutMs, profile.recommendedTimeoutMs)
		});
		const sensorService = new SensorService({
			commandClient: client,
			defaultTimeoutMs: Math.max(timeoutMs, profile.recommendedTimeoutMs)
		});
		const motorService = new MotorService({
			commandClient: client,
			defaultTimeoutMs: Math.max(timeoutMs, profile.recommendedTimeoutMs)
		});
		const fsService = new RemoteFsService({
			commandClient: client,
			capabilityProfile: profile,
			fsConfig: {
				mode: envFsMode(),
				defaultRoots: [...DEFAULT_SAFE_ROOTS],
				fullModeConfirmationRequired: true
			},
			defaultTimeoutMs: Math.max(timeoutMs, profile.recommendedTimeoutMs)
		});

		let brickName: string | undefined;
		let batteryVoltage: number | undefined;
		let batteryLevel: number | undefined;
		let batteryCurrent: number | undefined;
		let motorCurrent: number | undefined;
		let volume: number | undefined;
		let sleepMinutes: number | undefined;
		let sdPresent: boolean | undefined;
		let memoryUsage: { totalBytes: number; freeBytes: number } | undefined;

		if (!isLayered) {
			try {
				brickName = await settingsService.getBrickName();
			} catch (error) {
				errors.push(`brickName: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			errors.push(`layer-${candidate.layer}: brick name is master-only.`);
		}

		if (!isLayered) {
			try {
				const battery = await settingsService.getBatteryInfo();
				batteryVoltage = battery.voltage;
				batteryLevel = battery.level;
			} catch (error) {
				errors.push(`battery: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!isLayered) {
			try {
				batteryCurrent = await readUiFloat32(client, UI_READ_SUB.GET_IBATT, timeoutMs);
			} catch (error) {
				errors.push(`batteryCurrent: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!isLayered) {
			try {
				motorCurrent = await readUiFloat32(client, UI_READ_SUB.GET_IMOTOR, timeoutMs);
			} catch (error) {
				errors.push(`motorCurrent: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!isLayered) {
			try {
				volume = await settingsService.getVolume();
			} catch (error) {
				errors.push(`volume: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!isLayered) {
			try {
				sleepMinutes = await settingsService.getSleepTimer();
			} catch (error) {
				errors.push(`sleepMinutes: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!isLayered) {
			try {
				sdPresent = (await readUiByte(client, UI_READ_SUB.GET_SDCARD, timeoutMs)) === 1;
			} catch (error) {
				errors.push(`sdPresent: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!isLayered) {
			try {
				memoryUsage = await readMemoryUsage(client, timeoutMs);
			} catch (error) {
				errors.push(`memoryUsage: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const sensors = await (isLayered
			? Promise.all([0, 1, 2, 3].map((port) => probeSensorLayer(client, candidate.layer ?? 0, port, timeoutMs)))
			: sensorService.probeAll()
		).catch((error) => {
			errors.push(`sensors: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		});

		const motors = await Promise.all(
			['A', 'B', 'C', 'D'].map(async (port, index) => {
				try {
					if (isLayered) {
						const position = await readTachoLayer(client, candidate.layer ?? 0, index, timeoutMs);
						return { port, tachoPosition: position };
					}
					const reading = await motorService.readTacho(port as 'A' | 'B' | 'C' | 'D');
					return { port, tachoPosition: reading.position };
				} catch (error) {
					errors.push(`motor-${port}: ${error instanceof Error ? error.message : String(error)}`);
					return { port };
				}
			})
		);

		const fsRoots = envList('EV3_COCKPIT_INSPECT_FS_ROOTS', DEFAULT_SAFE_ROOTS);
		const fsDepth = envNumber('EV3_COCKPIT_INSPECT_FS_DEPTH', DEFAULT_FS_DEPTH, 0);
		const fsMaxEntries = envNumber('EV3_COCKPIT_INSPECT_FS_MAX_ENTRIES', DEFAULT_FS_MAX_ENTRIES, 1);
		const filesystemRoots: BrickFilesystemRoot[] = [];
		if (fsDepth >= 0 && fsMaxEntries > 0) {
			for (const rootPath of fsRoots) {
				try {
					const tree = await listFilesystemTree(fsService, rootPath, fsDepth, fsMaxEntries);
					filesystemRoots.push({
						path: rootPath,
						nodes: tree.nodes,
						truncated: tree.truncated
					});
				} catch (error) {
					filesystemRoots.push({
						path: rootPath,
						nodes: [],
						error: error instanceof Error ? error.message : String(error),
						truncated: true
					});
				}
			}
		}

		return {
			brickId: candidate.brickId,
			displayName: brickName ?? candidate.displayName,
			transport: candidate.transport,
			detail: candidate.detail,
			capturedAtIso: new Date().toISOString(),
			display: DISPLAY_INFO,
			identity: {
				name: brickName
			},
			versions: {
				osVersion: capability.osVersion,
				osBuild: capability.osBuild,
				fwVersion: capability.fwVersion,
				fwBuild: capability.fwBuild,
				hwVersion: capability.hwVersion
			},
			power: {
				batteryVoltage,
				batteryLevel,
				batteryCurrent,
				motorCurrent
			},
			storage: {
				totalMemoryBytes: memoryUsage?.totalBytes,
				freeMemoryBytes: memoryUsage?.freeBytes,
				sdPresent
			},
			ui: {
				volume,
				sleepMinutes
			},
			ports: {
				sensors: sensors.map((sensor) => {
					const typeName =
						'typeName' in sensor && typeof sensor.typeName === 'string'
							? sensor.typeName
							: undefined;
					return {
						port: sensor.port,
						typeCode: sensor.typeCode,
						mode: sensor.mode,
						connected: sensor.connected,
						typeName
					};
				}),
				motors
			},
			filesystem: filesystemRoots.length > 0 ? { roots: filesystemRoots } : undefined,
			errors: errors.length > 0 ? errors : undefined
		};
	} finally {
		await client.close().catch(() => undefined);
		scheduler.dispose();
	}
}

async function collectCandidates(): Promise<BrickCandidate[]> {
	const timeoutMs = envNumber('EV3_COCKPIT_INSPECT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 50);
	const daisyEnabled = envBoolean('EV3_COCKPIT_INSPECT_USB_DAISY', DEFAULT_DAISY_ENABLED);
	const usbCandidates = await listUsbHidCandidates();
	const serialCandidates = await listSerialCandidates();
	const tcpCandidates = await listTcpDiscoveryCandidates(
		envNumber('EV3_COCKPIT_INSPECT_TCP_DISCOVERY_PORT', DEFAULT_TCP_DISCOVERY_PORT, 1),
		envNumber('EV3_COCKPIT_INSPECT_TCP_DISCOVERY_TIMEOUT_MS', DEFAULT_TCP_DISCOVERY_TIMEOUT_MS, 100)
	);

	const candidates: BrickCandidate[] = [];

	for (const usb of usbCandidates) {
		const usbPath = usb.path?.trim();
		if (!usbPath) {
			continue;
		}
		const brickId = `usb-${toSafeIdentifier(usbPath)}`;
		const displayName = usb.serialNumber ? `EV3 USB (${usb.serialNumber})` : `EV3 USB (${usbPath})`;
		candidates.push({
			brickId,
			displayName,
			transport: 'usb',
			detail: usbPath,
			createAdapter: () =>
				new UsbHidAdapter({
					path: usbPath
				})
		});
		if (daisyEnabled) {
			const maxLayers = envNumber('EV3_COCKPIT_INSPECT_USB_DAISY_MAX_LAYERS', 3, 0);
			const scheduler = new CommandScheduler({ defaultTimeoutMs: timeoutMs });
			const client = new Ev3CommandClient({
				scheduler,
				transport: new UsbHidAdapter({ path: usbPath })
			});
			try {
				await client.open();
				console.log(`[INSPECT] Probing for daisy chain layers (auto-detect with multi-sampling, max ${maxLayers})...`);

				// Probe all layers with multiple samples for better accuracy
				const probeResults: LayerProbeResult[] = [];
				for (let layer = 1; layer <= maxLayers; layer += 1) {
					const result = await probeLayerMultiple(client, layer, timeoutMs, 5);
					if (!result.present) {
						console.log(`[INSPECT] Layer ${layer} not detected, stopping probe.`);
						break;
					}
					probeResults.push(result);
				}

				// Smart filtering: detect phantom layers
				// Strategy: Use averaged latencies and check for clear increasing trend
				// Real daisy-chain bricks should have progressively increasing latency
				const acceptedLayers: number[] = [];

				if (probeResults.length === 0) {
					console.log(`[INSPECT] No layers detected.`);
				} else {
					// Check if all responses are identical
					const allIdentical = probeResults.every(
						(r) => r.typeCode === probeResults[0].typeCode && r.mode === probeResults[0].mode
					);

					// Calculate latency trend: are average latencies increasing?
					const avgLatencies = probeResults.map((r) => r.avgLatency);
					let increasingTrend = true;
					let decreasingCount = 0;

					for (let i = 1; i < avgLatencies.length; i++) {
						const diff = avgLatencies[i] - avgLatencies[i - 1];
						if (diff < -0.5) {
							// Latency decreased by more than 0.5ms
							decreasingCount++;
							increasingTrend = false;
						}
					}

					console.log(
						`[INSPECT] Analysis: allIdentical=${allIdentical}, increasingTrend=${increasingTrend}, decreasingCount=${decreasingCount}`
					);

					// Decision logic:
					// If responses differ (sensors/motors detected), accept all layers
					// If all identical:
					//   - If clear increasing trend, accept all
					//   - If flat/noisy trend, accept all (could be real empty bricks)
					//   - If strongly decreasing trend (2+ decreases), be suspicious

					if (!allIdentical) {
						// Different responses = strong evidence of real bricks
						console.log(`[INSPECT] Responses differ across layers - accepting all as real bricks.`);
						for (let i = 0; i < probeResults.length; i++) {
							acceptedLayers.push(i + 1);
						}
					} else if (decreasingCount >= 2) {
						// Multiple decreasing latencies with identical responses = likely phantoms
						console.log(
							`[INSPECT] Strongly decreasing latencies (${decreasingCount} drops) with identical responses - likely phantoms.`
						);
						console.log(
							`[INSPECT] However, EV3 firmware always responds to layer probes. Accepting all layers.`
						);
						// Accept all anyway - we can't reliably distinguish without sensors/motors
						for (let i = 0; i < probeResults.length; i++) {
							acceptedLayers.push(i + 1);
						}
					} else {
						// Flat or slightly increasing trend - accept as real bricks
						console.log(
							`[INSPECT] Latency trend acceptable (${increasingTrend ? 'increasing' : 'flat'}) - accepting all layers.`
						);
						for (let i = 0; i < probeResults.length; i++) {
							acceptedLayers.push(i + 1);
						}
					}
				}

				console.log(`[INSPECT] Accepted layers: ${acceptedLayers.length > 0 ? acceptedLayers.join(', ') : 'none'}`);

				// Add accepted layers as candidates
				for (const layer of acceptedLayers) {
					candidates.push({
						brickId: `${brickId}-layer-${layer}`,
						displayName: `${displayName} (Layer ${layer})`,
						transport: 'usb',
						detail: `${usbPath} layer ${layer}`,
						layer,
						createAdapter: () =>
							new UsbHidAdapter({
								path: usbPath
							})
					});
				}
			} finally {
				await client.close().catch(() => undefined);
				scheduler.dispose();
			}
		}
	}

	const preferredPorts = envList('EV3_COCKPIT_INSPECT_BT_PORTS', []);
	const baudRate = envNumber('EV3_COCKPIT_INSPECT_BT_BAUD_RATE', DEFAULT_BT_BAUD_RATE, 300);
	const dtr = envBoolean('EV3_COCKPIT_INSPECT_BT_DTR', DEFAULT_BT_DTR);
	for (const serial of serialCandidates) {
		const rawPath = serial.path?.trim();
		if (!rawPath || !/^COM\\d+$/i.test(rawPath)) {
			continue;
		}
		const port = rawPath.toUpperCase();
		if (!isLikelyEv3SerialCandidate(serial, preferredPorts, port)) {
			continue;
		}
		const brickId = `bt-${toSafeIdentifier(port)}`;
		const displayName = `EV3 Bluetooth (${port})`;
		candidates.push({
			brickId,
			displayName,
			transport: 'bt',
			detail: port,
			createAdapter: () =>
				new BluetoothSppAdapter({
					port,
					baudRate,
					dtr
				})
		});
	}

	for (const tcp of tcpCandidates) {
		const endpoint = `${tcp.ip}:${tcp.port}`;
		const brickId = `tcp-${toSafeIdentifier(endpoint)}`;
		const displayName = tcp.name ? tcp.name : `EV3 TCP (${endpoint})`;
		candidates.push({
			brickId,
			displayName,
			transport: 'tcp',
			detail: endpoint,
			createAdapter: () =>
				new TcpAdapter({
					host: tcp.ip,
					port: tcp.port ?? DEFAULT_TCP_PORT,
					serialNumber: tcp.serialNumber ?? '',
					useDiscovery: false,
					discoveryPort: DEFAULT_TCP_DISCOVERY_PORT,
					discoveryTimeoutMs: DEFAULT_TCP_DISCOVERY_TIMEOUT_MS,
					handshakeTimeoutMs: timeoutMs
				})
		});
	}

	return candidates;
}

async function main(): Promise<number> {
	const timeoutMs = envNumber('EV3_COCKPIT_INSPECT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 50);
	const outputPath = process.env.EV3_COCKPIT_INSPECT_OUTPUT?.trim()
		|| path.resolve(process.cwd(), 'brick-snapshot.json');

	const candidates = await collectCandidates();
	if (candidates.length === 0) {
		console.error('[INSPECT] No EV3 candidates found.');
		return 1;
	}

	const snapshots: BrickSnapshot[] = [];
	for (const candidate of candidates) {
		console.log(`[INSPECT] Connecting to ${candidate.displayName} (${candidate.detail})...`);
		try {
			const snapshot = await inspectBrick(candidate, timeoutMs);
			snapshots.push(snapshot);
			console.log(`[INSPECT] Captured ${snapshot.displayName} (${snapshot.brickId}).`);
		} catch (error) {
			console.error(
				`[INSPECT] Failed ${candidate.displayName}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, `${JSON.stringify({ capturedAtIso: new Date().toISOString(), snapshots }, null, 2)}\n`, 'utf8');
	console.log(`[INSPECT] Snapshot written to ${outputPath}`);
	return snapshots.length > 0 ? 0 : 1;
}

if (require.main === module) {
	void main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(`[INSPECT] Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	);
}
