/**
 * The cockpit's MCP server: the cockpit's operations as tools for an agent, a thin layer over the
 * client library.
 *
 * - Nothing reaches the daemon until a tool needs a brick: starting the server and listing its
 *   tools neither starts a daemon nor connects remembered bricks.
 * - The server introduces itself to the daemon by the name its MCP client gave (`clientInfo`), so
 *   a person asked about the agent's request, or told who holds a busy brick, reads which agent it
 *   is.
 * - No tool can widen the agent's rights on its own. There is no daemon restart and no exit request,
 *   and no tool carries a person's confirmation. Forgetting a brick, clearing its Bluetooth list and
 *   switching access mode to `full` run only after the daemon asked a person in VS Code or a
 *   terminal, naming this agent, and got yes; with nobody there to ask, the daemon refuses with the
 *   command a person can run, and the tool result passes it on.
 * - Local paths are confined to the roots the MCP client declares, or to the working directory when
 *   it declares none. The daemon reads and writes them for the agent, so it must not reach where the
 *   agent's own host would not let it.
 * - A busy brick, an uncertain start and an operation that needs a person come back as tool results
 *   saying what to do next, never as protocol errors. A notice rides in the next result.
 * - A daemon that cannot start is a tool error naming why (`failure`) and what the user can do.
 *   When Windows Smart App Control blocks it, every later tool gets the same answer without the
 *   blocked binary being started again.
 *
 * Roots use the multi-round-trip form (`inputRequired`), which the SDK serves on both protocol
 * eras: on a 2025-era connection it turns them into the old server-to-client request.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, McpServer, inputRequired, inputResponse, isInputRequiredResult } from '@modelcontextprotocol/server';
import type { CallToolResult, ClientCapabilities, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ContractError } from '../client/connection';
import type { RequestOptions } from '../client/connection';
import type { CockpitClient } from '../client/nativeClient';
import { DaemonStartError } from '../client/nativeLaunch';
import { readTelemetryOnce, valueLine } from '../client/telemetryReading';
import { WireErrorCode } from '../contract/errors';
import type { BrickHolder, DeployResult } from '../contract/generated';

/** What the server needs of the client library. */
export type CockpitConnection = Pick<CockpitClient, 'request' | 'subscribeTelemetry' | 'onNotice' | 'onLost' | 'dispose' | 'daemon'>;

/** How this server introduces itself when its MCP client gave no usable name. */
export const MCP_CLIENT_NAME = 'EVƎ Cockpit MCP (agent)';

/** The longest client name the daemon's hello accepts. */
const MAX_CLIENT_NAME = 200;

export interface CockpitMcpOptions {
	/**
	 * Connects to the daemon as `clientName`, starting it when none runs; called by the first tool
	 * that needs a brick. `onNotice` hears what the user should know, from the connect on.
	 */
	readonly connect: (clientName: string, onNotice: (text: string) => void) => Promise<CockpitConnection>;
	/** This server's package version. */
	readonly version: string;
	/** Where local paths stay when the MCP client declares no roots; the process's working directory by default. */
	readonly cwd?: string;
}

type ToolResult = CallToolResult | InputRequiredResult;
type Data = Record<string, unknown>;

const ROOTS_KEY = 'roots';
/** The longest `program_status` waits for a change: well inside the 60 s a host commonly gives a tool call. */
export const MAX_STATUS_WAIT_MS = 30_000;
/** How long `read_telemetry` waits for every row to have a value, unless told otherwise. */
export const DEFAULT_TELEMETRY_WAIT_MS = 3000;

const DO_NOT_RUN_AGAIN = 'Do not run it again; check program_status first.';

/** A name the daemon's hello accepts: the MCP client's own, trimmed and bounded, else the server's. */
export function clientNameOf(name: unknown): string {
	const trimmed = typeof name === 'string' ? name.trim() : '';
	if (trimmed.length === 0) { return MCP_CLIENT_NAME; }
	return [...trimmed].slice(0, MAX_CLIENT_NAME).join('');
}

function holderName(holder: BrickHolder): string {
	if (holder.kind === 'hold') { return 'ev3 connect'; }
	if (holder.kind === 'remembered') { return 'remembered'; }
	return holder.client ?? 'a client';
}

