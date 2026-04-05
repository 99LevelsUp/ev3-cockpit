import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { NoopLogger, OutputChannelLogger } from '../diagnostics';

// ── Helpers ─────────────────────────────────────────────────────────

interface MockOutputChannel {
	lines: string[];
	disposed: boolean;
	appendLine(value: string): void;
	dispose(): void;
}

function makeChannel(): MockOutputChannel {
	return {
		lines: [],
		disposed: false,
		appendLine(value: string) { this.lines.push(value); },
		dispose() { this.disposed = true; },
	};
}

// ── NoopLogger ───────────────────────────────────────────────────────

describe('NoopLogger', () => {
	it('all methods are callable without error', () => {
		const logger = new NoopLogger();
		assert.doesNotThrow(() => {
			logger.error('e');
			logger.warn('w');
			logger.info('i');
			logger.debug('d');
			logger.trace('t');
		});
	});
});

// ── OutputChannelLogger ──────────────────────────────────────────────

describe('OutputChannelLogger', () => {
	it('info() writes a line to the channel', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any);
		logger.info('hello world');
		assert.equal(ch.lines.length, 1);
		assert.ok(ch.lines[0].includes('hello world'));
	});

	it('line contains timestamp, level tag and message', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any);
		logger.info('test message');
		const line = ch.lines[0];
		assert.match(line, /\[\d{2}:\d{2}:\d{2}\]/);   // [HH:MM:SS]
		assert.ok(line.includes('[INFO ]'));
		assert.ok(line.includes('test message'));
	});

	it('error() always writes regardless of minLevel', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any, 'error');
		logger.error('fatal');
		assert.equal(ch.lines.length, 1);
	});

	it('debug() is suppressed when minLevel is info', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any, 'info');
		logger.debug('should not appear');
		assert.equal(ch.lines.length, 0);
	});

	it('trace() is suppressed when minLevel is debug', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any, 'debug');
		logger.trace('should not appear');
		assert.equal(ch.lines.length, 0);
	});

	it('trace() writes when minLevel is trace', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any, 'trace');
		logger.trace('verbose');
		assert.equal(ch.lines.length, 1);
	});

	it('appends extra string args to the line', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any);
		logger.info('msg', 'extra', 42);
		assert.ok(ch.lines[0].includes('extra'));
		assert.ok(ch.lines[0].includes('42'));
	});

	it('formats Error args as .message only', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any);
		logger.error('oops', new Error('something went wrong'));
		assert.ok(ch.lines[0].includes('something went wrong'));
	});

	it('formats object args as JSON', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any);
		logger.info('data', { key: 'value' });
		assert.ok(ch.lines[0].includes('"key"'));
	});

	it('dispose() calls channel.dispose()', () => {
		const ch = makeChannel();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const logger = new OutputChannelLogger(ch as any);
		logger.dispose();
		assert.equal(ch.disposed, true);
	});
});
