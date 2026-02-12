import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import type { MockTransportResponder } from '../transport/mockTransportAdapter';
import type { MockSensorState } from './state/mockSensorState';
import type { MockMotorState } from './state/mockMotorState';
import type { MockBrickState } from './state/mockBrickState';
import type { MockFsTree } from './fs/mockFsTree';
import type { MotorPort } from '../device/motorTypes';

// ---------------------------------------------------------------------------
// EV3 opcode constants (for decoding incoming commands)
// ---------------------------------------------------------------------------

const OP = {
	INPUT_DEVICE: 0x99,
	INPUT_READ_SI: 0x9a,
	OUTPUT_SPEED: 0xa5,
	OUTPUT_START: 0xa6,
	OUTPUT_STOP: 0xa3,
	OUTPUT_RESET: 0xa2,
	OUTPUT_GET_COUNT: 0xb3,
	UI_READ: 0x81,
	UI_WRITE: 0x82,
	INFO: 0x7c,
	SOUND: 0x94
} as const;

const INPUT_DEVICE_SUB = { GET_TYPEMODE: 0x05, SET_TYPEMODE: 0x01 } as const;
const UI_READ_SUB = {
	GET_VBATT: 0x01, GET_LBATT: 0x12, GET_VOLUME: 0x1a,
	GET_SLEEP: 0x0e, GET_PRESS: 0x0d
} as const;
const UI_WRITE_SUB = {
	SET_VOLUME: 0x06, SET_SLEEP: 0x07, LED: 0x1b
} as const;
const INFO_SUB = { GET_BRICKNAME: 0x0d, SET_BRICKNAME: 0x08 } as const;

// System command opcodes
const SYS = {
	BEGIN_DOWNLOAD: 0x92,
	CONTINUE_DOWNLOAD: 0x93,
	BEGIN_UPLOAD: 0x94,
	CONTINUE_UPLOAD: 0x95,
	CLOSE_FILEHANDLE: 0x98,
	LIST_FILES: 0x99,
	CONTINUE_LIST_FILES: 0x9a,
	CREATE_DIR: 0x9b,
	DELETE_FILE: 0x9c
} as const;

const SYS_STATUS = { OK: 0x00, EOF: 0x08 } as const;

// ---------------------------------------------------------------------------
// LC decoding helpers — read literal constant from bytecode stream
// ---------------------------------------------------------------------------

interface DecodeResult { value: number; bytesConsumed: number; }

function decodeLc(data: Uint8Array, offset: number): DecodeResult {
	if (offset >= data.length) { return { value: 0, bytesConsumed: 0 }; }
	const b = data[offset];

	// LC0: bits 7..6 = 00, value in bits 5..0 (sign-extended 6-bit)
	if ((b & 0xc0) === 0x00) {
		const raw = b & 0x3f;
		const value = (raw & 0x20) ? raw - 0x40 : raw; // sign-extend
		return { value, bytesConsumed: 1 };
	}

	// LC1: first byte = 0x81
	if (b === 0x81 && offset + 1 < data.length) {
		const raw = data[offset + 1];
		const value = raw > 127 ? raw - 256 : raw; // sign-extend
		return { value, bytesConsumed: 2 };
	}

	// LC2: first byte = 0x82
	if (b === 0x82 && offset + 2 < data.length) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const value = view.getInt16(offset + 1, true);
		return { value, bytesConsumed: 3 };
	}

	// GV0: bits 7..5 = 011 → global variable reference (we just skip)
	if ((b & 0xe0) === 0x60) {
		return { value: b & 0x1f, bytesConsumed: 1 };
	}

	return { value: b, bytesConsumed: 1 };
}

// ---------------------------------------------------------------------------
// Helpers to build reply payloads
// ---------------------------------------------------------------------------

function float32Bytes(value: number): Uint8Array {
	const buf = new Uint8Array(4);
	new DataView(buf.buffer).setFloat32(0, value, true);
	return buf;
}

