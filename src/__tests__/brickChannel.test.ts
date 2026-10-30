import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { ChannelState, Transport, makeBrickKey } from '../contracts';
import { BaseChannelStateMachine, ChannelEvent, ChannelStateMachine } from '../runtime/channelStateMachine';
import { BrickChannel } from '../runtime/brickChannel';
import { InvalidTransitionError } from '../errors/CockpitError';

/** Drives a fresh machine through `events` and returns the state after each. */
function walk(events: ChannelEvent[]): ChannelState[] {
	const machine = new BaseChannelStateMachine();
	return events.map((event) => { machine.apply(event); return machine.state; });
}

describe('BaseChannelStateMachine', () => {
	it('starts absent', () => {
		assert.equal(new BaseChannelStateMachine().state, ChannelState.Absent);
	});

	it('follows the arena scenario: seen, connected, cable out, cable back', () => {
		assert.deepEqual(walk(['seen', 'linkUp', 'linkDown', 'seen', 'linkUp']), [
			ChannelState.Available, ChannelState.Connected, ChannelState.Lost,
			ChannelState.Available, ChannelState.Connected,
		]);
	});

	it('loses an available channel discovery stops seeing, and finds it again', () => {
		assert.deepEqual(walk(['seen', 'gone', 'seen']),
			[ChannelState.Available, ChannelState.Lost, ChannelState.Available]);
	});

	it('returns a signed-out channel to available', () => {
		assert.deepEqual(walk(['seen', 'linkUp', 'closed']),
			[ChannelState.Available, ChannelState.Connected, ChannelState.Available]);
	});

	it('reconnects a lost channel straight to connected', () => {
		assert.deepEqual(walk(['seen', 'linkUp', 'linkDown', 'linkUp']),
			[ChannelState.Available, ChannelState.Connected, ChannelState.Lost, ChannelState.Connected]);
	});

	it('keeps a lost channel lost when its session closes', () => {
		assert.deepEqual(walk(['seen', 'linkUp', 'linkDown', 'closed']),
			[ChannelState.Available, ChannelState.Connected, ChannelState.Lost, ChannelState.Lost]);
	});

	it('keeps a connected channel connected when discovery misses it', () => {
		assert.deepEqual(walk(['seen', 'linkUp', 'gone']),
			[ChannelState.Available, ChannelState.Connected, ChannelState.Connected]);
	});

	it('refuses to connect a channel nothing has seen', () => {
		const machine = new BaseChannelStateMachine();
		assert.equal(machine.accepts('linkUp'), false);
		assert.throws(() => machine.apply('linkUp'), InvalidTransitionError);
		assert.equal(machine.state, ChannelState.Absent);
	});

	it('refuses a lost link on a channel that never had one', () => {
		const machine = new BaseChannelStateMachine();
		machine.apply('seen');
		assert.throws(() => machine.apply('linkDown'), InvalidTransitionError);
	});

	it('reports whether a transition changed the state', () => {
		const machine = new BaseChannelStateMachine();
		assert.equal(machine.apply('seen'), true);
		assert.equal(machine.apply('seen'), false);
	});
});

describe('BrickChannel', () => {
	const key = makeBrickKey(Transport.USB, '00165342D9F2');

	it('reports whatever state its machine holds, through the interface alone', () => {
		// Nothing outside the base implementation may depend on its states: a transport that
		// brings its own machine must work with the channel unchanged.
		const stub: ChannelStateMachine = {
			state: ChannelState.Lost,
			accepts: () => true,
			apply: () => false,
		};
		const channel = new BrickChannel(key, Transport.USB, 30, stub);
		assert.equal(channel.state, ChannelState.Lost);
		assert.equal(channel.snapshot().state, ChannelState.Lost);
	});

	it('remembers that it was connected once, through a later loss', () => {
		const channel = new BrickChannel(key, Transport.USB, 30);
		channel.apply('seen');
		channel.apply('linkUp');
		channel.apply('linkDown');
		assert.equal(channel.everConnected, true);
	});

	it('stops being expired once seen again', () => {
		const channel = new BrickChannel(key, Transport.USB, 30);
		channel.apply('seen');
		channel.apply('gone');
		channel.markExpired();
		assert.equal(channel.expired, true);
		channel.apply('seen');
		assert.equal(channel.expired, false);
	});
});
