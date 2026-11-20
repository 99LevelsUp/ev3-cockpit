/**
 * The VS Code extension: a client of the cockpit daemon (U11).
 *
 * It finds this user's daemon or starts it on VS Code's own Node (R32), and runs every command
 * through the client library; the daemon holds the bricks and the settings. In the Extension
 * Development Host it talks to a development daemon on the `dev` channel, which borrows bricks from
 * the user's daemon (KTD17); in the extension test host, to a daemon of its own on simulated bricks.
 *
 * The extension exports no API: add-ons use `@ev3-cockpit/client` (KTD18).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CockpitClient } from '../client';
import { channelFromEnv } from '../client/channel';
import { clientPaths, recordInstall, thisInstallLaunch } from '../client/locate';
import { versionNotice } from '../client/versions';
import type { ContractBrick, LaunchSpec } from '../contract/models';
import { DaemonBridge } from './daemonBridge';
import { BrickPickRow } from './ui/brickPickRows';
import { ShowProgress, connectPickedBrick, describeRepair, followPairing, pickBrick } from './ui/connectBrick';
import { clearBrickBluetoothList } from './ui/clearBluetoothList';
import { disconnectBrick } from './ui/disconnect';
import { BrickCommandDeps, forgetBrick } from './ui/forgetBrick';
import { createNotifier } from './ui/notify';
import { answerQuestion } from './ui/questions';
import { editSettings } from './ui/settings';

/** Where the brick keeps user projects. The one path worth a default. */
const PROJECTS_PATH = '/home/root/lms2012/prjs';

/**
 * Whether the development daemon shows simulated bricks: the `ev3-cockpit.mockBricks` user setting
 * when someone set it, otherwise yes while the extension runs from source (F5).
 */
function mockBricksWanted(context: vscode.ExtensionContext): boolean {
	const setting = vscode.workspace.getConfiguration('ev3-cockpit').inspect<boolean>('mockBricks');
	const chosen = setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
	return chosen ?? context.extensionMode === vscode.ExtensionMode.Development;
}

/** This user's daemon, a development daemon (F5), or a test host's own (KTD17). */
function channelFor(context: vscode.ExtensionContext): string | undefined {
	const named = channelFromEnv();
	if (named) { return named; }
	if (context.extensionMode === vscode.ExtensionMode.Development) { return 'dev'; }
	if (context.extensionMode === vscode.ExtensionMode.Test) { return `test-${process.pid}`; }
	return undefined;
}

/** The daemon in this extension, on VS Code's own Node; from source, tsc's output instead of the bundle. */
function launchOf(context: vscode.ExtensionContext): LaunchSpec {
	const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
	const launch = thisInstallLaunch(context.extensionPath, version);
	const fromSource = path.join(context.extensionPath, 'out', 'daemon', 'main.js');
	return fs.existsSync(launch.entry) || !fs.existsSync(fromSource) ? launch : { ...launch, entry: fromSource };
}

/** What the daemon is started with besides its launch: the channel, and simulated bricks where wanted. */
function launchArgsFor(context: vscode.ExtensionContext, channel: string | undefined): string[] {
	const args = channel ? ['--channel', channel] : [];
	if (context.extensionMode === vscode.ExtensionMode.Test) { return [...args, '--simulated']; }
	if (context.extensionMode === vscode.ExtensionMode.Development && mockBricksWanted(context)) {
		const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.scheme === 'file')?.uri.fsPath;
		return [...args, '--mock-bricks', ...(folder ? ['--mock-workspace', folder] : [])];
	}
	return args;
}

interface Cockpit {
	readonly client: CockpitClient;
	readonly bridge: DaemonBridge;
}

