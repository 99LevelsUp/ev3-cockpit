/**
 * Bricks: listing, connecting and holding, information, pairing, forgetting and clearing a brick's
 * Bluetooth list.
 *
 * `ev3 connect` holds a brick past the command, until `ev3 disconnect`; other commands connect a
 * brick only for their own run. Forgetting and clearing the Bluetooth list run only on a person's
 * yes, which the daemon asks this terminal for; pairing is confirmed by the person at the brick, so
 * it asks nothing here.
 */

import type { ContractBrick } from '../../contract/generated';
import { ExitCode, table } from '../output';
import { Command, arg, atMost, brickRef, connectedBrick, holderName } from './context';

function brickLine(brick: ContractBrick): string[] {
	const state = brick.reconnecting ? 'reconnecting' : brick.connected ? 'connected' : 'available';
	const holders = brick.holders.map(holderName).join(', ');
	return [brick.name, brick.brickId, state, brick.channels.map((c) => c.transport).join(','), holders ? `held by ${holders}` : ''];
}

const list: Command = {
	usage: 'ev3 list',
	summary: 'List the bricks the cockpit sees.',
	async run(ctx) {
		atMost(ctx, 0, this.usage);
		const client = await ctx.client();
		const { bricks } = await client.request('bricks/list', { waitForDiscovery: true });
		return {
			value: bricks,
			human: bricks.length === 0 ? 'No bricks found.' : table([['NAME', 'ID', 'STATE', 'LINKS', 'HOLDERS'], ...bricks.map(brickLine)]),
		};
	},
};

const connect: Command = {
	usage: 'ev3 connect <brick>',
	summary: 'Connect a brick and hold it until ev3 disconnect.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const ref = brickRef(ctx, 0) ?? arg(ctx, 0, 'the brick to connect');
		const client = await ctx.client();
		const brick = await client.request('bricks/connect', { brick: ref, hold: true });
		return { value: brick, human: `Connected ${brick.name}; it stays connected until ev3 disconnect ${brick.name}.` };
	},
};

const disconnect: Command = {
	usage: 'ev3 disconnect [brick] [--all]',
	summary: 'Let go of a brick held by ev3 connect; --all disconnects it for every client.',
	flags: ['all'],
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const ref = brickRef(ctx, 0);
		const client = await ctx.client();
		const all = ctx.flags.has('all');
		const result = await client.request('bricks/disconnect', {
			...(ref === undefined ? {} : { brick: ref }),
			...(all ? { forEveryone: true } : { releaseHold: true }),
		});
		const name = ref ?? 'The brick';
		return {
			value: result,
			human: result.stillHeldBy.length > 0
				? `${name} stays connected: ${result.stillHeldBy.join(', ')} still hold${result.stillHeldBy.length === 1 ? 's' : ''} it.`
				: `Disconnected ${name}.`,
		};
	},
};

const info: Command = {
	usage: 'ev3 info [brick]',
	summary: 'Show a brick\'s name, id and firmware.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const { client, brickId } = await connectedBrick(ctx, brickRef(ctx, 0));
		const result = await client.request('bricks/info', { brick: brickId });
		return {
			value: result,
			human: table([
				['Name', result.name], ['Id', result.brickId],
				...(result.firmwareVersion ? [['Firmware', result.firmwareVersion]] : []),
				...(result.osVersion ? [['OS', result.osVersion]] : []),
			]),
		};
	},
};

const storage: Command = {
	usage: 'ev3 storage [brick]',
	summary: 'Show a brick\'s free and total storage.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const { client, brickId, name } = await connectedBrick(ctx, brickRef(ctx, 0));
		const result = await client.request('bricks/storage', { brick: brickId });
		return { value: result, human: `${name}: ${result.freeKb} KB free of ${result.totalKb} KB.` };
	},
};

const pair: Command = {
	usage: 'ev3 pair <brick>',
	summary: 'Pair a brick over Bluetooth; confirm on the brick.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const ref = brickRef(ctx, 0) ?? arg(ctx, 0, 'the brick to pair');
		const client = await ctx.client();
		if (!ctx.json) { ctx.io.stderr.write(`Pairing ${ref}: confirm the pairing on the brick when it asks.\n`); }
		const result = await client.request('bricks/pair', { brick: ref });
		// A pairing cancelled on the brick or here is no error.
		const human = result.outcome === 'paired' ? `Paired ${ref}.`
			: result.outcome === 'cancelled' ? `Pairing ${ref} was cancelled.`
				: `Not paired: ${result.message ?? 'the brick did not confirm the pairing.'}`;
		return { value: result, human, exitCode: result.outcome === 'failed' ? ExitCode.Failure : ExitCode.Ok };
	},
};

const forget: Command = {
	usage: 'ev3 forget <brick>',
	summary: 'Unpair a brick on this computer and on the brick; asks first.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const ref = brickRef(ctx, 0) ?? arg(ctx, 0, 'the brick to forget');
		const client = await ctx.client();
		const result = await client.request('bricks/forget', { brick: ref });
		return { value: result, human: [`Forgot ${ref}.`, ...result.lines.map((l) => `  ${l}`)] };
	},
};

const btClear: Command = {
	usage: 'ev3 bt-clear <brick>',
	summary: 'Remove the entries from a brick\'s list of paired devices; shows them and asks first.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const ref = brickRef(ctx, 0) ?? arg(ctx, 0, 'the brick whose Bluetooth list to clear');
		const client = await ctx.client();
		const result = await client.request('bricks/clearBluetoothList', { brick: ref });
		const skipped = result.report?.skipped;
		const human = result.removed.length === 0 && result.kept.length === 0
			? [`Nothing was removed from ${ref}'s Bluetooth list${skipped ? `: ${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ''}` : ''}.`]
			: [
				...(result.removed.length > 0 ? [`Removed from ${ref}'s Bluetooth list:`, ...result.removed.map((n) => `  ${n}`)] : []),
				...(result.kept.length > 0 ? ['Still on the list:', ...result.kept.map((n) => `  ${n}`)] : []),
			];
		return { value: result, human };
	},
};

export const brickCommands: Readonly<Record<string, Command>> = {
	list, connect, disconnect, info, storage, pair, forget, 'bt-clear': btClear,
};
