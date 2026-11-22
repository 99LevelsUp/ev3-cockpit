/**
 * Telemetry when asked: the rows the daemon offers, one reading of a brick, or its changes until
 * Ctrl+C. Connecting a brick never starts telemetry; this command reads only while it runs, on a
 * subscription of its own.
 */

import { readTelemetryOnce, valueLine, watchTelemetry } from '../../client/telemetryReading';
import { UsageError } from '../output';
import { Command, connectedBrick } from './context';

/** How long one reading waits for every row to have a value. */
export const READING_WAIT_MS = 5000;

const telemetry: Command = {
	usage: 'ev3 telemetry [row...] [--brick <brick>] [--watch] [--list]',
	summary: 'Read the brick\'s telemetry once (every row, or the rows named); --watch prints changes until Ctrl+C; --list names the rows.',
	flags: ['watch', 'list'],
	async run(ctx) {
		if (ctx.flags.has('list')) {
			if (ctx.args.length > 0 || ctx.flags.has('watch')) { throw new UsageError(`--list takes nothing else. Usage: ${this.usage}`); }
			const client = await ctx.client();
			const { rows } = await client.request('telemetry/rows', {});
			return {
				value: rows,
				human: rows.map((row) => `${row.id}${row.unit ? ` (${row.unit})` : ''}${row.port ? `, port ${row.port}` : ''}`),
			};
		}
		const { client, brickId, name } = await connectedBrick(ctx, ctx.brick);
		if (ctx.flags.has('watch')) {
			const signal = ctx.io.signal ?? new AbortController().signal;
			if (!ctx.json) { ctx.io.stderr.write(`Reading ${name}; Ctrl+C stops.\n`); }
			const updates = await watchTelemetry(client, brickId, ctx.args, signal, (values) => {
				if (ctx.json) {
					ctx.io.stdout.write(`${JSON.stringify({ brickId, values })}\n`);
					return;
				}
				const time = new Date().toLocaleTimeString();
				for (const value of values) { ctx.io.stdout.write(`${time}  ${valueLine(value)}\n`); }
			});
			return { value: { brickId, updates }, human: [], streamed: true };
		}
		const reading = await readTelemetryOnce(client, brickId, ctx.args, READING_WAIT_MS, ctx.io.signal);
		return {
			value: reading,
			human: [
				...reading.values.map(valueLine),
				...(reading.missing.length > 0 ? [`No value yet for ${reading.missing.join(', ')}.`] : []),
			],
		};
	},
};

export const telemetryCommands: Readonly<Record<string, Command>> = { telemetry };
