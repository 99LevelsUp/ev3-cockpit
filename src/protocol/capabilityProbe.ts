export interface CapabilityProbeResult {
	osVersion: string;
	hwVersion: string;
	fwVersion: string;
	osBuild: string;
	fwBuild: string;
}

const OP_UI_READ = 0x81;
const GET_OS_VERS = 0x03;
const GET_HW_VERS = 0x09;
const GET_FW_VERS = 0x0a;
const GET_FW_BUILD = 0x0b;
const GET_OS_BUILD = 0x0c;

const LEN_OS_VERS = 16;
const LEN_HW_VERS = 8;
const LEN_FW_VERS = 8;
const LEN_OS_BUILD = 12;
const LEN_FW_BUILD = 12;

const OFF_OS_VERS = 0;
const OFF_HW_VERS = OFF_OS_VERS + LEN_OS_VERS;
const OFF_FW_VERS = OFF_HW_VERS + LEN_HW_VERS;
const OFF_OS_BUILD = OFF_FW_VERS + LEN_FW_VERS;
const OFF_FW_BUILD = OFF_OS_BUILD + LEN_OS_BUILD;
const TOTAL_GLOBAL_BYTES = OFF_FW_BUILD + LEN_FW_BUILD;
export const CAPABILITY_PROBE_GLOBAL_BYTES = TOTAL_GLOBAL_BYTES;

function gvx(offset: number): number[] {
	if (offset < 0) {
		throw new Error(`GV offset must be non-negative. Got ${offset}.`);
	}
	if (offset < 32) {
		return [0x60 | offset];
	}
	if (offset < 256) {
		return [0xe1, offset];
	}
	throw new Error(`GV offset ${offset} is too large for current probe encoder.`);
}

function lcx(value: number): number[] {
	if (value < 0 || value > 31) {
		throw new Error(`LCX small encoder supports only 0..31. Got ${value}.`);
	}
	return [value];
}

function readStringOp(subcommand: number, length: number, offset: number): number[] {
	return [OP_UI_READ, subcommand, ...lcx(length), ...gvx(offset)];
}

export function buildCapabilityProbeDirectPayload(): Uint8Array {
	const allocation = new Uint8Array([TOTAL_GLOBAL_BYTES & 0xff, (TOTAL_GLOBAL_BYTES >> 8) & 0xff]);
	const ops = [
		...readStringOp(GET_OS_VERS, LEN_OS_VERS, OFF_OS_VERS),
		...readStringOp(GET_HW_VERS, LEN_HW_VERS, OFF_HW_VERS),
		...readStringOp(GET_FW_VERS, LEN_FW_VERS, OFF_FW_VERS),
		...readStringOp(GET_OS_BUILD, LEN_OS_BUILD, OFF_OS_BUILD),
		...readStringOp(GET_FW_BUILD, LEN_FW_BUILD, OFF_FW_BUILD)
	];

	return new Uint8Array([...allocation, ...ops]);
}

function parseFixedCString(bytes: Uint8Array, offset: number, length: number): string {
	if (offset >= bytes.length) {
		return '';
	}
	const end = Math.min(bytes.length, offset + length);
	let zeroIndex = end;
	for (let i = offset; i < end; i += 1) {
		if (bytes[i] === 0) {
			zeroIndex = i;
			break;
		}
	}

	const data = bytes.subarray(offset, zeroIndex);
	return Buffer.from(data).toString('utf8').trim();
}

export function parseCapabilityProbeReply(payload: Uint8Array): CapabilityProbeResult {
	return {
		osVersion: parseFixedCString(payload, OFF_OS_VERS, LEN_OS_VERS),
		hwVersion: parseFixedCString(payload, OFF_HW_VERS, LEN_HW_VERS),
		fwVersion: parseFixedCString(payload, OFF_FW_VERS, LEN_FW_VERS),
		osBuild: parseFixedCString(payload, OFF_OS_BUILD, LEN_OS_BUILD),
		fwBuild: parseFixedCString(payload, OFF_FW_BUILD, LEN_FW_BUILD)
	};
}
