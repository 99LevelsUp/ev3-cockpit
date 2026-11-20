/**
 * The `ev3` command: every cockpit operation from a terminal or a script, through the user's
 * cockpit daemon, which it starts when none runs.
 *
 *     ev3 [--json] [--brick <brick>] [--channel <name>] <command> [arguments]
 *
 * `--json` prints the result for programs; the exit code says how the command ended (see
 * output.ts). A command that is not built in runs the add-on `ev3-<command>` found on PATH.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CockpitClient } from '../client';
import { clientPaths, thisInstallLaunch } from '../client/locate';
import type { LaunchSpec } from '../contract/models';
import { findAddon, runAddon } from './addons';
import { brickCommands } from './commands/bricks';
import { configCommands } from './commands/config';
import { Command, CommandContext } from './commands/context';
import { daemonCommands } from './commands/daemon';
import { fileCommands } from './commands/files';
import { programCommands } from './commands/programs';
import { Confirmer } from './confirm';
import { CliIo, ExitCode, UsageError, printError, printResult } from './output';

export const COMMANDS: Readonly<Record<string, Command>> = {
	...brickCommands, ...fileCommands, ...programCommands, ...configCommands, ...daemonCommands,
};

/** Short forms of a command's switches. */
const SHORT_FLAGS: Readonly<Record<string, string>> = { '-r': 'recursive' };

/**
 * How this installation starts its daemon. Packaged, `daemon.js` lies beside the command's own
 * file and the installation is one folder up; built from source (`out/cli/main.js`), the daemon is
 * `out/daemon/main.js` and the installation two folders up.
 */
export function cliLaunch(dir: string = __dirname): LaunchSpec {
	const sibling = path.join(dir, 'daemon.js');
	const packaged = fs.existsSync(sibling);
	const installRoot = path.resolve(dir, ...(packaged ? ['..'] : ['..', '..']));
	let version = '0.0.0';
	try {
		version = (JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
	} catch { /* an installation without its package.json still runs */ }
	return { ...thisInstallLaunch(installRoot, version), entry: packaged ? sibling : path.resolve(dir, '..', 'daemon', 'main.js') };
}

interface Parsed {
	json: boolean;
	help: boolean;
	brick?: string;
	channel?: string;
	command?: string;
	/** For an add-on: everything after its name, untouched. */
	rest: string[];
	args: string[];
	flags: Set<string>;
}

function parse(argv: readonly string[]): Parsed {
	const parsed: Parsed = { json: false, help: false, rest: [], args: [], flags: new Set() };
	let command: Command | undefined;
	let optionsDone = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		const valueOf = (name: string): string => {
			const eq = token.indexOf('=');
			if (eq >= 0) { return token.slice(eq + 1); }
			const value = argv[++i];
			if (value === undefined) { throw new UsageError(`${name} needs a value.`); }
			return value;
		};
		const isOption = !optionsDone && token.startsWith('-') && token !== '-' && !/^-\d/.test(token);
		if (!isOption) {
			if (parsed.command === undefined) {
				parsed.command = token;
				command = COMMANDS[token];
				if (!command && token !== 'help') { parsed.rest = argv.slice(i + 1); return parsed; }
			} else {
				parsed.args.push(token);
			}
			continue;
		}
		if (token === '--') { optionsDone = true; continue; }
		if (token === '--json') { parsed.json = true; continue; }
		if (token === '-h' || token === '--help') { parsed.help = true; continue; }
		if (token === '--brick' || token.startsWith('--brick=')) { parsed.brick = valueOf('--brick'); continue; }
		if (token === '--channel' || token.startsWith('--channel=')) { parsed.channel = valueOf('--channel'); continue; }
		const flag = SHORT_FLAGS[token] ?? (token.startsWith('--') ? token.slice(2) : undefined);
		if (command && flag && command.flags?.includes(flag)) { parsed.flags.add(flag); continue; }
		throw new UsageError(`Unknown option ${token}${parsed.command ? ` for ev3 ${parsed.command}` : ''}.`);
	}
	return parsed;
}

function helpText(): string[] {
	const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
	return [
		'Usage: ev3 [--json] [--brick <brick>] [--channel <name>] <command> [arguments]',
		'',
		...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`),
		'',
		'A brick is named by its name or its id. With none named and exactly one brick connected, that one is used.',
		'ev3 <name> runs the add-on ev3-<name> found on PATH.',
		'Exit codes: 0 done, 1 failed, 2 wrong command line, 3 the brick is busy, 4 a start that may or may not have happened,',
		'5 a person has to run and confirm it in a terminal, 6 the cockpit daemon could not be reached.',
	];
}

/** Runs one command line and resolves the exit code. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		return printError(io, argv.includes('--json'), error);
	}
	const { json } = parsed;
	if (parsed.command === undefined || parsed.command === 'help' || parsed.help) {
		const lines = helpText();
		const command = parsed.command ? COMMANDS[parsed.command] : undefined;
		for (const text of command ? [`Usage: ${command.usage}`, command.summary] : lines) { io.stdout.write(`${text}\n`); }
		return parsed.command === undefined && !parsed.help ? ExitCode.Usage : ExitCode.Ok;
	}
	const channel = parsed.channel ?? (io.env.EV3_COCKPIT_CHANNEL || undefined);

	const command = COMMANDS[parsed.command];
	if (!command) {
		try {
			const addon = findAddon(parsed.command, { env: io.env });
			if (!addon) { throw new UsageError(`There is no command ${parsed.command}, and no add-on ev3-${parsed.command} on PATH.`); }
			return await runAddon(addon, parsed.rest, channel ? { ...io.env, EV3_COCKPIT_CHANNEL: channel } : io.env);
		} catch (error) {
			return printError(io, json, error);
		}
	}

	const confirmer = new Confirmer({ input: io.stdin, output: io.stderr, isTTY: io.isTTY }, json);
	let launch: LaunchSpec | undefined;
	let client: CockpitClient | undefined;
	const ctx: CommandContext = {
		io, json, channel, confirmer,
		brick: parsed.brick,
		args: parsed.args,
		flags: parsed.flags,
		launch: () => (launch ??= cliLaunch()),
		client: async () => {
			if (client) { return client; }
			const spec = ctx.launch();
			client = await CockpitClient.connect({
				name: `ev3 ${parsed.command} (terminal)`,
				kind: 'cli',
				version: spec.version,
				launch: spec,
				...(channel ? { launchArgs: ['--channel', channel] } : {}),
				paths: clientPaths({ env: io.env, ...(channel ? { channel } : {}) }),
				reconnect: false,
			});
			client.onQuestion((question) => confirmer.answer(question));
			if (!json) { client.onNotice((notice) => io.stderr.write(`${notice.text}\n`)); }
			return client;
		},
	};
	try {
		const result = await command.run(ctx);
		printResult(io, json, result);
		return result.exitCode ?? ExitCode.Ok;
	} catch (error) {
		return printError(io, json, error);
	} finally {
		client?.dispose();
	}
}

if (require.main === module) {
	const io: CliIo = {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		env: process.env,
		cwd: process.cwd(),
	};
	void run(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
