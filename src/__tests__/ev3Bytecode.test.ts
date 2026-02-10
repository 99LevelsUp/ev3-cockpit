import assert from 'node:assert/strict';
import test from 'node:test';
import {
	cString,
	concatBytes,
	gv0,
	lc0,
	lc2,
	lcs,
	readUint32le,
	uint16le,
	uint32le
} from '../protocol/ev3Bytecode';

test('ev3Bytecode uint16le writes little-endian bytes and wraps to uint16', () => {
	assert.deepEqual([...uint16le(0x1234)], [0x34, 0x12]);
	assert.deepEqual([...uint16le(0x1_2345)], [0x45, 0x23]);
});

test('ev3Bytecode concatBytes concatenates multiple buffers', () => {
	const result = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]));
	assert.deepEqual([...result], [1, 2, 3, 4, 5]);
});

test('ev3Bytecode lc0 validates range and encodes value', () => {
	assert.deepEqual([...lc0(31)], [0x1f]);
	assert.deepEqual([...lc0(-1)], [0x3f]);
	assert.throws(() => lc0(32), /LC0 value out of range/);
});

test('ev3Bytecode uint32le encodes little-endian unsigned integer', () => {
	assert.deepEqual([...uint32le(0x12345678)], [0x78, 0x56, 0x34, 0x12]);
});

test('ev3Bytecode cString and lcs encode null-terminated strings', () => {
	assert.deepEqual([...cString('A')], [0x41, 0x00]);
	assert.deepEqual([...lcs('A')], [0x84, 0x41, 0x00]);
});

test('ev3Bytecode lc2 validates range and encodes signed int16 payload', () => {
	assert.deepEqual([...lc2(0x1234)], [0x82, 0x34, 0x12]);
	assert.throws(() => lc2(40000), /LC2 value out of range/);
});

test('ev3Bytecode gv0 validates range and sets global-variable op byte', () => {
	assert.deepEqual([...gv0(0)], [0x60]);
	assert.deepEqual([...gv0(31)], [0x7f]);
	assert.throws(() => gv0(32), /GV0 offset out of range/);
});

test('ev3Bytecode readUint32le parses bytes at requested offset and validates bounds', () => {
	const bytes = new Uint8Array([0xaa, 0xbb, 0x78, 0x56, 0x34, 0x12]);
	assert.equal(readUint32le(bytes, 2), 0x12345678);
	assert.throws(() => readUint32le(new Uint8Array([1, 2, 3]), 0), /Expected 4-byte little-endian integer/);
});