export class CockpitMcp {
	private connecting: Promise<CockpitConnection> | undefined;
	private connection: CockpitConnection | undefined;
	private disposed = false;
	private readonly pendingNotices: string[] = [];
	private readonly deliveredNotices = new Set<string>();
	/** Smart App Control blocked the daemon: said once, and the blocked binary is not started again. */
	private blocked: DaemonStartError | undefined;

	constructor(private readonly options: CockpitMcpOptions) {}

	/** A server with every tool; one per MCP connection, all sharing one daemon connection. */
	createServer(): McpServer {
		const server = new McpServer({ name: 'ev3-cockpit', version: this.options.version }, { capabilities: { tools: {} } });
		this.register(server);
		return server;
	}

	dispose(): void {
		this.disposed = true;
		this.connection?.dispose();
		this.connection = undefined;
		this.connecting = undefined;
	}

	// --- the daemon connection ---------------------------------------------

	private client(clientName: string): Promise<CockpitConnection> {
		if (this.disposed) { return Promise.reject(new ContractError(WireErrorCode.DaemonUnavailable, 'The cockpit MCP server is shutting down.')); }
		if (this.blocked) { return Promise.reject(this.blocked); }
		this.connecting ??= this.options.connect(clientName, (text) => this.notice(text)).then((client) => {
			if (this.disposed) { client.dispose(); throw new ContractError(WireErrorCode.DaemonUnavailable, 'The cockpit MCP server is shutting down.'); }
			this.connection = client;
			client.onLost(() => {
				if (this.connection !== client) { return; }
				this.connection = undefined;
				this.connecting = undefined;
				client.dispose();
			});
			return client;
		}, (error: unknown) => {
			this.connecting = undefined;
			if (error instanceof DaemonStartError && error.failure === 'smart_app_control') { this.blocked = error; }
			throw error;
		});
		return this.connecting;
	}

	private notice(text: string): void {
		if (this.deliveredNotices.has(text) || this.pendingNotices.includes(text)) { return; }
		this.pendingNotices.push(text);
	}

	/** Adds the notices not yet shown to a tool result. */
	private withNotices(result: ToolResult): ToolResult {
		if (this.pendingNotices.length === 0 || isInputRequiredResult(result)) { return result; }
		const notices = this.pendingNotices.splice(0);
		for (const text of notices) { this.deliveredNotices.add(text); }
		return {
			...result,
			content: [...result.content, ...notices.map((text) => ({ type: 'text' as const, text: `Notice: ${text}` }))],
			structuredContent: { ...(result.structuredContent ?? {}), notices },
		};
	}

	/** Runs one tool's work against the daemon and turns whatever happens into a tool result. */
	private async run(server: McpServer, ctx: ServerContext, work: (client: CockpitConnection) => Promise<ToolResult>): Promise<ToolResult> {
		try {
			return this.withNotices(await work(await this.client(clientNameOf(clientInfo(server, ctx)?.name))));
		} catch (error) {
			return this.withNotices(errorResult(error));
		}
	}

	// --- local paths -------------------------------------------------------

	/**
	 * The roots local paths must stay in: the client's declared roots, asked for in a round of their
	 * own, or the working directory when it declares none.
	 */
	private roots(server: McpServer, ctx: ServerContext): readonly string[] | InputRequiredResult {
		const reply = inputResponse(ctx.mcpReq.inputResponses, ROOTS_KEY);
		if (reply.kind === 'roots') {
			const declared = reply.roots
				.filter((root) => root.uri.startsWith('file:'))
				.map((root) => { try { return fs.realpathSync.native(fileURLToPath(root.uri)); } catch { return undefined; } })
				.filter((root): root is string => root !== undefined);
			if (reply.roots.length > 0) { return declared; }
		} else if (clientCapabilities(server, ctx)?.roots) {
			return inputRequired({ inputRequests: { [ROOTS_KEY]: inputRequired.listRoots() } });
		}
		return [fs.realpathSync.native(this.options.cwd ?? process.cwd())];
	}

