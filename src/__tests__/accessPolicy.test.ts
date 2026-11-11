/**
 * The cockpit's access mode (step-5 plan, U4, KD2), owner decision 11.11.2026: in safe mode
 * (the default) a consumer writes, deletes and runs only in the user areas — the brick's projects
 * folder and the SD card — and reads everywhere; the shell needs full mode. The cockpit enforces
 * it, so a consumer cannot route around it.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { AccessDeniedError, ErrorCode } from '../errors/CockpitError';
import { assertAllowed, isAllowed, normaliseBrickPath } from '../api/accessPolicy';

const PRJ = '/home/root/lms2012/prjs/Robot/Robot.rbf';
const CARD = '/media/card/Robot/Robot.rbf';
const SYS = '/home/root/lms2012/sys/settings/BrickName';

describe('Access mode (step-5 U4)', () => {
	it('in safe mode allows writing, deleting and running in the projects folder and on the SD card', () => {
		for (const op of ['write', 'delete', 'run'] as const) {
			assert.equal(isAllowed('safe', op, PRJ), true, `${op} in projects`);
			assert.equal(isAllowed('safe', op, CARD), true, `${op} on the card`);
		}
	});

	it('in safe mode refuses writing, deleting and running anywhere else', () => {
		for (const op of ['write', 'delete', 'run'] as const) {
			assert.equal(isAllowed('safe', op, SYS), false, `${op} in sys`);
			assert.equal(isAllowed('safe', op, '/home/root/lms2012/prjsX/a'), false, `${op} beside projects`);
		}
	});

	it('in safe mode reads everywhere', () => {
		assert.equal(isAllowed('safe', 'read', SYS), true);
		assert.equal(isAllowed('safe', 'read', '/etc/passwd'), true);
	});

	it('in safe mode refuses to delete a user area itself', () => {
		assert.equal(isAllowed('safe', 'delete', '/home/root/lms2012/prjs/'), false);
		assert.equal(isAllowed('safe', 'delete', '/home/root/lms2012/prjs'), false);
		assert.equal(isAllowed('safe', 'delete', '/media/card'), false);
	});

	it('does not let ".." climb out of a user area', () => {
		assert.equal(isAllowed('safe', 'write', '/home/root/lms2012/prjs/../sys/settings/BrickName'), false);
		assert.equal(normaliseBrickPath('/home/root/lms2012/prjs/a/../b'), '/home/root/lms2012/prjs/b');
	});

	it('resolves a relative path from the VM\'s folder, as the brick does', () => {
		assert.equal(normaliseBrickPath('../prjs/Robot/Robot.rbf'), PRJ);
		assert.equal(isAllowed('safe', 'run', '../prjs/Robot/Robot.rbf'), true);
	});

	it('allows the shell only in full mode', () => {
		assert.equal(isAllowed('safe', 'shell'), false);
		assert.equal(isAllowed('full', 'shell'), true);
	});

	it('in full mode allows everything everywhere', () => {
		for (const op of ['read', 'write', 'delete', 'run'] as const) {
			assert.equal(isAllowed('full', op, SYS), true, op);
		}
	});

	it('throws a typed error that names the mode and the path', () => {
		assert.throws(() => assertAllowed('safe', 'write', SYS), (error: unknown) =>
			error instanceof AccessDeniedError && error.code === ErrorCode.AccessDenied
			&& /safe/.test(error.message) && error.message.includes(SYS));
		assert.doesNotThrow(() => assertAllowed('safe', 'write', PRJ));
	});
});
