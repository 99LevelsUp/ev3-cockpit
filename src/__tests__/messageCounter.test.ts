import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageCounter } from '../scheduler/messageCounter';

test('MessageCounter rolls over from 0xFFFF to 0x0000', () => {
	const counter = new MessageCounter();
	let last = -1;

	for (let i = 0; i < 65_538; i++) {
		const current = counter.allocate();
		counter.release(current);
		last = current;
	}

	assert.equal(last, 1);
});

test('MessageCounter avoids collisions for pending counters', () => {
	const counter = new MessageCounter();
	const first = counter.allocate();
	const second = counter.allocate();

	assert.notEqual(first, second);
	assert.equal(counter.isPending(first), true);
	assert.equal(counter.isPending(second), true);
	assert.equal(counter.pendingCount(), 2);

	counter.release(first);
	counter.release(second);
	assert.equal(counter.pendingCount(), 0);
});

test('MessageCounter throws when all uint16 values are pending', () => {
	const counter = new MessageCounter();
	const allocated: number[] = [];

	for (let i = 0; i < 65_536; i++) {
		allocated.push(counter.allocate());
	}

	assert.throws(() => counter.allocate(), /exhausted/i);

	for (const value of allocated) {
		counter.release(value);
	}
	assert.equal(counter.pendingCount(), 0);
});