	/** Confines every local path a tool names, then runs it; a refused path sends nothing. */
	private local(server: McpServer, ctx: ServerContext, paths: readonly { readonly given: string; readonly mustExist: boolean }[],
		work: (client: CockpitConnection, resolved: readonly string[]) => Promise<ToolResult>): Promise<ToolResult> {
		const roots = this.roots(server, ctx);
		if (!Array.isArray(roots)) { return Promise.resolve(roots as InputRequiredResult); }
		const resolved: string[] = [];
		for (const { given, mustExist } of paths) {
			const confined = confineLocalPath(given, roots as readonly string[], { cwd: this.options.cwd ?? process.cwd(), mustExist });
			if (!confined.ok) {
				return Promise.resolve(this.withNotices(refusal('path_outside_roots', confined.reason,
					'Use a path inside the folders this agent host lets you work in.', { localPath: given, roots })));
			}
			resolved.push(confined.path);
		}
		return this.run(server, ctx, (client) => work(client, resolved));
	}

	// --- the tools ---------------------------------------------------------

	private register(server: McpServer): void {
		const brick = z.string().min(1).describe('The brick, by its id or its name as list_bricks shows them.');
		const remote = (what: string): z.ZodString => z.string().min(1).describe(`${what} on the brick, absolute, for example /home/root/lms2012/prjs/Demo/Demo.rbf.`);
		const localPath = (what: string): z.ZodString => z.string().min(1).describe(`${what} on this computer. It must lie inside the folders this agent host lets you work in.`);
		const readOnly = { readOnlyHint: true, openWorldHint: false };
		const changes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
		const destroys = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

		server.registerTool('list_bricks', {
			description: 'List the EV3 bricks the cockpit sees, connected or not, with how each is reachable (USB, Bluetooth, Wi-Fi) and who holds it. Waits for the first discovery round when the cockpit has just started.',
			inputSchema: z.object({}), annotations: readOnly,
		}, (_args, ctx) => this.run(server, ctx, async (client) => {
			const { bricks } = await client.request('bricks/list', { waitForDiscovery: true }, requestOptions(ctx));
			const lines = bricks.map((b) => {
				const state = b.reconnecting ? 'reconnecting after a daemon restart' : b.connected ? 'connected' : 'not connected';
				const holders = b.holders.map(holderName).join(', ');
				return `${b.name} (${b.brickId}): ${state}, ${b.channels.map((c) => c.transport).join('+') || 'no channel'}${holders ? `, held by ${holders}` : ''}`;
			});
			return plain(bricks.length > 0 ? lines.join('\n') : 'No bricks found.', { bricks });
		}));

		server.registerTool('connect_brick', {
			description: 'Connect a brick for this agent; file and program tools need it connected. The brick stays connected while this agent session lasts, unless disconnect_brick drops it.',
			inputSchema: z.object({ brick }), annotations: changes,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const connected = await client.request('bricks/connect', { brick: ref }, requestOptions(ctx));
			return plain(`Connected ${connected.name} (${connected.brickId}).`, { brick: connected });
		}));

