/**
 * Runs a composed telemetry frame against a mock brick (step-6 plan U3, owner decision D4;
 * IMPLEMENTATION_PLAN 3.1.7a).
 *
 * The frame is what `buildTelemetryFrame` sends: the declared globals as a little-endian word,
 * then bytecode. The answer is the globals buffer, as a brick's reply payload carries it. Only
 * the opcodes the telemetry rows emit are interpreted. Anything else is an error, never a zero:
 * a mock that answers what it does not understand would let a wrong encoding pass every test.
 *
 * Parameter encoding (`bytecodes.h`, "PARAMETER ENCODING"): bit 7 clear is the short form —
 * bit 6 clear a constant of 6 bits with bit 5 as the sign, bit 6 set a variable with bit 5 for
 * global and 5 bits of offset. Bit 7 set is the long form — bit 6 variable, bit 5 global, the
 * low bits the size that follows (1, 2 or 4 bytes; 4 for a constant string).
 */

import { TransportError } from '../errors';
import {
	COM_GET_SUB, COM_HARDWARE, EV3_OPCODE, INPUT_DEVICE_SUB, UI_BUTTON_SUB, UI_READ_SUB,
} from '../protocol/ev3Packet';

/** `TYPE_NONE` (`bytecodes.h`): nothing on the port. */
const TYPE_NONE = 126;

/** What an unwritten global byte holds in the mock: not zero, as on a brick. */
const UNWRITTEN = 0xa5;

/** One port as the mock brick reports it. */
export interface MockPortReading {
	readonly typeCode: number;
	readonly mode: number;
	/** The reading; NaN where the firmware would answer `DATAF_NAN`. */
	readonly value: number;
}

/** What a frame can ask of the mock brick. */
export interface MockBrickView {
	/** Sensor ports by the firmware's number, 0–3. */
	sensor(index: number): MockPortReading;
	/** Motor ports by `opOUTPUT_GET_COUNT`'s number, 0–3. */
	motor(index: number): MockPortReading;
	readonly batteryLevel: number;
	readonly batteryVoltage: number;
	readonly brickName: string;
	readonly firmwareVersion: string;
	readonly bluetoothOn: boolean;
	readonly bluetoothVisible: boolean;
	readonly bluetoothPeers: number;
	readonly wifiOn: boolean;
	readonly wifiPresent: boolean;
}

type Parameter = { readonly global: number } | { readonly constant: number };

