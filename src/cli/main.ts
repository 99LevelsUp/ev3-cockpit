/**
 * The `ev3` command: every cockpit operation from a terminal or a script, through the user's
 * cockpit daemon, which it starts when none runs.
 *
 *     ev3 [--json] [--brick <brick>] <command> [arguments]
 *
 * `--json` prints the result for programs; the exit code says how the command ended (see
 * output.ts, and `ev3 help`). A command that is not built in runs the add-on `ev3-<command>` found
 * on PATH.
 */

import { CockpitClient, CockpitClientOptions } from '../client/nativeClient';
import { nativeStateRoot } from '../client/locate';
import { findAddon, runAddon } from './addons';
import { brickCommands } from './commands/bricks';
import { configCommands } from './commands/config';
import { Command, CommandContext } from './commands/context';
import { daemonCommands } from './commands/daemon';
import { fileCommands } from './commands/files';
import { programCommands } from './commands/programs';
import { telemetryCommands } from './commands/telemetry';
import { Confirmer } from './confirm';
import { Installation, installation } from './installation';
import { CliIo, EXIT_CODE_HELP, ExitCode, UsageError, printError, printResult } from './output';

export const COMMANDS: Readonly<Record<string, Command>> = {
	...brickCommands, ...fileCommands, ...programCommands, ...telemetryCommands, ...configCommands, ...daemonCommands,
};

/** Short forms of a command's switches. */
const SHORT_FLAGS: Readonly<Record<string, string>> = { '-r': 'recursive' };

interface Parsed {
	json: boolean;
	help: boolean;
	version: boolean;
	brick?: string;
	command?: string;
	/** For an add-on: everything after its name, untouched. */
	rest: string[];
	args: string[];
	flags: Set<string>;
}

function parse(argv: readonly string[]): Parsed {
	const parsed: Parsed = { json: false, help: false, version: false, rest: [], args: [], flags: new Set() };
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
		if (token === '--version') { parsed.version = true; continue; }
		if (token === '--brick' || token.startsWith('--brick=')) { parsed.brick = valueOf('--brick'); continue; }
		const flag = SHORT_FLAGS[token] ?? (token.startsWith('--') ? token.slice(2) : undefined);
		if (command && flag && command.flags?.includes(flag)) { parsed.flags.add(flag); continue; }
		throw new UsageError(`Unknown option ${token}${parsed.command ? ` for ev3 ${parsed.command}` : ''}.`);
	}
	return parsed;
}

function helpText(): string[] {
	const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
	return [
		'Usage: ev3 [--json] [--brick <brick>] <command> [arguments]',
		'       ev3 --version',
		'',
		...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`),
		'',
		'A brick is named by its name or its id. With none named and exactly one brick connected, that one is used.',
		'What needs a person\'s yes (forget, bt-clear, access mode full, daemon restart) is asked here when this is an',
		'interactive terminal; elsewhere it is refused.',
		'ev3 <name> runs the add-on ev3-<name> found on PATH.',
		...EXIT_CODE_HELP,
	];
}

/** What a test may set: the installation, and options for the daemon client (a replay daemon of its own). */
export interface RunOptions {
	readonly installation?: Installation;
	readonly client?: Partial<CockpitClientOptions>;
}

/** Runs one command line and resolves the exit code. */
export async function run(argv: readonly string[], io: CliIo, options: RunOptions = {}): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		return printError(io, argv.includes('--json'), error);
	}
	const { json } = parsed;
	const install = options.installation ?? installation(__dirname);
	// This installation's version, from its package.json: no daemon is asked or started.
	if (parsed.version) {
		io.stdout.write(`${install.version}\n`);
		return ExitCode.Ok;
	}
	if (parsed.command === undefined || parsed.command === 'help' || parsed.help) {
		const lines = helpText();
		const command = parsed.command ? COMMANDS[parsed.command] : undefined;
		for (const text of command ? [`Usage: ${command.usage}`, command.summary] : lines) { io.stdout.write(`${text}\n`); }
		return parsed.command === undefined && !parsed.help ? ExitCode.Usage : ExitCode.Ok;
	}

	const command = COMMANDS[parsed.command];
	if (!command) {
		try {
			const addon = findAddon(parsed.command, { env: io.env });
			if (!addon) { throw new UsageError(`There is no command ${parsed.command}, and no add-on ev3-${parsed.command} on PATH.`); }
			return await runAddon(addon, parsed.rest, io.env);
		} catch (error) {
			return printError(io, json, error);
		}
	}

	const channel = install.channel(io.env);
	const name = `ev3 ${parsed.command} (terminal)`;
	const confirmer = new Confirmer({ input: io.stdin, output: io.stderr, isTTY: io.isTTY }, json, name);
	let client: CockpitClient | undefined;
	const open = async (): Promise<CockpitClient> => {
		const opened = await CockpitClient.connect({
			name,
			kind: 'cli',
			version: install.version,
			buildKind: install.buildKind,
			daemon: install.daemon(),
			// A terminal command never reconnects by itself: a restart reconnects on purpose.
			reconnect: false,
			...(channel ? { channel, stateRoot: nativeStateRoot({ env: io.env }) } : {}),
			...options.client,
		}, (text) => { if (!json) { io.stderr.write(`${text}\n`); } });
		// Without a person to answer, no handler: every question goes unanswered and the daemon refuses.
		if (confirmer.canAsk) { opened.onQuestion((question, context) => confirmer.answer(question, context)); }
		return opened;
	};
	const ctx: CommandContext = {
		io, json, channel, confirmer,
		brick: parsed.brick,
		args: parsed.args,
		flags: parsed.flags,
		client: async () => (client ??= await open()),
		reconnect: async () => {
			client?.dispose();
			client = undefined;
			return ctx.client();
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
	// A command that runs until stopped (--watch) ends on its own at the first Ctrl+C, letting go of
	// what it holds; a second one ends the process. Every other command keeps the default: Ctrl+C ends it.
	const interrupted = new AbortController();
	if (process.argv.includes('--watch')) {
		process.on('SIGINT', () => {
			if (interrupted.signal.aborted) { process.exit(130); }
			interrupted.abort();
		});
	}
	const io: CliIo = {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		env: process.env,
		cwd: process.cwd(),
		signal: interrupted.signal,
	};
	void run(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