		server.registerTool('disconnect_brick', {
			description: 'Drop this agent\'s hold on a brick. Other clients holding it (VS Code, a terminal) keep it connected.',
			inputSchema: z.object({ brick }), annotations: changes,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const result = await client.request('bricks/disconnect', { brick: ref }, requestOptions(ctx));
			return plain(result.stillHeldBy.length > 0 ? `Dropped this agent's hold; still held by ${result.stillHeldBy.join(', ')}.` : 'Disconnected.', { ...result });
		}));

		server.registerTool('brick_info', {
			description: 'A connected brick\'s name and firmware.',
			inputSchema: z.object({ brick }), annotations: readOnly,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const info = await client.request('bricks/info', { brick: ref }, requestOptions(ctx));
			return plain(`${info.name} (${info.brickId})${info.firmwareVersion ? `, firmware ${info.firmwareVersion}` : ''}`, { ...info });
		}));

		server.registerTool('brick_storage', {
			description: 'How much storage a connected brick has, and how much is free, in kilobytes.',
			inputSchema: z.object({ brick }), annotations: readOnly,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const storage = await client.request('bricks/storage', { brick: ref }, requestOptions(ctx));
			return plain(`${storage.freeKb} KB free of ${storage.totalKb} KB.`, { ...storage });
		}));

		server.registerTool('list_files', {
			description: 'List a folder on a connected brick.',
			inputSchema: z.object({ brick, path: remote('The folder') }), annotations: readOnly,
		}, ({ brick: ref, path: folder }, ctx) => this.run(server, ctx, async (client) => {
			const { entries } = await client.request('files/list', { brick: ref, path: folder }, requestOptions(ctx));
			return plain(entries.length > 0 ? entries.map((e) => `${e.kind === 'directory' ? `${e.name}/` : e.name}${e.bytes !== undefined ? ` (${e.bytes} B)` : ''}`).join('\n') : 'The folder is empty.', { entries });
		}));

		server.registerTool('read_file', {
			description: 'Copy a file from a connected brick to a local file. The local file is created or replaced.',
			inputSchema: z.object({ brick, path: remote('The file'), localPath: localPath('Where to save it') }), annotations: changes,
		}, ({ brick: ref, path: file, localPath: given }, ctx) => this.local(server, ctx, [{ given, mustExist: false }], async (client, [target]) => {
			const result = await client.request('files/read', { brick: ref, path: file, toLocalPath: target }, requestOptions(ctx));
			return plain(`Saved ${result.bytes} bytes to ${target}.`, { bytes: result.bytes, localPath: target });
		}));

		server.registerTool('write_file', {
			description: 'Copy a local file to a connected brick. Folders on the brick are created as needed; an existing file is replaced.',
			inputSchema: z.object({ brick, path: remote('Where to put it'), localPath: localPath('The file to send') }), annotations: changes,
		}, ({ brick: ref, path: file, localPath: given }, ctx) => this.local(server, ctx, [{ given, mustExist: true }], async (client, [source]) => {
			const result = await client.request('files/write', { brick: ref, path: file, fromLocalPath: source }, requestOptions(ctx));
			return plain(`Wrote ${result.bytes} bytes to ${file}.`, { bytes: result.bytes, path: file });
		}));

		server.registerTool('remove_file', {
			description: 'Remove a file or folder on a connected brick; a folder with content needs recursive. Outside the projects folder and the SD card this is refused unless the user switched the cockpit to full access.',
			inputSchema: z.object({ brick, path: remote('The file or folder'), recursive: z.boolean().optional().describe('Remove a folder with everything in it.') }), annotations: destroys,
		}, ({ brick: ref, path: target, recursive }, ctx) => this.run(server, ctx, async (client) => {
			const report = await client.request('files/remove', { brick: ref, path: target, ...(recursive ? { recursive } : {}) }, requestOptions(ctx));
			return plain(removedText(target, report.leftBehind), { ...report });
		}));

		server.registerTool('remove_paths', {
			description: 'Remove several files or folders on a connected brick in one go.',
			inputSchema: z.object({ brick, paths: z.array(z.string().min(1)).min(1).describe('Absolute paths on the brick.'), recursive: z.boolean().optional().describe('Remove folders with everything in them.') }), annotations: destroys,
		}, ({ brick: ref, paths, recursive }, ctx) => this.run(server, ctx, async (client) => {
			const report = await client.request('files/removePaths', { brick: ref, paths, ...(recursive ? { recursive } : {}) }, requestOptions(ctx));
			return plain(removedText(`${paths.length} path(s)`, report.leftBehind), { ...report });
		}));

		server.registerTool('make_directory', {
			description: 'Create a folder on a connected brick.',
			inputSchema: z.object({ brick, path: remote('The folder') }), annotations: changes,
		}, ({ brick: ref, path: folder }, ctx) => this.run(server, ctx, async (client) => {
			await client.request('files/makeDirectory', { brick: ref, path: folder }, requestOptions(ctx));
			return plain(`Created ${folder}.`, { path: folder });
		}));

		server.registerTool('move_file', {
			description: 'Move or rename a file or folder on a connected brick.',
			inputSchema: z.object({ brick, from: remote('What to move'), to: remote('Where to') }), annotations: changes,
		}, ({ brick: ref, from, to }, ctx) => this.run(server, ctx, async (client) => {
			await client.request('files/move', { brick: ref, from, to }, requestOptions(ctx));
			return plain(`Moved ${from} to ${to}.`, { from, to });
		}));

		server.registerTool('deploy_and_run', {
			description: 'Upload local files to a connected brick and start a program, as one step: it checks nothing runs, uploads, starts and confirms the start. If the result says the start is uncertain, do not run it again; check program_status first.',
			inputSchema: z.object({
				brick,
				files: z.array(z.object({
					localPath: localPath('The file to upload'),
					remotePath: remote('Where it goes'),
					skipIfSameMd5: z.boolean().optional().describe('Skip the upload when the brick already holds the same content.'),
				})).describe('The files to upload first.'),
				runPath: remote('The program to start'),
			}),
			annotations: changes,
		}, ({ brick: ref, files, runPath }, ctx) => this.local(server, ctx, files.map((f) => ({ given: f.localPath, mustExist: true })), async (client, sources) => {
			const result = await client.request('programs/deployAndRun', {
				brick: ref, runPath,
				files: files.map((f, i) => ({ remotePath: f.remotePath, localPath: sources[i], ...(f.skipIfSameMd5 ? { skipIfSameMd5: true } : {}) })),
			}, requestOptions(ctx));
			return startResult(result);
		}));

		server.registerTool('run_program', {
			description: 'Start a program already on a connected brick. If the result says the start is uncertain, do not run it again; check program_status first.',
			inputSchema: z.object({ brick, path: remote('The program'), replace: z.boolean().optional().describe('Stop a program that runs now first.') }), annotations: changes,
		}, ({ brick: ref, path: program, replace }, ctx) => this.run(server, ctx, async (client) =>
			startResult(await client.request('programs/run', { brick: ref, path: program, ...(replace ? { replace } : {}) }, requestOptions(ctx)))));

		server.registerTool('stop_program', {
			description: 'Stop the program running on a brick, whoever started it.',
			inputSchema: z.object({ brick }), annotations: changes,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const state = await client.request('programs/stop', { brick: ref }, requestOptions(ctx));
			return plain(state.running ? 'Asked to stop; the program still runs.' : 'Stopped.', { ...state });
		}));

		server.registerTool('emergency_stop', {
			description: 'Stop the program on a brick at once and halt its motors.',
			inputSchema: z.object({ brick }), annotations: changes,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const state = await client.request('programs/emergencyStop', { brick: ref }, requestOptions(ctx));
			return plain(state.running ? 'Emergency stop sent; the program still runs.' : 'Stopped.', { ...state });
		}));

		server.registerTool('program_status', {
			description: `Whether a program runs on a brick. With waitMs, waits up to that long (at most ${MAX_STATUS_WAIT_MS} ms) for it to change, and answers at once when it does.`,
			inputSchema: z.object({ brick, waitMs: z.number().int().min(0).max(MAX_STATUS_WAIT_MS).optional().describe('How long to wait for a change, in milliseconds.') }),
			annotations: readOnly,
		}, ({ brick: ref, waitMs }, ctx) => this.run(server, ctx, async (client) => {
			const state = await client.request('programs/status', { brick: ref, ...(waitMs ? { waitMs } : {}) }, requestOptions(ctx));
			return plain(`${state.running ? 'A program runs' : 'No program runs'} (last start number ${state.runSeq})${state.stoppedBy ? `; stopped by ${state.stoppedBy}` : ''}.`, { ...state });
		}));

		server.registerTool('list_telemetry_rows', {
			description: 'The telemetry rows the cockpit can read from a brick (battery, program, motors and sensors by port), with their units. Pass their ids to read_telemetry.',
			inputSchema: z.object({}), annotations: readOnly,
		}, (_args, ctx) => this.run(server, ctx, async (client) => {
			const { rows } = await client.request('telemetry/rows', {}, requestOptions(ctx));
			return plain(rows.map((r) => `${r.id}${r.unit ? ` (${r.unit})` : ''}${r.port ? `, port ${r.port}` : ''}`).join('\n'), { rows });
		}));

		server.registerTool('read_telemetry', {
			description: `Read telemetry of a connected brick once: the rows named, or every row. Connecting a brick does not start telemetry; this reads only for the call, and stops when every row has a value or after waitMs (default ${DEFAULT_TELEMETRY_WAIT_MS} ms, at most ${MAX_STATUS_WAIT_MS} ms). Rows without a value in time are listed as missing.`,
			inputSchema: z.object({
				brick,
				rows: z.array(z.string().min(1)).optional().describe('Row ids as list_telemetry_rows shows them; every row when left out.'),
				waitMs: z.number().int().min(0).max(MAX_STATUS_WAIT_MS).optional().describe('How long to wait for values, in milliseconds.'),
			}),
			annotations: readOnly,
		}, ({ brick: ref, rows, waitMs }, ctx) => this.run(server, ctx, async (client) => {
			const reading = await readTelemetryOnce(client, ref, rows ?? [], waitMs ?? DEFAULT_TELEMETRY_WAIT_MS, ctx.mcpReq.signal);
			const lines = reading.values.map(valueLine);
			if (reading.missing.length > 0) { lines.push(`No value yet for ${reading.missing.join(', ')}.`); }
			return plain(lines.length > 0 ? lines.join('\n') : 'No telemetry values.', { ...reading });
		}));

		server.registerTool('pair', {
			description: 'Pair a brick with this computer over Bluetooth. The user confirms it on the brick itself.',
			inputSchema: z.object({ brick }), annotations: changes,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const result = await client.request('bricks/pair', { brick: ref }, requestOptions(ctx));
			const text = result.outcome === 'paired' ? 'Paired.'
				: result.outcome === 'cancelled' ? 'The pairing was cancelled.'
					: `Not paired${result.message ? `: ${result.message}` : '.'}`;
			return plain(text, { ...result, paired: result.outcome === 'paired' });
		}));

		server.registerTool('forget', {
			description: 'Unpair a brick on this computer and on the brick. The user is asked first, in VS Code or a terminal where the cockpit runs, and told this agent asked; when nobody is there to ask, the result names the command the user can run instead.',
			inputSchema: z.object({ brick }), annotations: destroys,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const result = await client.request('bricks/forget', { brick: ref }, requestOptions(ctx));
			return plain(result.forgotten ? `Forgotten.\n${result.lines.join('\n')}` : 'Not forgotten.', { ...result });
		}));

		server.registerTool('clear_bluetooth_list', {
			description: 'Remove the entries from a brick\'s list of paired Bluetooth devices. The user is asked first, with the entries listed, in VS Code or a terminal where the cockpit runs, and told this agent asked; when nobody is there to ask, the result names the command the user can run instead.',
			inputSchema: z.object({ brick }), annotations: destroys,
		}, ({ brick: ref }, ctx) => this.run(server, ctx, async (client) => {
			const result = await client.request('bricks/clearBluetoothList', { brick: ref }, requestOptions(ctx));
			return plain(`Removed ${result.removed.length} entr${result.removed.length === 1 ? 'y' : 'ies'}${result.kept.length > 0 ? `; kept ${result.kept.join(', ')}` : ''}.`, { ...result });
		}));

		server.registerTool('get_settings', {
			description: 'The cockpit\'s settings with their current values, defaults and limits. A setting marked dangerous changes only after the user says yes in VS Code or a terminal.',
			inputSchema: z.object({}), annotations: readOnly,
		}, (_args, ctx) => this.run(server, ctx, async (client) => {
			const settings = (await client.request('settings/list', {}, requestOptions(ctx))).settings.map((s) => ({ ...s.spec, value: s.value }));
			return plain(settings.map((s) => `${s.key} = ${JSON.stringify(s.value)}${s.dangerous ? ' (changes only on the user\'s yes)' : ''}`).join('\n'), { settings });
		}));

		server.registerTool('set_setting', {
			description: 'Change one cockpit setting. A dangerous one, such as the access mode, changes only after the user says yes in VS Code or a terminal, and is told this agent asked; when nobody is there to ask, the result names the command the user can run instead.',
			inputSchema: z.object({
				key: z.string().min(1).describe('The setting\'s key as get_settings shows it.'),
				value: z.union([z.boolean(), z.number(), z.string()]).describe('The new value.'),
			}),
			annotations: changes,
		}, ({ key, value }, ctx) => this.run(server, ctx, async (client) => {
			const setting = await client.request('settings/set', { key, value }, requestOptions(ctx));
			return plain(`${setting.spec.key} = ${JSON.stringify(setting.value)}.`, { key: setting.spec.key, value: setting.value });
		}));
	}
}