/** Runs `frame` and returns the globals it filled. Throws `TransportError` where a brick would fail the command. */
export function executeTelemetryFrame(frame: Uint8Array, brick: MockBrickView): Uint8Array {
	if (frame.length < 2) { throw new TransportError('A telemetry frame needs its globals word.'); }
	// The brick does not clear its global buffer: a byte no instruction wrote holds what the
	// previous command left (verified on hardware, `ev3Responses.ts`). Filled with a pattern, so a
	// parser that trusts an unwritten byte fails here as it would on a brick.
	const globals = new Uint8Array(frame[0] | (frame[1] << 8)).fill(UNWRITTEN);
	const view = new DataView(globals.buffer);
	let ip = 2;

	const byte = (): number => {
		if (ip >= frame.length) { throw new TransportError('The frame ends inside an instruction.'); }
		return frame[ip++];
	};
	const parameter = (): Parameter => {
		const first = byte();
		if ((first & 0x80) === 0) {
			if ((first & 0x40) === 0) {
				const v = first & 0x1f;
				return { constant: (first & 0x20) ? v - 32 : v };
			}
			if ((first & 0x20) === 0) { throw new TransportError('A telemetry frame has no locals.'); }
			return { global: first & 0x1f };
		}
		const size = first & 0x07;
		const bytes = size === 1 ? 1 : size === 2 ? 2 : size === 3 ? 4 : 0;
		if (bytes === 0) { throw new TransportError(`Parameter form 0x${first.toString(16)} is not interpreted.`); }
		let value = 0;
		for (let i = 0; i < bytes; i += 1) { value |= byte() << (8 * i); }
		if ((first & 0x40) !== 0) {
			if ((first & 0x20) === 0) { throw new TransportError('A telemetry frame has no locals.'); }
			return { global: value >>> 0 };
		}
		const bits = bytes * 8;
		const signed = bits === 32 ? value | 0 : (value << (32 - bits)) >> (32 - bits);
		return { constant: signed };
	};
	const constant = (): number => {
		const p = parameter();
		if (!('constant' in p)) { throw new TransportError('Expected a constant parameter.'); }
		return p.constant;
	};
	const global = (width: number): number => {
		const p = parameter();
		if (!('global' in p)) { throw new TransportError('Expected a global parameter.'); }
		if (p.global + width > globals.length) {
			throw new TransportError(`The frame writes global bytes ${p.global}–${p.global + width - 1} but declared ${globals.length}.`);
		}
		return p.global;
	};
	const port = (layer: number, number: number): MockPortReading => {
		// One brick: a layer down the daisy chain has nothing on it.
		if (layer !== 0) { return { typeCode: TYPE_NONE, mode: 0, value: Number.NaN }; }
		if (number >= 0 && number <= 3) { return brick.sensor(number); }
		if (number >= 16 && number <= 19) { return brick.motor(number - 16); }
		throw new TransportError(`Port ${number} does not exist.`);
	};
	const text = (offset: number, length: number, value: string): void => {
		const bytes = Buffer.from(value, 'utf8').subarray(0, Math.max(0, length - 1));
		globals.set(bytes, offset);
		globals[offset + bytes.length] = 0;
	};

	while (ip < frame.length) {
		const opcode = byte();
		switch (opcode) {
		case EV3_OPCODE.INPUT_DEVICE: {
			const sub = constant();
			if (sub !== INPUT_DEVICE_SUB.GET_TYPEMODE) { throw new TransportError(`INPUT_DEVICE subcode ${sub} is not interpreted.`); }
			const reading = port(constant(), constant());
			globals[global(1)] = reading.typeCode;
			globals[global(1)] = reading.mode;
			break;
		}
		case EV3_OPCODE.INPUT_READ_SI: {
			const reading = port(constant(), constant());
			constant(); constant();   // type hint and mode: the mock reports the configured value
			const at = global(4);
			if (at % 4 !== 0) { throw new TransportError(`opINPUT_READSI into unaligned global ${at}: the brick answers an error.`); }
			view.setFloat32(at, reading.value, true);
			break;
		}
		case EV3_OPCODE.OUTPUT_GET_COUNT: {
			const layer = constant();
			const motor = constant();
			const reading = layer === 0 ? brick.motor(motor) : { typeCode: TYPE_NONE, mode: 0, value: Number.NaN };
			view.setInt32(global(4), Number.isFinite(reading.value) ? Math.round(reading.value) : 0, true);
			break;
		}
		case EV3_OPCODE.UI_READ: {
			const sub = constant();
			if (sub === UI_READ_SUB.GET_LBATT) { globals[global(1)] = brick.batteryLevel; }
			else if (sub === UI_READ_SUB.GET_VBATT) { view.setFloat32(global(4), brick.batteryVoltage, true); }
			else if (sub === UI_READ_SUB.GET_FW_VERS) { const length = constant(); text(global(length), length, brick.firmwareVersion); }
			else { throw new TransportError(`UI_READ subcode ${sub} is not interpreted.`); }
			break;
		}
		case EV3_OPCODE.UI_BUTTON: {
			const sub = constant();
			if (sub !== UI_BUTTON_SUB.PRESSED) { throw new TransportError(`UI_BUTTON subcode ${sub} is not interpreted.`); }
			constant();
			globals[global(1)] = 0;   // nobody presses a mock brick's buttons
			break;
		}
		case EV3_OPCODE.COM_GET: {
			const sub = constant();
			if (sub === COM_GET_SUB.GET_BRICKNAME) { const length = constant(); text(global(length), length, brick.brickName); break; }
			const hardware = constant();
			let answer: number;
			if (sub === COM_GET_SUB.GET_ON_OFF) {
				// c_com.c 4296–4330: the USB case leaves the dispatch status at FAILBREAK, which ends
				// the whole direct command (lms2012.c 2496–2510).
				if (hardware === COM_HARDWARE.USB) { throw new TransportError('GET_ON_OFF of USB: the brick ends the command with FAILBREAK.'); }
				answer = hardware === COM_HARDWARE.BT ? Number(brick.bluetoothOn) : Number(brick.wifiOn);
			} else if (sub === COM_GET_SUB.GET_VISIBLE) {
				answer = Number(brick.bluetoothVisible);   // the Bluetooth flag, whatever radio is named
			} else if (sub === COM_GET_SUB.GET_PRESENT) {
				answer = hardware === COM_HARDWARE.WIFI ? Number(brick.wifiPresent) : 1;
			} else if (sub === COM_GET_SUB.FAVOUR_ITEMS) {
				answer = hardware === COM_HARDWARE.BT ? brick.bluetoothPeers : 0;
			} else {
				throw new TransportError(`COM_GET subcode ${sub} is not interpreted.`);
			}
			globals[global(1)] = answer;
			break;
		}
		default:
			throw new TransportError(`Opcode 0x${opcode.toString(16)} is not interpreted by the mock brick.`);
		}
	}
	return globals;
}
