import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockCommandResponder } from '../mock/mockCommandResponder';
import { MockSensorState } from '../mock/state/mockSensorState';
import { MockMotorState } from '../mock/state/mockMotorState';
import { MockBrickState } from '../mock/state/mockBrickState';
import { MockFsTree } from '../mock/fs/mockFsTree';
import { EV3_SENSOR_TYPE } from '../device/sensorTypes';
import { concatBytes, lc0, lc1, uint16le, gv0, lcs } from '../protocol/ev3Bytecode';
import { encodeEv3Packet, decodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps() {
	const sensors = new MockSensorState([
		{ port: 0, typeCode: EV3_SENSOR_TYPE.EV3_TOUCH, mode: 0, generator: { kind: 'constant', value: 1 } },
		{ port: 2, typeCode: EV3_SENSOR_TYPE.EV3_COLOR, mode: 0, generator: { kind: 'constant', value: 5.5 } }
	]);
	const motors = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 100 }
	]);
	const brick = new MockBrickState({
		name: 'TestEV3', firmwareVersion: 'V1.10E',
		batteryVoltage: 7.5, batteryCurrent: 0.15,
		batteryDrainRate: 0, volume: 80, sleepMinutes: 30
	});
	const fs = new MockFsTree();
	fs.writeFile('/home/root/lms2012/prjs/Test/main.rbf', new Uint8Array([0x4c, 0x45, 0x47, 0x4f]));
	return { sensors, motors, brick, fs };
}

function sendDirect(responder: ReturnType<typeof createMockCommandResponder>, payload: Uint8Array, msgCounter = 1) {
	const packet = encodeEv3Packet(msgCounter, EV3_COMMAND.DIRECT_COMMAND_REPLY, payload);
	const reply = responder(packet, {} as never);
	return decodeEv3Packet(reply as Uint8Array);
}

function sendSystem(responder: ReturnType<typeof createMockCommandResponder>, payload: Uint8Array, msgCounter = 1) {
	const packet = encodeEv3Packet(msgCounter, EV3_COMMAND.SYSTEM_COMMAND_REPLY, payload);
	const reply = responder(packet, {} as never);
	return decodeEv3Packet(reply as Uint8Array);
}

// ---------------------------------------------------------------------------
// Direct commands: Sensors
// ---------------------------------------------------------------------------

test('responder: INPUT_DEVICE GET_TYPEMODE returns sensor type + mode', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	// opINPUT_DEVICE, GET_TYPEMODE(0x05), LAYER(0), PORT(0), GV0(0), GV0(1)
	const payload = concatBytes(
		uint16le(2),
		new Uint8Array([0x99, 0x05]),
		lc0(0), // layer
		lc0(0), // port 0
		gv0(0), // type → global byte 0
		gv0(1)  // mode → global byte 1
	);

	const reply = sendDirect(responder, payload);
	assert.equal(reply.type, EV3_REPLY.DIRECT_REPLY);
	assert.equal(reply.payload[0], EV3_SENSOR_TYPE.EV3_TOUCH);
	assert.equal(reply.payload[1], 0); // mode
});

test('responder: INPUT_READ_SI returns float32 sensor value', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	// opINPUT_READ_SI(0x9a), LAYER(0), PORT(2), TYPE(0), MODE(0), GV0(0)
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([0x9a]),
		lc0(0), lc0(2), lc0(0), lc0(0), gv0(0)
	);

	const reply = sendDirect(responder, payload);
	assert.equal(reply.type, EV3_REPLY.DIRECT_REPLY);
	const value = new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength)
		.getFloat32(0, true);
	assert.ok(Math.abs(value - 5.5) < 0.01, `expected ~5.5, got ${value}`);
});

// ---------------------------------------------------------------------------
// Direct commands: Motors
// ---------------------------------------------------------------------------

test('responder: OUTPUT_SPEED + OUTPUT_START sets motor state', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(0),
		new Uint8Array([0xa5]), lc0(0), lc0(0x01), lc1(50), // speed A=50
		new Uint8Array([0xa6]), lc0(0), lc0(0x01)            // start A
	);

	sendDirect(responder, payload);
	assert.equal(deps.motors.getSpeed('A'), 50);
	assert.equal(deps.motors.isRunning('A'), true);
});

test('responder: OUTPUT_GET_COUNT returns tacho position', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	// opOUTPUT_GET_COUNT(0xb3), LAYER(0), PORT_INDEX(0=A), GV0(0)
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([0xb3]),
		lc0(0), lc0(0), gv0(0)
	);

	const reply = sendDirect(responder, payload);
	const position = new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength)
		.getInt32(0, true);
	assert.equal(position, 100); // initial position from config
});

test('responder: OUTPUT_STOP with brake zeroes speed', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	// Set speed + start
	const startPayload = concatBytes(
		uint16le(0),
		new Uint8Array([0xa5]), lc0(0), lc0(0x01), lc1(75),
		new Uint8Array([0xa6]), lc0(0), lc0(0x01)
	);
	sendDirect(responder, startPayload);

	// Stop with brake
	const stopPayload = concatBytes(
		uint16le(0),
		new Uint8Array([0xa3]), lc0(0), lc0(0x01), lc0(1) // brake=1
	);
	sendDirect(responder, stopPayload);
	assert.equal(deps.motors.isRunning('A'), false);
	assert.equal(deps.motors.getSpeed('A'), 0);
});

