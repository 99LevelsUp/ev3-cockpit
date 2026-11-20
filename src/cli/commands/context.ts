/**
 * What every `ev3` command gets: its arguments, the terminal, and a connection to the daemon made
 * only when the command needs one.
 */

import type { CockpitClient } from '../../client';
import type { BrickHolder, LaunchSpec } from '../../contract/models';
import type { Confirmer } from '../confirm';
import { CommandResult, CliIo, UsageError } from '../output';

export interface CommandContext {
	readonly io: CliIo;
	readonly json: boolean;
	/** `--brick`, when given. */
	readonly brick: string | undefined;
	/** `--channel`, else `EV3_COCKPIT_CHANNEL`; undefined for the user's own daemon. */
	readonly channel: string | undefined;
	/** The words after the command. */
	readonly args: readonly string[];
	/** The command's own switches that were given, by long name: `recursive`, `all`, `replace`. */
	readonly flags: ReadonlySet<string>;
	readonly confirmer: Confirmer;
	/** Connects on first use. */
	client(): Promise<CockpitClient>;
	/** How this installation starts its daemon. */
	launch(): LaunchSpec;
}

export interface Command {
	readonly usage: string;
	readonly summary: string;
	/** Switches the command takes, by long name; `recursive` also answers to `-r`. */
	readonly flags?: readonly string[];
	run(ctx: CommandContext): Promise<CommandResult>;
}

/** The argument at `index`, or a usage error naming what is missing. */
export function arg(ctx: CommandContext, index: number, what: string): string {
	const value = ctx.args[index];
	if (value === undefined || value === '') { throw new UsageError(`Missing ${what}.`); }
	return value;
}

/** Refuses more arguments than the command takes. */
export function atMost(ctx: CommandContext, count: number, usage: string): void {
	if (ctx.args.length > count) { throw new UsageError(`Too many arguments. Usage: ${usage}`); }
}

/** The brick a command names: a positional argument where the command takes one, else `--brick`. */
export function brickRef(ctx: CommandContext, index?: number): string | undefined {
	const positional = index === undefined ? undefined : ctx.args[index];
	if (positional !== undefined && ctx.brick !== undefined && positional !== ctx.brick) {
		throw new UsageError(`The brick is named twice: ${positional} and --brick ${ctx.brick}.`);
	}
	return positional ?? ctx.brick;
}

/**
 * Connects the brick for this command alone, unless it is connected already: a command run without
 * a held brick connects only for its own run, and the daemon lets go when the command ends. With no
 * brick named, the one connected brick is meant.
 */
export async function connectedBrick(ctx: CommandContext, ref: string | undefined): Promise<{ client: CockpitClient; brickId: string; name: string }> {
	const client = await ctx.client();
	const brick = await client.request('bricks/connect', ref === undefined ? {} : { brick: ref });
	return { client, brickId: brick.brickId, name: brick.name };
}

/**
 * The brick a stop reaches. A stop must never wait or be refused: a brick that is connected is
 * stopped as it is, without signing it in again, which a forget or a list clearing in progress
 * would refuse. Only a brick not connected at all is connected for the stop.
 */
export async function stopTarget(ctx: CommandContext, ref: string | undefined): Promise<{ client: CockpitClient; brick: string | undefined; name: string }> {
	const client = await ctx.client();
	if (ref === undefined) { return { client, brick: undefined, name: 'the brick' }; }
	const known = client.brick(ref);
	if (known?.connected) { return { client, brick: ref, name: known.name }; }
	const { brickId, name } = await connectedBrick(ctx, ref);
	return { client, brick: brickId, name };
}

/** Who a holder is, as a person reads it. */
export function holderName(holder: BrickHolder): string {
	if (holder.kind === 'hold') { return 'ev3 connect'; }
	if (holder.kind === 'remembered') { return 'remembered'; }
	return holder.client ?? 'a client';
}