// --- results ---------------------------------------------------------------

function plain(text: string, data: Data): CallToolResult {
	return { content: [{ type: 'text', text }], structuredContent: data };
}

/** A tool result for something that did not happen, saying why and what to do instead. */
function refusal(code: string, message: string, next: string | undefined, extra: Data = {}): CallToolResult {
	return {
		content: [{ type: 'text', text: next ? `${message}\n${next}` : message }],
		structuredContent: { error: { code, message, ...extra }, ...(next ? { next } : {}) },
		isError: true,
	};
}

/** A daemon error as a tool result: who holds a busy brick, the command a person must run, what to check. */
export function errorResult(error: unknown): CallToolResult {
	if (!(error instanceof ContractError)) {
		const message = error instanceof Error ? error.message : String(error);
		return refusal(WireErrorCode.Internal, message, undefined);
	}
	const { holder, command, candidates } = error.data;
	const extra: Data = {
		...(error instanceof DaemonStartError ? { failure: error.failure } : {}),
		...(holder ? { holder } : {}),
		...(command ? { command } : {}),
		...(candidates ? { candidates } : {}),
	};
	let next: string | undefined;
	switch (error.code) {
	case WireErrorCode.BrickBusy:
		next = `${holder ?? 'Another client'} is working with the brick now. Try again once it has finished.`;
		break;
	case WireErrorCode.NeedsPerson:
		next = command ? `Only the user can do this. Ask them to run: ${command}` : 'Only the user can do this, in a terminal or in VS Code.';
		break;
	case WireErrorCode.Cancelled:
		next = 'It did not happen: the user said no, or it was cancelled. Do not try again unless the user asks.';
		break;
	case WireErrorCode.OutcomeUnknown:
		next = `Whether it took effect is unknown. ${DO_NOT_RUN_AGAIN}`;
		break;
	case WireErrorCode.BrickAmbiguous:
		next = candidates ? `Name the brick by its id: ${candidates.map((c) => `${c.brickId} (${c.name})`).join(', ')}.` : 'Name the brick by its id.';
		break;
	case WireErrorCode.NotConnected:
		next = 'If the brick is not connected, connect it with connect_brick.';
		break;
	case WireErrorCode.AccessDenied:
		next = command ? `Safe mode refuses this. Only the user can switch on full mode. Ask them to run: ${command}` : 'The cockpit does not allow this for an agent.';
		break;
	case WireErrorCode.DaemonUnavailable:
		next = error instanceof DaemonStartError ? startFailureNext(error) : 'The cockpit daemon is not reachable. The user can check it with ev3 daemon status.';
		break;
	default:
		break;
	}
	return refusal(error.code, error.message, next, extra);
}