test('responder: OUTPUT_RESET zeroes tacho', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(0),
		new Uint8Array([0xa2]), lc0(0), lc0(0x01) // reset A
	);
	sendDirect(responder, payload);
	assert.equal(deps.motors.readTacho('A'), 0);
});

// ---------------------------------------------------------------------------
// Direct commands: UI_READ / UI_WRITE
// ---------------------------------------------------------------------------

test('responder: UI_READ GET_VBATT returns float32 voltage', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([0x81, 0x01]), // opUI_READ, GET_VBATT
		gv0(0)
	);

	const reply = sendDirect(responder, payload);
	const volts = new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength)
		.getFloat32(0, true);
	assert.ok(Math.abs(volts - 7.5) < 0.01);
});

test('responder: UI_READ GET_VOLUME returns byte', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(1),
		new Uint8Array([0x81, 0x1a]), // opUI_READ, GET_VOLUME
		gv0(0)
	);

	const reply = sendDirect(responder, payload);
	assert.equal(reply.payload[0], 80);
});

test('responder: UI_WRITE LED sets pattern on brick', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(0),
		new Uint8Array([0x82, 0x1b]), // opUI_WRITE, LED
		lc0(5) // red-flash
	);
	sendDirect(responder, payload);
	assert.equal(deps.brick.getLedPattern(), 5);
});

test('responder: UI_WRITE SET_VOLUME updates volume', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(0),
		new Uint8Array([0x82, 0x06]), // opUI_WRITE, SET_VOLUME
		lc0(30)
	);
	sendDirect(responder, payload);
	assert.equal(deps.brick.getVolume(), 30);
});

// ---------------------------------------------------------------------------
// Direct commands: INFO
// ---------------------------------------------------------------------------

test('responder: INFO GET_BRICKNAME returns name', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(13),
		new Uint8Array([0x7c, 0x0d]), // opINFO, GET_BRICKNAME
		lc0(13), // maxLen
		gv0(0)
	);

	const reply = sendDirect(responder, payload);
	let name = '';
	for (let i = 0; i < reply.payload.length; i++) {
		if (reply.payload[i] === 0) { break; }
		name += String.fromCharCode(reply.payload[i]);
	}
	assert.equal(name, 'TestEV3');
});

test('responder: INFO SET_BRICKNAME changes name', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const payload = concatBytes(
		uint16le(0),
		new Uint8Array([0x7c, 0x08]), // opINFO, SET_BRICKNAME
		lcs('NewName')
	);
	sendDirect(responder, payload);
	assert.equal(deps.brick.getName(), 'NewName');
});

// ---------------------------------------------------------------------------
// System commands: FS
// ---------------------------------------------------------------------------

test('responder: LIST_FILES returns directory listing', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const pathBytes = Buffer.from('/home/root/lms2012/prjs/Test/\0', 'utf8');
	const sysPayload = new Uint8Array(3 + pathBytes.length);
	sysPayload[0] = 0x99; // LIST_FILES
	new DataView(sysPayload.buffer).setUint16(1, 1024, true);
	sysPayload.set(pathBytes, 3);

	const reply = sendSystem(responder, sysPayload);
	assert.equal(reply.type, EV3_REPLY.SYSTEM_REPLY);
	assert.equal(reply.payload[0], 0x99); // opcode echo
	// Payload should contain "main.rbf" in the listing
	const text = Buffer.from(reply.payload.subarray(7)).toString('utf8');
	assert.ok(text.includes('main.rbf'), `listing should contain main.rbf, got: ${text}`);
});

test('responder: BEGIN_UPLOAD reads file', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	const pathBytes = Buffer.from('/home/root/lms2012/prjs/Test/main.rbf\0', 'utf8');
	const sysPayload = new Uint8Array(3 + pathBytes.length);
	sysPayload[0] = 0x94; // BEGIN_UPLOAD
	new DataView(sysPayload.buffer).setUint16(1, 1024, true);
	sysPayload.set(pathBytes, 3);

	const reply = sendSystem(responder, sysPayload);
	assert.equal(reply.payload[0], 0x94); // opcode echo
	// Total size should be 4 (LEGO header bytes)
	const totalSize = new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength)
		.getUint32(2, true);
	assert.equal(totalSize, 4);
});

test('responder: CREATE_DIR + DELETE_FILE work', () => {
	const deps = makeDeps();
	const responder = createMockCommandResponder(deps);

	// CREATE_DIR
	const mkdirPath = Buffer.from('/home/root/lms2012/prjs/NewDir\0', 'utf8');
	const mkdirPayload = new Uint8Array(1 + mkdirPath.length);
	mkdirPayload[0] = 0x9b;
	mkdirPayload.set(mkdirPath, 1);
	sendSystem(responder, mkdirPayload);
	assert.ok(deps.fs.exists('/home/root/lms2012/prjs/NewDir'));

	// DELETE_FILE
	const delPath = Buffer.from('/home/root/lms2012/prjs/NewDir\0', 'utf8');
	const delPayload = new Uint8Array(1 + delPath.length);
	delPayload[0] = 0x9c;
	delPayload.set(delPath, 1);
	sendSystem(responder, delPayload);
	assert.ok(!deps.fs.exists('/home/root/lms2012/prjs/NewDir'));
});