function int32Bytes(value: number): Uint8Array {
	const buf = new Uint8Array(4);
	new DataView(buf.buffer).setInt32(0, value, true);
	return buf;
}



// ---------------------------------------------------------------------------
// Motor port mask → MotorPort letter
// ---------------------------------------------------------------------------

const MASK_TO_PORT: Record<number, MotorPort> = {
	0x01: 'A', 0x02: 'B', 0x04: 'C', 0x08: 'D'
};

// ---------------------------------------------------------------------------
// MockCommandResponder
// ---------------------------------------------------------------------------

export interface MockCommandResponderDeps {
	sensors: MockSensorState;
	motors: MockMotorState;
	brick: MockBrickState;
	fs: MockFsTree;
}

/**
 * Creates a `MockTransportResponder` that decodes EV3 packets, routes them
 * to the appropriate mock state, and returns proper EV3 reply packets.
 */
export function createMockCommandResponder(deps: MockCommandResponderDeps): MockTransportResponder {
	/** Next file handle for system commands. */
	let nextHandle = 1;
	/** In-progress upload state (handle → { data, offset }). */
	const uploads = new Map<number, { data: Uint8Array; offset: number }>();
	/** In-progress download state (handle → { path, chunks }). */
	const downloads = new Map<number, { path: string; chunks: Uint8Array[] }>();
	/** In-progress list state (handle → { text, offset }). */
	const listings = new Map<number, { text: string; offset: number }>();

	return (packet) => {
		const request = decodeEv3Packet(packet);
		const isSystem = request.type === EV3_COMMAND.SYSTEM_COMMAND_REPLY
			|| request.type === EV3_COMMAND.SYSTEM_COMMAND_NO_REPLY;

		if (isSystem) {
			const replyPayload = handleSystemCommand(request.payload, deps, {
				nextHandle: () => nextHandle++, uploads, downloads, listings
			});
			return encodeEv3Packet(request.messageCounter, EV3_REPLY.SYSTEM_REPLY, replyPayload);
		}

		const replyPayload = handleDirectCommand(request.payload, deps);
		return encodeEv3Packet(request.messageCounter, EV3_REPLY.DIRECT_REPLY, replyPayload);
	};
}

// ---------------------------------------------------------------------------
// Direct command handler
// ---------------------------------------------------------------------------