export function activate(context: vscode.ExtensionContext): void {
	const logger = vscode.window.createOutputChannel('EVƎ Cockpit', { log: true });
	context.subscriptions.push(logger);
	logger.info('EVƎ Cockpit activated');

	const channel = channelFor(context);
	const launch = launchOf(context);
	const paths = clientPaths(channel ? { channel } : {});
	let connected: Cockpit | undefined;
	// Every notification goes to this window's log and, once connected, to the daemon's (R30).
	const notify = createNotifier({
		info: (m) => { logger.info(m); void connected?.client.request('log/notice', { level: 'info', text: m.replace(/^Shown: /, '') }).catch(() => undefined); },
		warn: (m) => { logger.warn(m); void connected?.client.request('log/notice', { level: 'warning', text: m.replace(/^Shown: /, '') }).catch(() => undefined); },
		error: (m) => { logger.error(m); void connected?.client.request('log/notice', { level: 'error', text: m.replace(/^Shown: /, '') }).catch(() => undefined); },
	}, vscode.window);
	const progress: ShowProgress = (title, task) => {
		notify.progressShown(title);
		return vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
			(p) => task((message) => {
				notify.progressShown(`${title} — ${message}`);
				p.report({ message });
			}));
	};

	// A newer cockpit than the running daemon: offered as a restart in the status bar.
	const update = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	update.command = 'ev3-cockpit.restartDaemon';
	context.subscriptions.push(update);
	const showNotice = (notice: { readonly text: string; readonly newerIs?: string }): void => {
		logger.info(`Version: ${notice.text}`);
		if (notice.newerIs !== 'client') { void notify.warn(`EVƎ Cockpit: ${notice.text}`); return; }
		update.text = '$(sync) EVƎ daemon update';
		update.tooltip = notice.text;
		update.show();
	};

	const connecting: Promise<Cockpit> = CockpitClient.connect({
		name: `VS Code (${vscode.workspace.name ?? 'no folder'}, pid ${process.pid})`,
		kind: 'vscode',
		version: launch.version,
		launch,
		launchArgs: launchArgsFor(context, channel),
		paths,
	}).then((client) => {
		// Only the user's own cockpit is the one add-ons should start.
		if (!channel) { recordInstall(paths, launch); }
		const bridge = new DaemonBridge(client, {
			askPerson: (question) => {
				logger.info(`Asked: ${question.text}`);
				return answerQuestion(question, {
					notify: (message, ...actions) => notify.info(message, ...actions),
					modal: (message, detail, ...actions) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions),
				}).then((answer) => { logger.info(`Answered: ${answer}`); return answer; });
			},
		});
		context.subscriptions.push(bridge, { dispose: () => client.dispose() });
		// Every pairing shows its progress, whoever started it: the person at the brick has to know
		// when to look at its display.
		context.subscriptions.push(bridge.bricks.onPairingStarted((event) => {
			void followPairing(event, { aggregator: bridge.aggregator, progress, showError: (m) => { void notify.error(m); } });
		}));
		// A pairing broken on one side, found over USB or TCP: what was found and done (step-4 R6).
		context.subscriptions.push(bridge.bricks.onOneSidedRepair((repair) => {
			const { message, warning } = describeRepair(repair, bridge.aggregator.getBrick(repair.brickId)?.name.value ?? repair.brickId);
			void (warning ? notify.warn(message) : notify.info(message));
		}));
		client.onNotice((notice) => showNotice(notice));
		client.onLost((error) => { void notify.error(`EVƎ Cockpit: the cockpit daemon went and could not be reached again — ${error.message}`); });
		client.onReconnected((hello) => { logger.info(`Connected again to the cockpit daemon ${hello.version} (pid ${hello.pid})`); });
		const first = versionNotice(launch.version, client.daemon.version);
		if (first) { showNotice(first); }
		logger.info(`Connected to the cockpit daemon ${client.daemon.version} (pid ${client.daemon.pid}) on ${channel ?? 'the user\'s channel'}`);
		connected = { client, bridge };
		return connected;
	});
	connecting.catch((error: unknown) => {
		logger.error(`The cockpit daemon could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		void notify.error(`EVƎ Cockpit: the cockpit daemon could not be started — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
	});

	/** Runs a command once the daemon is there; says so when it is not. */
	const command = (id: string, body: (cockpit: Cockpit) => Promise<void> | void): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
			let cockpit: Cockpit;
			try {
				cockpit = await connecting;
			} catch {
				void notify.error('EVƎ Cockpit: the cockpit daemon is not running; see the EVƎ Cockpit log.');
				return;
			}
			try {
				await body(cockpit);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error(`${id} failed:`, err);
				void notify.error(`EVƎ Cockpit: ${err.message}`);
			}
		}));
	};

	/** This window's active brick, or the one connected brick when it has none. */
	const activeBrick = ({ client }: Cockpit, what: string): ContractBrick | undefined => {
		const id = client.activeBrick();
		const brick = (id ? client.brick(id) : undefined) ?? (() => {
			const connectedBricks = client.bricks().filter((b) => b.connected);
			return connectedBricks.length === 1 ? connectedBricks[0] : undefined;
		})();
		if (!brick?.connected) {
			void notify.warn(`EVƎ Cockpit: no active brick, so ${what} has nothing to talk to.`);
			return undefined;
		}
		return brick;
	};

	// ── Filesystem diagnostics (DESIGN §14) ─────────────────────
	command('ev3-cockpit.listProjects', async (cockpit) => {
		const brick = activeBrick(cockpit, 'listing projects');
		if (!brick) { return; }
		const entries = await cockpit.client.request('files/list', { brick: brick.brickId, path: PROJECTS_PATH });
		logger.info(`Files on ${brick.name} at ${PROJECTS_PATH} (${entries.length}):`);
		for (const e of entries) {
			logger.info(`  ${e.kind === 'directory' ? '[dir] ' : '      '}${e.name}${e.bytes === undefined ? '' : ` ${e.bytes} B`}`);
		}
		logger.show(true);
	});
	command('ev3-cockpit.showStorage', async (cockpit) => {
		const brick = activeBrick(cockpit, 'reading storage');
		if (!brick) { return; }
		const usage = await cockpit.client.request('bricks/storage', { brick: brick.brickId });
		void notify.info(`EVƎ Cockpit: ${brick.name} — ${usage.freeKb} KB free of ${usage.totalKb} KB (${usage.totalKb - usage.freeKb} KB used).`);
	});

	// ── Connect a brick ─────────────────────────────────────────
	// Picking a brick by name, in the owner's order (D5); picking signs it in over every channel it
	// is available on (KD1), pairing first a brick only an inquiry has heard.
	command('ev3-cockpit.connectBrick', async ({ client, bridge }) => {
		const picker = vscode.window.createQuickPick<BrickPickRow>();
		picker.title = 'EVƎ Cockpit: connect a brick';
		picker.placeholder = 'Pick a brick';
		picker.keepScrollPosition = true;
		const picked = await pickBrick(picker, bridge.aggregator as never, (brickId) => bridge.bricks.isSignedIn(brickId),
			() => client.request('bricks/inquiry', {}).then(() => undefined));
		if (!picked) { return; }
		await connectPickedBrick(picked, {
			aggregator: bridge.aggregator, bricks: bridge.bricks, log: logger, progress,
			showInfo: (message) => { void notify.info(message); },
			showError: (message) => { void notify.error(message); },
		});
	});

	// ── Disconnect a brick ──────────────────────────────────────
	// This window's hold only (R36); the person hears who else holds it and may end it for all.
	command('ev3-cockpit.disconnectBrick', async ({ client }) => {
		await disconnectBrick(client, {
			pick: (items) => vscode.window.showQuickPick([...items], { title: 'EVƎ Cockpit: disconnect a brick', placeHolder: 'Pick a brick to disconnect' }),
			notify: (message, ...actions) => notify.info(message, ...actions),
			log: (message) => logger.info(message),
		}, (brick) => brick.channels.map((c) => `${c.transport.toUpperCase()} ${c.state}`).join(' · '));
	});

	// The picker, modal confirmation, progress and messages the forget and clear-list commands share.
	const brickCommandUi = <B>(bridge: DaemonBridge, bricks: B, title: string, placeHolder: string): BrickCommandDeps<B> => ({
		aggregator: bridge.aggregator, bricks, log: logger,
		pick: (rows) => vscode.window.showQuickPick(rows, { title, placeHolder }),
		confirm: async (message, detail, action) => {
			logger.info(`Asked: ${message} ${detail}`);
			const confirmed = (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
			logger.info(`Answered: ${confirmed ? action : 'cancelled'}`);
			return confirmed;
		},
		progress: (progressTitle, task) => {
			notify.progressShown(progressTitle);
			return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: false }, task);
		},
		showInfo: (message) => { void notify.info(message); },
		showResult: (message) => {
			void notify.info(message, 'Show details').then((choice) => { if (choice) { logger.show(true); } });
		},
		showError: (message) => { void notify.error(message); },
	});

	// ── Forget a brick; clear a brick's Bluetooth list ──────────
	command('ev3-cockpit.forgetBrick', async ({ bridge }) => {
		await forgetBrick(brickCommandUi(bridge, bridge.bricks, 'EVƎ Cockpit: forget a brick', 'Pick a brick to forget'));
	});
	command('ev3-cockpit.clearBrickBluetoothList', async ({ bridge }) => {
		await clearBrickBluetoothList(brickCommandUi(bridge, bridge.bricks, 'EVƎ Cockpit: clear a brick\'s Bluetooth list', 'Pick a brick to clear'));
	});

	// ── Settings (R25) ──────────────────────────────────────────
	command('ev3-cockpit.settings', async ({ client }) => {
		await editSettings(client, {
			pick: (items, options) => vscode.window.showQuickPick([...items], options),
			input: (options) => vscode.window.showInputBox({ title: options.title, value: options.value, prompt: options.prompt, validateInput: options.validate }),
			confirm: async (message, detail, action) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
			showInfo: (message) => { void notify.info(message); },
			showError: (message) => { void notify.error(message); },
		});
	});

	// ── Restart the daemon (R37), on the person's confirmation ──
	command('ev3-cockpit.restartDaemon', async ({ client }) => {
		const restart = 'Restart';
		const choice = await vscode.window.showWarningMessage('Restart the cockpit daemon now?', {
			modal: true,
			detail: 'Connected bricks stay held and are connected again by the new daemon; a transfer or program start in progress may be cut off.',
		}, restart);
		if (choice !== restart) { return; }
		const result = await client.request('daemon/restart', { confirmedByPerson: true, launch });
		if (result.accepted) { update.hide(); } else { void notify.warn('EVƎ Cockpit: the cockpit daemon did not accept the restart now.'); }
	});

	logger.info('Commands registered');
}

export function deactivate(): void {
	// context.subscriptions disconnects from the daemon; the daemon ends on its own once nobody needs it.
}

