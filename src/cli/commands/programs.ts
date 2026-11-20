/**
 * Programs: start one, see whether it runs, stop it, stop everything at once.
 *
 * A start whose answer was lost may or may not have started the program. Starting it again could
 * run it twice, so the command says so and exits 4 rather than retrying.
 */

import type { ProgramState } from '../../contract/models';
import { ExitCode } from '../output';
import { Command, arg, atMost, brickRef, connectedBrick, stopTarget } from './context';

function stateLine(name: string, state: ProgramState): string {
	return state.running ? `A program runs on ${name}.` : `No program runs on ${name}${state.stoppedBy ? ` (stopped by ${state.stoppedBy})` : ''}.`;
}

const run: Command = {
	usage: 'ev3 run <path> [--brick <brick>] [--replace]',
	summary: 'Start a program on the brick; --replace stops one that runs first.',
	flags: ['replace'],
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const program = arg(ctx, 0, 'the program to run');
		const { client, brickId, name } = await connectedBrick(ctx, ctx.brick);
		const result = await client.request('programs/run', { brick: brickId, path: program, ...(ctx.flags.has('replace') ? { replace: true } : {}) });
		if (result.outcome === 'uncertain') {
			return {
				value: result,
				human: `The brick's answer to the start was lost: ${program} may be running. Do not run it again; check its state first with ev3 program ${name}.`,
				exitCode: ExitCode.Uncertain,
			};
		}
		return {
			value: result,
			human: result.outcome === 'started' ? `Started ${program} on ${name}.` : `Started ${program} on ${name}, but it was not seen running; it may have ended at once.`,
		};
	},
};

const program: Command = {
	usage: 'ev3 program [brick]',
	summary: 'Say whether a program runs on the brick.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const { client, brickId, name } = await connectedBrick(ctx, brickRef(ctx, 0));
		const state = await client.request('programs/status', { brick: brickId });
		return { value: state, human: stateLine(name, state) };
	},
};

const stop: Command = {
	usage: 'ev3 stop [brick]',
	summary: 'Stop the program running on the brick.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const { client, brick, name } = await stopTarget(ctx, brickRef(ctx, 0));
		const state = await client.request('programs/stop', brick === undefined ? {} : { brick });
		return { value: state, human: stateLine(name, state) };
	},
};

const estop: Command = {
	usage: 'ev3 estop [brick]',
	summary: 'Emergency stop: stop the brick\'s program at once, whoever started it.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const { client, brick, name } = await stopTarget(ctx, brickRef(ctx, 0));
		const state = await client.request('programs/emergencyStop', brick === undefined ? {} : { brick });
		return { value: state, human: stateLine(name, state) };
	},
};

export const programCommands: Readonly<Record<string, Command>> = { run, program, stop, estop };