function handleDirectCommand(payload: Uint8Array, deps: MockCommandResponderDeps): Uint8Array {
	// First 2 bytes: uint16le globalVarsSize
	if (payload.length < 2) { return new Uint8Array(0); }
	const globalVarsSize = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, true);
	const replyBuf = new Uint8Array(globalVarsSize);

	let pos = 2; // skip globalVarsSize

	while (pos < payload.length) {
		const opcode = payload[pos];
		pos += 1;

		switch (opcode) {
			case OP.INPUT_DEVICE: {
				const sub = payload[pos];
				pos += 1;
				if (sub === INPUT_DEVICE_SUB.GET_TYPEMODE) {
					const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
					const { value: port, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
					const { value: gvType, bytesConsumed: bc3 } = decodeLc(payload, pos); pos += bc3;
					const { value: gvMode, bytesConsumed: bc4 } = decodeLc(payload, pos); pos += bc4;
					const sensorPort = (port & 0x03) as 0 | 1 | 2 | 3;
					replyBuf[gvType] = deps.sensors.getTypeCode(sensorPort);
					replyBuf[gvMode] = deps.sensors.getMode(sensorPort);
				} else if (sub === INPUT_DEVICE_SUB.SET_TYPEMODE) {
					const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
					const { value: port, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
					const { value: tc, bytesConsumed: bc3 } = decodeLc(payload, pos); pos += bc3;
					const { value: mode, bytesConsumed: bc4 } = decodeLc(payload, pos); pos += bc4;
					deps.sensors.setMode((port & 0x03) as 0 | 1 | 2 | 3, tc, mode);
				}
				break;
			}

			case OP.INPUT_READ_SI: {
				const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
				const { value: port, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
				const { bytesConsumed: bc3 } = decodeLc(payload, pos); pos += bc3; // type
				const { bytesConsumed: bc4 } = decodeLc(payload, pos); pos += bc4; // mode
				const { value: gvOff, bytesConsumed: bc5 } = decodeLc(payload, pos); pos += bc5;
				const sensorPort = (port & 0x03) as 0 | 1 | 2 | 3;
				const val = deps.sensors.readValue(sensorPort);
				replyBuf.set(float32Bytes(val), gvOff);
				break;
			}

			case OP.OUTPUT_SPEED: {
				const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
				const { value: mask, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
				const { value: speed, bytesConsumed: bc3 } = decodeLc(payload, pos); pos += bc3;
				const port = MASK_TO_PORT[mask];
				if (port) { deps.motors.setSpeed(port, speed); }
				break;
			}

			case OP.OUTPUT_START: {
				const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
				const { value: mask, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
				const port = MASK_TO_PORT[mask];
				if (port) { deps.motors.start(port); }
				break;
			}

			case OP.OUTPUT_STOP: {
				const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
				const { value: mask, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
				const { value: brake, bytesConsumed: bc3 } = decodeLc(payload, pos); pos += bc3;
				const port = MASK_TO_PORT[mask];
				if (port) { deps.motors.stop(port, brake !== 0); }
				break;
			}

			case OP.OUTPUT_RESET: {
				const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
				const { value: mask, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
				const port = MASK_TO_PORT[mask];
				if (port) { deps.motors.resetTacho(port); }
				break;
			}

			case OP.OUTPUT_GET_COUNT: {
				const { bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1; // layer
				const { value: portIndex, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
				const { value: gvOff, bytesConsumed: bc3 } = decodeLc(payload, pos); pos += bc3;
				const ports: MotorPort[] = ['A', 'B', 'C', 'D'];
				const port = ports[portIndex & 0x03];
				replyBuf.set(int32Bytes(deps.motors.readTacho(port)), gvOff);
				break;
			}

			case OP.UI_READ: {
				const sub = payload[pos]; pos += 1;
				switch (sub) {
					case UI_READ_SUB.GET_VBATT: {
						const { value: gv, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						replyBuf.set(float32Bytes(deps.brick.getBatteryVoltage()), gv);
						break;
					}
					case UI_READ_SUB.GET_LBATT: {
						const { value: gv, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						replyBuf.set(float32Bytes(deps.brick.getBatteryCurrent()), gv);
						break;
					}
					case UI_READ_SUB.GET_VOLUME: {
						const { value: gv, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						replyBuf[gv] = deps.brick.getVolume();
						break;
					}
					case UI_READ_SUB.GET_SLEEP: {
						const { value: gv, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						replyBuf[gv] = deps.brick.getSleepMinutes();
						break;
					}
					case UI_READ_SUB.GET_PRESS: {
						const { value: gv, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						replyBuf[gv] = deps.brick.getButtonPress();
						break;
					}
					default:
						pos += 1; // skip unknown subcode arg
				}
				break;
			}

			case OP.UI_WRITE: {
				const sub = payload[pos]; pos += 1;
				switch (sub) {
					case UI_WRITE_SUB.LED: {
						const { value: pattern } = decodeLc(payload, pos); pos += 1;
						deps.brick.setLedPattern(pattern as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9);
						break;
					}
					case UI_WRITE_SUB.SET_VOLUME: {
						const { value: vol, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						deps.brick.setVolume(vol);
						break;
					}
					case UI_WRITE_SUB.SET_SLEEP: {
						const { value: mins, bytesConsumed: bc } = decodeLc(payload, pos); pos += bc;
						deps.brick.setSleepMinutes(mins);
						break;
					}
					default:
						pos += 1;
				}
				break;
			}

			case OP.INFO: {
				const sub = payload[pos]; pos += 1;
				if (sub === INFO_SUB.GET_BRICKNAME) {
					const { value: maxLen, bytesConsumed: bc1 } = decodeLc(payload, pos); pos += bc1;
					const { value: gv, bytesConsumed: bc2 } = decodeLc(payload, pos); pos += bc2;
					const nameBytes = Buffer.from(deps.brick.getName(), 'utf8');
					const copyLen = Math.min(nameBytes.length, maxLen - 1, globalVarsSize - gv - 1);
					for (let i = 0; i < copyLen; i++) { replyBuf[gv + i] = nameBytes[i]; }
					replyBuf[gv + copyLen] = 0; // null-terminate
				} else if (sub === INFO_SUB.SET_BRICKNAME) {
					// LCS-encoded string follows
					if (payload[pos] === 0x84) { pos += 1; } // skip LCS marker
					let name = '';
					while (pos < payload.length && payload[pos] !== 0) {
						name += String.fromCharCode(payload[pos]);
						pos += 1;
					}
					if (pos < payload.length) { pos += 1; } // skip null terminator
					deps.brick.setName(name);
				}
				break;
			}

			case OP.SOUND:
				// Skip sound commands — just acknowledge
				pos = payload.length;
				break;

			default:
				// Unknown opcode — skip remaining payload
				pos = payload.length;
				break;
		}
	}

	return replyBuf;
}

// ---------------------------------------------------------------------------
// System command handler
// ---------------------------------------------------------------------------

interface SysState {
	nextHandle: () => number;
	uploads: Map<number, { data: Uint8Array; offset: number }>;
	downloads: Map<number, { path: string; chunks: Uint8Array[] }>;
	listings: Map<number, { text: string; offset: number }>;
}

function handleSystemCommand(
	payload: Uint8Array,
	deps: MockCommandResponderDeps,
	state: SysState
): Uint8Array {
	if (payload.length === 0) { return new Uint8Array([0x00, 0x00]); }

	const opcode = payload[0];

	switch (opcode) {
		case SYS.LIST_FILES: {
			// payload: opcode(1) + maxBytes(2) + path(null-terminated)
			const path = readCString(payload, 3);
			const entries = deps.fs.listDir(path);
			if (!entries) {
				return new Uint8Array([opcode, 0x04]); // UNKNOWN_ERROR
			}

			// Build EV3 listing format: "md5 size name\n" for files, "name/\n" for dirs
			let listing = '';
			for (const e of entries) {
				if (e.isDir) {
					listing += `${e.name}/\n`;
				} else {
					const md5 = '00000000000000000000000000000000';
					const hexSize = e.size.toString(16).padStart(8, '0').toUpperCase();
					listing += `${md5} ${hexSize} ${e.name}\n`;
				}
			}

			const handle = state.nextHandle();
			const textBytes = Buffer.from(listing, 'utf8');
			const totalLen = textBytes.length;

			if (totalLen === 0) {
				// Empty directory
				const reply = new Uint8Array(6);
				reply[0] = opcode;
				reply[1] = SYS_STATUS.EOF;
				new DataView(reply.buffer).setUint32(2, 0, true);
				return reply;
			}

			state.listings.set(handle, { text: listing, offset: textBytes.length });
			// Format: [opcode, status, uint32(totalLen), handle, ...data]
			const result = new Uint8Array(7 + textBytes.length);
			result[0] = opcode;
			result[1] = SYS_STATUS.EOF;
			new DataView(result.buffer).setUint32(2, totalLen, true);
			result[6] = handle;
			result.set(textBytes, 7);
			return result;
		}

		case SYS.BEGIN_UPLOAD: {
			// payload: opcode(1) + maxChunkSize(2) + path(null-terminated)
			const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
			const maxChunk = view.getUint16(1, true);
			const path = readCString(payload, 3);
			const data = deps.fs.readFile(path);
			if (!data) {
				return new Uint8Array([opcode, 0x04]); // UNKNOWN_ERROR
			}

			const handle = state.nextHandle();
			const chunk = data.subarray(0, maxChunk);
			const remaining = data.subarray(maxChunk);

			if (remaining.length > 0) {
				state.uploads.set(handle, { data, offset: chunk.length });
			}

			const status = remaining.length > 0 ? SYS_STATUS.OK : SYS_STATUS.EOF;
			// Format: [opcode, status, uint32(totalLen), handle, ...data]
			const result = new Uint8Array(7 + chunk.length);
			result[0] = opcode;
			result[1] = status;
			new DataView(result.buffer).setUint32(2, data.length, true);
			result[6] = handle;
			result.set(chunk, 7);
			return result;
		}

		case SYS.CONTINUE_UPLOAD: {
			// payload: opcode(1) + handle(1) + maxChunkSize(2)
			const handle = payload[1];
			const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
			const maxChunk = view.getUint16(2, true);
			const upload = state.uploads.get(handle);
			if (!upload) {
				return new Uint8Array([opcode, 0x04]);
			}

			const chunk = upload.data.subarray(upload.offset, upload.offset + maxChunk);
			upload.offset += chunk.length;

			const done = upload.offset >= upload.data.length;
			if (done) { state.uploads.delete(handle); }

			const result = new Uint8Array(2 + chunk.length);
			result[0] = opcode;
			result[1] = done ? SYS_STATUS.EOF : SYS_STATUS.OK;
			result.set(chunk, 2);
			return result;
		}

		case SYS.BEGIN_DOWNLOAD: {
			// payload: opcode(1) + fileSize(4) + path(null-terminated)
			const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
			const _fileSize = view.getUint32(1, true); // eslint-disable-line @typescript-eslint/no-unused-vars
			const path = readCString(payload, 5);
			const handle = state.nextHandle();
			state.downloads.set(handle, { path, chunks: [] });
			return new Uint8Array([opcode, SYS_STATUS.OK, handle]);
		}

		case SYS.CONTINUE_DOWNLOAD: {
			// payload: opcode(1) + handle(1) + data(...)
			const handle = payload[1];
			const dl = state.downloads.get(handle);
			if (!dl) {
				return new Uint8Array([opcode, 0x04]);
			}
			dl.chunks.push(payload.subarray(2));
			return new Uint8Array([opcode, SYS_STATUS.OK, handle]);
		}

		case SYS.CLOSE_FILEHANDLE: {
			const handle = payload[1];
			// Finalize any downloads
			const dl = state.downloads.get(handle);
			if (dl) {
				const totalLen = dl.chunks.reduce((s, c) => s + c.length, 0);
				const data = new Uint8Array(totalLen);
				let off = 0;
				for (const c of dl.chunks) { data.set(c, off); off += c.length; }
				deps.fs.writeFile(dl.path, data);
				state.downloads.delete(handle);
			}
			state.uploads.delete(handle);
			state.listings.delete(handle);
			return new Uint8Array([opcode, SYS_STATUS.OK]);
		}

		case SYS.CREATE_DIR: {
			const path = readCString(payload, 1);
			deps.fs.mkdir(path);
			return new Uint8Array([opcode, SYS_STATUS.OK]);
		}

		case SYS.DELETE_FILE: {
			const path = readCString(payload, 1);
			deps.fs.deleteFile(path);
			return new Uint8Array([opcode, SYS_STATUS.OK]);
		}

		default:
			return new Uint8Array([opcode, 0x00]);
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function readCString(data: Uint8Array, offset: number): string {
	let str = '';
	for (let i = offset; i < data.length; i++) {
		if (data[i] === 0) { break; }
		str += String.fromCharCode(data[i]);
	}
	return str;
}
