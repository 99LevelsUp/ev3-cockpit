/**
 * The daemon itself: its status with the held bricks and who writes to them, a restart on a
 * person's yes, and where its log is.
 *
 * A restart asks the daemon to exit. The daemon puts the question to this terminal, waits up to
 * 60 s for the answer and then up to 60 s for a write in progress, so the answer may take two
 * minutes. Once it accepted, the command waits for it to end and connects again, starting a new
 * daemon unless another client already did; the bricks held with `ev3 connect` come back with it.
 *
 * `ev3 daemon log` reads no daemon: it prints the path even when the daemon cannot start, which is
 * when the log is wanted.
 */

import { needsPerson } from '../../client/connection';
import { EXIT_ANSWER_MS } from '../../client/nativeDaemon';
import type { DaemonStatus } from '../../contract/generated';
import { daemonLogFile } from '../installation';
import { ExitCode, UsageError, table } from '../output';
import { Command, CommandContext, atMost, holderName } from './context';

const RESTART_COMMAND = 'ev3 daemon restart';

function statusLines(status: DaemonStatus): string[] {
	const kind = `${status.buildKind === 'development' ? 'development build' : 'release'}${status.mode === 'replay' ? ', replaying recordings' : ''}`;
	const lines = [
		`Cockpit daemon ${status.version} (${kind}, contract ${status.contractVersion}, pid ${status.pid}), running since ${new Date(status.startedAt).toLocaleString()}`,
		`Channel: ${status.channel}`,
		`Clients: ${status.clients.map((c) => `${c.name} (${c.kind})`).join(', ') || 'none'}`,
	];
	if (status.bricks.length === 0) {
		lines.push('Held bricks: none');
	} else {
		lines.push('Held bricks:');
		lines.push(...table(status.bricks.map((b) => [
			`  ${b.name}`, b.brickId, `held by ${b.holders.map(holderName).join(', ')}`,
			b.leaseHolder ? `${b.leaseHolder} is writing to it` : b.reconnecting ? 'connecting again' : '',
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
	const client = await ctx.client();
	const before = client.daemon.pid;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EXIT_ANSWER_MS);
	let answer;
	try {
		answer = await client.request('daemon/exit', {}, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
	if (!answer.accepted) {
		const reason = answer.reason ?? 'The cockpit daemon did not accept the restart.';
		// Nobody here could say yes: the same refusal as every other action that needs a person.
		if (!ctx.confirmer.canAsk) {
			throw needsPerson(`${reason} A person has to run ${RESTART_COMMAND} in an interactive terminal and confirm it.`, RESTART_COMMAND);
		}
		return { value: answer, human: reason, exitCode: ExitCode.Failure };
	}
	const next = await ctx.reconnect();
	return {
		value: { ...answer, pid: next.daemon.pid, previousPid: before },
		human: `Restarted the cockpit daemon: pid ${next.daemon.pid} (was ${before}).`,
	};
}

function log(ctx: CommandContext): { value: unknown; human: string } {
	const file = daemonLogFile(ctx.io.env, ctx.channel);
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
	summary: 'The cockpit daemon: its status, a restart after a person\'s yes, its log\'s path.',
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
