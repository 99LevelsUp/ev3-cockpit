import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeployTransientTransportError } from '../fs/deployResilience';

test('deployResilience classifies transient transport errors', () => {
	assert.equal(isDeployTransientTransportError('Request execution failed: TCP adapter is not open.'), true);
	assert.equal(isDeployTransientTransportError('Opening COM4: Unknown error code 121'), true);
	assert.equal(isDeployTransientTransportError('Request execution failed: could not read from HID device.'), true);
	assert.equal(isDeployTransientTransportError('TCP connect timeout after 2000ms (192.168.1.10:5555).'), true);
});

test('deployResilience does not classify logical deploy errors as transient transport errors', () => {
	assert.equal(isDeployTransientTransportError('Path "/etc" is outside safe roots.'), false);
	assert.equal(isDeployTransientTransportError('Program run is only supported for .rbf files.'), false);
	assert.equal(isDeployTransientTransportError('System command 0x95 failed with status UNKNOWN_HANDLE.'), false);
});