/** What to do about a daemon that could not be started, by why. */
function startFailureNext(error: DaemonStartError): string {
	switch (error.failure) {
	case 'smart_app_control':
		return 'The cockpit cannot run on this computer while Windows Smart App Control is on. Tell the user; trying again does not help.';
	case 'missing_binary':
	case 'sha_mismatch':
	case 'not_private':
		return 'This installation of EVƎ Cockpit cannot start its daemon safely. Ask the user to reinstall it, or to rebuild it with npm run daemon:build when it runs from the repository.';
	case 'contract_mismatch':
		return 'The running cockpit daemon and this server do not speak the same contract. Ask the user to update the older of the two.';
	default:
		return 'The cockpit daemon could not be started. The user can read why with ev3 daemon log.';
	}
}

/** How a start ended, with what to do when it is not known whether the program runs. */
export function startResult(result: DeployResult): CallToolResult {
	const uploaded = result.uploaded.length + result.skipped.length > 0
		? ` Uploaded ${result.uploaded.length} file(s), skipped ${result.skipped.length} the brick already had.` : '';
	switch (result.outcome) {
	case 'started':
		return plain(`Started (start number ${result.runSeq}).${uploaded}`, { ...result });
	case 'not_seen_running':
		return plain(`The brick took the start, but the program was not seen running; it may have ended at once.${uploaded} Check program_status.`,
			{ ...result, next: 'Check program_status.' });
	case 'uncertain':
		return plain(`The reply to the start was lost: the program may or may not be running.${uploaded} ${DO_NOT_RUN_AGAIN}`,
			{ ...result, next: DO_NOT_RUN_AGAIN });
	}
}

