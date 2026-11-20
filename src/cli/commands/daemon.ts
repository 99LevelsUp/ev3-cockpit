/**
 * The daemon itself: its status with the held bricks and who writes to them, a restart on a
 * person's command, and where its log is.
 *
 * `ev3 daemon log` reads no daemon: it prints the path even when the daemon cannot start, which is
 * when the log is wanted.
 */

import { clientPaths } from '../../client/locate';
import type { DaemonStatus } from '../../contract/models';
import { terminalRefusal } from '../confirm';
import { ExitCode, UsageError, table } from '../output';
import { Command, CommandContext, atMost, holderName } from './context';

function statusLines(status: DaemonStatus): string[] {
	const runtime = `Node ${status.runtime.node}${status.runtime.electron ? `, Electron ${status.runtime.electron}` : ''}`;
	const lines = [
		`Cockpit daemon ${status.version} (pid ${status.pid}, ${runtime}), running since ${new Date(status.startedAt).toLocaleString()}`,
		`Channel: ${status.channel}`,
		...(status.lent ? ['All bricks are lent to a development daemon.'] : []),
		`Clients: ${status.clients.map((c) => c.name).join(', ') || 'none'}`,
	];
	if (status.bricks.length === 0) {
		lines.push('Held bricks: none');
	} else {
		lines.push('Held bricks:');
		lines.push(...table(status.bricks.map((b) => [
			`  ${b.name}`, b.brickId, `held by ${b.holders.map(holderName).join(', ')}`,
			b.leaseHolder ? `${b.leaseHolder} is writing to it` : '',
		])));
	}
	lines.push(`Log: ${status.logPath}`);
	return lines;
}

async function status(ctx: CommandContext): Promise<{ value: unknown; human: string[] }> {
	const result = await (await ctx.client()).request('daemon/status', {});
	return { value: result, human: statusLines(result) };
}

async function restart(ctx: CommandContext): Promise<{ value: unknown; human: string; exitCode?: number }> {
	const command = 'ev3 daemon restart';
	const yes = await ctx.confirmer.confirm({
		text: 'Restart the cockpit daemon now? Brick connections are cut, and the new daemon connects them again; programs and transfers in progress may be interrupted.',
		refusal: terminalRefusal(command),
		command,
	});
	if (!yes) { return { value: { accepted: false }, human: 'Not restarted.', exitCode: ExitCode.Failure }; }
	const client = await ctx.client();
	// A refusal — bricks lent to a development daemon — comes back as the daemon's own error.
	const result = await client.request('daemon/restart', { confirmedByPerson: true, launch: ctx.launch() });
	return {
		value: result,
		human: result.accepted ? 'The daemon is restarting; clients connect to the new one by themselves.' : 'The daemon did not accept the restart.',
		...(result.accepted ? {} : { exitCode: ExitCode.Failure }),
	};
}

function log(ctx: CommandContext): { value: unknown; human: string } {
	const file = clientPaths({ env: ctx.io.env, ...(ctx.channel ? { channel: ctx.channel } : {}) }).logFile;
	return { value: { logPath: file }, human: file };
}

const statusCommand: Command = {
	usage: 'ev3 status',
	summary: 'Show the daemon, its clients, the held bricks and who writes to them.',
	async run(ctx) {
		atMost(ctx, 0, this.usage);
		return status(ctx);
	},
};

const daemon: Command = {
	usage: 'ev3 daemon status | restart | log',
	summary: 'The cockpit daemon: its status, a restart, its log\'s path.',
	async run(ctx) {
		const sub = ctx.args[0] ?? 'status';
		atMost(ctx, 1, this.usage);
		if (sub === 'status') { return status(ctx); }
		if (sub === 'restart') { return restart(ctx); }
		if (sub === 'log') { return Promise.resolve(log(ctx)); }
		throw new UsageError(`ev3 daemon has no ${sub}. Usage: ${this.usage}`);
	},
};

export const daemonCommands: Readonly<Record<string, Command>> = { status: statusCommand, daemon };
