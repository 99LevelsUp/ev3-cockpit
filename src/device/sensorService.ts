import { Logger, NoopLogger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, lc0, uint16le, gv0 } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import type { SensorPort, SensorInfo, SensorReading, SensorMode } from './sensorTypes';
import { SENSOR_PORTS, sensorTypeName, isSensorConnected } from './sensorTypes';

const OP = {
	INPUT_DEVICE: 0x99,
	INPUT_READ_SI: 0x9a
} as const;

const INPUT_DEVICE_SUB = {
	GET_TYPEMODE: 0x05
} as const;

const LAYER_SELF = 0x00;

interface SensorServiceOptions {
	commandClient: Ev3CommandSendLike;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

const DEFAULT_SENSOR_TIMEOUT_MS = 2000;

export class SensorService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;

	public constructor(options: SensorServiceOptions) {
		this.commandClient = options.commandClient;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SENSOR_TIMEOUT_MS;
		this.logger = options.logger ?? new NoopLogger();
	}

	/**
	 * Detect what sensor/device is connected to a single port.
	 * Uses opINPUT_DEVICE(GET_TYPEMODE) → returns type + mode.
	 */
	public async probePort(port: SensorPort): Promise<SensorInfo> {
		// Direct command: 2 global bytes for reply (type + mode)
		// opINPUT_DEVICE, GET_TYPEMODE, LAYER, PORT, GV0(type), GV0(mode)
		const payload = concatBytes(
			uint16le(2),
			new Uint8Array([OP.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
			lc0(LAYER_SELF),
			lc0(port),
			gv0(0),
			gv0(1)
		);

		const requestId = `sensor-probe-${port}-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			this.logger.warn('Sensor probe failed with DIRECT_REPLY_ERROR', { port, requestId });
			return { port, typeCode: 0, mode: 0, connected: false, typeName: 'NONE' };
		}

		const replyPayload = result.reply.payload;
		const typeCode = replyPayload.length >= 1 ? replyPayload[0] : 0;
		const mode = replyPayload.length >= 2 ? replyPayload[1] : 0;

		return {
			port,
			typeCode,
			mode,
			connected: isSensorConnected(typeCode),
			typeName: sensorTypeName(typeCode)
		};
	}

	/**
	 * Probe all 4 sensor ports and return their info.
	 */
	public async probeAll(): Promise<SensorInfo[]> {
		const results: SensorInfo[] = [];
		for (const port of SENSOR_PORTS) {
			results.push(await this.probePort(port));
		}
		return results;
	}

	/**
	 * Read sensor value in SI units from a port.
	 * Uses opINPUT_READ_SI → returns float32.
	 */
	public async readSensor(port: SensorPort, typeCode: number, mode: SensorMode): Promise<SensorReading> {
		// Direct command: 4 global bytes for float reply
		// opINPUT_READ_SI, LAYER, PORT, TYPE, MODE, GV0(value)
		const payload = concatBytes(
			uint16le(4),
			new Uint8Array([OP.INPUT_READ_SI]),
			lc0(LAYER_SELF),
			lc0(port),
			lc0(typeCode > 31 ? 0 : typeCode),
			lc0(mode > 31 ? 0 : mode),
			gv0(0)
		);

		const requestId = `sensor-read-${port}-${this.nextSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: true,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
			throw new Error(`Sensor read failed on port ${port + 1}: DIRECT_REPLY_ERROR`);
		}

		const replyPayload = result.reply.payload;
		let value = 0;
		if (replyPayload.length >= 4) {
			value = new DataView(replyPayload.buffer, replyPayload.byteOffset, replyPayload.byteLength)
				.getFloat32(0, true);
		}

		return {
			port,
			typeCode,
			mode,
			value,
			timestampMs: Date.now()
		};
	}

	private nextSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
