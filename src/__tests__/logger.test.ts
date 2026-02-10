import assert from 'node:assert/strict';
import test from 'node:test';
import { NoopLogger, OutputChannelLogger } from '../diagnostics/logger';

test('OutputChannelLogger writes only messages at or above configured level', () => {
	const lines: string[] = [];
	const logger = new OutputChannelLogger((line) => lines.push(line), 'warn');

	logger.error('fatal');
	logger.warn('warning');
	logger.info('info-ignored');

	assert.equal(lines.length, 2);
	assert.match(lines[0], /\[error\] fatal$/);
	assert.match(lines[1], /\[warn\] warning$/);
});

test('OutputChannelLogger serializes metadata into log line', () => {
	const lines: string[] = [];
	const logger = new OutputChannelLogger((line) => lines.push(line), 'trace');

	logger.debug('payload', { key: 'value', count: 2 });

	assert.equal(lines.length, 1);
	assert.match(lines[0], /\[debug\] payload /);
	assert.match(lines[0], /"key":"value"/);
	assert.match(lines[0], /"count":2/);
});

test('OutputChannelLogger handles unserializable metadata', () => {
	const lines: string[] = [];
	const logger = new OutputChannelLogger((line) => lines.push(line), 'trace');
	const circular: Record<string, unknown> = {};
	circular.self = circular;

	logger.info('circular', circular);

	assert.equal(lines.length, 1);
	assert.match(lines[0], /\[info\] circular /);
	assert.match(lines[0], /"meta":"unserializable"/);
});

test('NoopLogger accepts all methods without throwing', () => {
	const logger = new NoopLogger();
	logger.error('e');
	logger.warn('w');
	logger.info('i');
	logger.debug('d');
	logger.trace('t');
	assert.ok(true);
});
