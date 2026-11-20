/**
 * Files on a brick: list, copy to and from this computer, remove, make folders, move.
 *
 * A local path is taken relative to the folder the command runs in and handed to the daemon as an
 * absolute one: the daemon runs in a folder of its own.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { table } from '../output';
import { Command, CommandContext, arg, atMost, connectedBrick } from './context';

/** The brick's projects folder, where `ev3 ls` looks when no path is given. */
const PROJECTS = '/home/root/lms2012/prjs';

function localPath(ctx: CommandContext, file: string): string {
	return path.resolve(ctx.io.cwd, file);
}

const ls: Command = {
	usage: 'ev3 ls [path] [--brick <brick>]',
	summary: 'List a folder on the brick (the projects folder when no path is given).',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const folder = ctx.args[0] ?? PROJECTS;
		const { client, brickId } = await connectedBrick(ctx, ctx.brick);
		const entries = await client.request('files/list', { brick: brickId, path: folder });
		return {
			value: entries,
			human: entries.length === 0 ? `${folder} is empty.` : table(entries.map((e) => [
				e.kind === 'directory' ? `${e.name}/` : e.name,
				e.bytes === undefined ? '' : `${e.bytes} B`,
			])),
		};
	},
};

const get: Command = {
	usage: 'ev3 get <remote> [local] [--brick <brick>]',
	summary: 'Copy a file from the brick to this computer.',
	async run(ctx) {
		atMost(ctx, 2, this.usage);
		const remote = arg(ctx, 0, 'the file on the brick');
		const local = localPath(ctx, ctx.args[1] ?? path.posix.basename(remote));
		const { client, brickId } = await connectedBrick(ctx, ctx.brick);
		const result = await client.request('files/read', { brick: brickId, path: remote, toLocalPath: local });
		return { value: { ...result, localPath: local }, human: `Copied ${remote} to ${local} (${result.bytes} bytes).` };
	},
};

const put: Command = {
	usage: 'ev3 put <local> <remote> [--brick <brick>]',
	summary: 'Copy a file from this computer to the brick.',
	async run(ctx) {
		atMost(ctx, 2, this.usage);
		const local = localPath(ctx, arg(ctx, 0, 'the file to copy'));
		const remote = arg(ctx, 1, 'the path on the brick');
		if (!fs.existsSync(local)) { throw new Error(`There is no file ${local}.`); }
		const { client, brickId } = await connectedBrick(ctx, ctx.brick);
		const result = await client.request('files/write', { brick: brickId, path: remote, fromLocalPath: local });
		return { value: result, human: `Copied ${local} to ${remote} (${result.bytes} bytes).` };
	},
};

const rm: Command = {
	usage: 'ev3 rm [-r] <path> [--brick <brick>]',
	summary: 'Remove a file, or with -r a folder and everything in it.',
	flags: ['recursive'],
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const target = arg(ctx, 0, 'the path to remove');
		const { client, brickId } = await connectedBrick(ctx, ctx.brick);
		const result = await client.request('files/remove', { brick: brickId, path: target, recursive: ctx.flags.has('recursive') });
		return {
			value: result,
			human: result.leftBehind.length === 0 ? `Removed ${target}.` : [`Removed ${target}, except:`, ...result.leftBehind.map((p) => `  ${p}`)],
		};
	},
};

const mkdir: Command = {
	usage: 'ev3 mkdir <path> [--brick <brick>]',
	summary: 'Make a folder on the brick.',
	async run(ctx) {
		atMost(ctx, 1, this.usage);
		const folder = arg(ctx, 0, 'the folder to make');
		const { client, brickId } = await connectedBrick(ctx, ctx.brick);
		await client.request('files/makeDirectory', { brick: brickId, path: folder });
		return { value: { path: folder }, human: `Made ${folder}.` };
	},
};

const mv: Command = {
	usage: 'ev3 mv <from> <to> [--brick <brick>]',
	summary: 'Move or rename a file on the brick.',
	async run(ctx) {
		atMost(ctx, 2, this.usage);
		const from = arg(ctx, 0, 'the path to move');
		const to = arg(ctx, 1, 'where to move it');
		const { client, brickId } = await connectedBrick(ctx, ctx.brick);
		await client.request('files/move', { brick: brickId, from, to });
		return { value: { from, to }, human: `Moved ${from} to ${to}.` };
	},
};

export const fileCommands: Readonly<Record<string, Command>> = { ls, get, put, rm, mkdir, mv };