function removedText(what: string, leftBehind: readonly string[]): string {
	return leftBehind.length > 0 ? `Removed ${what}, except: ${leftBehind.join(', ')}.` : `Removed ${what}.`;
}

// --- the MCP client ----------------------------------------------------------

function envelopeOf(ctx: ServerContext): Record<string, unknown> | undefined {
	return ctx.mcpReq.envelope as Record<string, unknown> | undefined;
}

/** The client's capabilities: per request on the 2026-07-28 protocol, from its `initialize` before. */
function clientCapabilities(server: McpServer, ctx: ServerContext): ClientCapabilities | undefined {
	return (envelopeOf(ctx)?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ?? server.server.getClientCapabilities();
}

/** Who the MCP client said it is: per request on the 2026-07-28 protocol, from its `initialize` before. */
function clientInfo(server: McpServer, ctx: ServerContext): { readonly name?: unknown } | undefined {
	return (envelopeOf(ctx)?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined) ?? server.server.getClientVersion();
}

/** Cancels the daemon request with the tool call, and reports transfer progress when the client asked for it. */
function requestOptions(ctx: ServerContext): RequestOptions {
	const token = ctx.mcpReq._meta?.progressToken;
	if (token === undefined) { return { signal: ctx.mcpReq.signal }; }
	return {
		signal: ctx.mcpReq.signal,
		onProgress: (value) => {
			const progress = value as { transferred?: unknown; total?: unknown } | undefined;
			if (typeof progress?.transferred !== 'number') { return; }
			void ctx.mcpReq.notify({
				method: 'notifications/progress',
				params: { progressToken: token, progress: progress.transferred, ...(typeof progress.total === 'number' ? { total: progress.total } : {}) },
			}).catch(() => undefined);
		},
	};
}

// --- confinement -------------------------------------------------------------

export type Confined = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * A local path, made absolute and with every symbolic link resolved, accepted only inside one of
 * the roots (themselves resolved). A file that does not exist yet is resolved through its folder.
 */
export function confineLocalPath(given: string, roots: readonly string[], options: { readonly cwd: string; readonly mustExist: boolean; readonly platform?: NodeJS.Platform }): Confined {
	const absolute = path.resolve(options.cwd, given);
	let real: string;
	try {
		real = fs.realpathSync.native(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return { ok: false, reason: `${absolute} cannot be resolved: ${(error as Error).message}` }; }
		if (options.mustExist) { return { ok: false, reason: `${absolute} does not exist.` }; }
		// A name that is there but does not resolve is a link to nowhere: writing to it would follow
		// the link wherever it points, so it is refused rather than resolved through its folder.
		try {
			fs.lstatSync(absolute);
			return { ok: false, reason: `${absolute} is a link to something that does not exist.` };
		} catch { /* truly missing: resolved through its folder below */ }
		try {
			real = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
		} catch {
			return { ok: false, reason: `The folder ${path.dirname(absolute)} does not exist.` };
		}
	}
	const fold = (options.platform ?? process.platform) === 'win32' ? (p: string): string => p.toLowerCase() : (p: string): string => p;
	const inside = roots.some((root) => {
		const relative = path.relative(fold(root), fold(real));
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	});
	return inside ? { ok: true, path: real } : { ok: false, reason: `${absolute} is outside the folders this agent may use (${roots.join(', ')}).` };
}
