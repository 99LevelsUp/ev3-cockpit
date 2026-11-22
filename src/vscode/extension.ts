/**
 * The VS Code extension: a client of the native cockpit daemon.
 *
 * It finds this user's daemon, or starts the one it carries, and runs every command through the
 * client library; the daemon holds the bricks and the settings. Run from the repository (the
 * Extension Development Host) it carries the development build `npm run daemon:build` made, which
 * replaces a release daemon; installed, the daemon packaged with it. In the extension test host it
 * runs a development daemon of its own on a test channel, replaying a recorded brick, so the tests
 * never touch real hardware.
 *
 * The extension exports no API: add-ons use `@ev3-cockpit/client`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { NativeCockpitClient } from '../client/nativeClient';
import { developmentDaemon, packagedDaemon } from '../client/nativeLaunch';
import type { ContractBrick, LaunchSpec, Requester } from '../contract/generated';
import { CockpitStart, DaemonBridge, startFailureMessage } from './daemonBridge';
import { BrickPickRow } from './ui/brickPickRows';
import { clearBrickBluetoothList } from './ui/clearBluetoothList';
import { asError } from './ui/commandTypes';
import { ShowProgress, connectPickedBrick, describeRepair, followPairing, pickBrick } from './ui/connectBrick';
import { disconnectBrick } from './ui/disconnect';
import { BrickCommandDeps, forgetBrick } from './ui/forgetBrick';
import { createNotifier } from './ui/notify';
import { answerQuestion } from './ui/questions';
import { editSettings } from './ui/settings';

/** Where the brick keeps user projects. The one path worth a default. */
const PROJECTS_PATH = '/home/root/lms2012/prjs';

/** The recorded brick the extension test host's daemon replays. */
const TEST_HOST_SCENARIO = 'usb-connect-commands-aaa';

/**
 * The directory of an installed extension that holds the daemon binary and its manifest: its root,
 * where the platform VSIX carries both (scripts/package-vsix.cjs).
 */
function packagedDaemonDir(context: vscode.ExtensionContext): string {
	return context.extensionPath;
}

/** The daemon this extension carries, and where it runs it. */
interface DaemonChoice {
	readonly daemon: LaunchSpec;
	readonly channel?: string;
	readonly daemonArgs?: readonly string[];
}

/** Throws the client library's start failure when the daemon it would carry is not there. */
function daemonFor(context: vscode.ExtensionContext): DaemonChoice {
	switch (context.extensionMode) {
	case vscode.ExtensionMode.Development:
		return { daemon: developmentDaemon(context.extensionPath) };
	case vscode.ExtensionMode.Test:
		return {
			daemon: developmentDaemon(context.extensionPath),
			channel: `test-${process.pid}`,
			daemonArgs: ['--mode', 'replay', '--fixtures', path.join(context.extensionPath, 'daemon', 'fixtures', 'link', TEST_HOST_SCENARIO)],
		};
	default:
		return { daemon: packagedDaemon(packagedDaemonDir(context)) };
	}
}

interface Cockpit {
	readonly client: NativeCockpitClient;
	readonly bridge: DaemonBridge;
}

export function activate(context: vscode.ExtensionContext): void {
	const logger = vscode.window.createOutputChannel('EVƎ Cockpit', { log: true });
	context.subscriptions.push(logger);
	logger.info('EVƎ Cockpit activated');

	const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
	const me: Requester = { name: `VS Code (${vscode.workspace.name ?? 'no folder'}, pid ${process.pid})`, kind: 'vscode' };
	let connected: Cockpit | undefined;
	// Every notification goes to this window's log and, once connected, to the daemon's.
	const toDaemon = (level: 'info' | 'warning' | 'error', m: string): void => {
		void connected?.client.request('log/notice', { level, text: m.replace(/^Shown: /, '') }).catch(() => undefined);
	};
	const notify = createNotifier({
		info: (m) => { logger.info(m); toDaemon('info', m); },
		warn: (m) => { logger.warn(m); toDaemon('warning', m); },
		error: (m) => { logger.error(m); toDaemon('error', m); },
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

	const start = new CockpitStart<Cockpit>(async () => {
		const choice = daemonFor(context);
		const client = await NativeCockpitClient.connect({
			name: me.name, kind: 'vscode', version, daemon: choice.daemon,
			...(choice.channel ? { channel: choice.channel } : {}),
			...(choice.daemonArgs ? { daemonArgs: choice.daemonArgs } : {}),
		// Handed to connect itself: "a development daemon runs" is told while it connects.
		}, (notice) => { void notify.info(`EVƎ Cockpit: ${notice}`); });
		const bridge = new DaemonBridge(client, {
			me,
			askPerson: (question) => {
				logger.info(`Asked: ${question.text}`);
				return answerQuestion(question, {
					notify: (message, ...actions) => notify.info(message, ...actions),
					modal: (message, detail, ...actions) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions),
				}, me).then((reply) => { logger.info(`Answered: ${reply.answer}${reply.remember ? ' (remembered)' : ''}`); return reply; });
			},
		});
		context.subscriptions.push(bridge, { dispose: () => client.dispose() });
		// Every pairing shows its progress, whoever started it: the person at the brick has to know
		// when to look at its display.
		context.subscriptions.push(bridge.bricks.onPairingStarted((event) => {
			void followPairing(event, { list: bridge.list, progress, showError: (m) => { void notify.error(m); } });
		}));
		// A pairing broken on one side, found over USB or TCP: what was found and done.
		context.subscriptions.push(bridge.bricks.onOneSidedRepair(({ repair, pairingAgain }) => {
			const { message, warning } = describeRepair(repair, bridge.list.brick(repair.brickId)?.name ?? repair.brickId, pairingAgain);
			void (warning ? notify.warn(message) : notify.info(message));
		}));
		context.subscriptions.push(client.onLost((error) => {
			logger.error('The cockpit daemon went and could not be reached again:', error);
			void notify.error((error as { failure?: unknown }).failure
				? startFailureMessage(error)
				: `EVƎ Cockpit: the cockpit daemon went and could not be reached again — ${error.message}`);
		}));
		context.subscriptions.push(client.onReconnected((daemon) => { logger.info(`Connected again to the cockpit daemon ${daemon.version} (pid ${daemon.pid})`); }));
		logger.info(`Connected to the cockpit daemon ${client.daemon.version} (${client.daemon.buildKind}, pid ${client.daemon.pid})`
			+ `${choice.channel ? ` on ${choice.channel}` : ''}`);
		connected = { client, bridge };
		return connected;
	}, (message, error) => {
		logger.error('The cockpit daemon could not be reached:', error);
		void notify.error(message);
	});
	void start.ready().catch(() => undefined);

	/** Runs a command once the daemon is there; says so when it is not. */
	const command = (id: string, body: (cockpit: Cockpit) => Promise<void> | void): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
			let cockpit: Cockpit;
			try {
				cockpit = await start.ready();
			} catch {
				void notify.error('EVƎ Cockpit: the cockpit daemon is not running; see the EVƎ Cockpit log.');
				return;
			}
			try {
				await body(cockpit);
			} catch (error) {
				const err = asError(error);
				logger.error(`${id} failed:`, err);
				void notify.error(`EVƎ Cockpit: ${err.message}`);
			}
		}));
	};

	/** This window's active brick, or the one connected brick when it has none. */
	const activeBrick = ({ client, bridge }: Cockpit, what: string): ContractBrick | undefined => {
		const id = client.activeBrick();
		const brick = (id ? bridge.list.brick(id) : undefined) ?? (() => {
			const connectedBricks = client.bricks().filter((b) => b.connected);
			return connectedBricks.length === 1 ? connectedBricks[0] : undefined;
		})();
		if (!brick?.connected) {
			void notify.warn(`EVƎ Cockpit: no active brick, so ${what} has nothing to talk to.`);
			return undefined;
		}
		return brick;
	};

	// ── Filesystem diagnostics ──────────────────────────────────
	command('ev3-cockpit.listProjects', async (cockpit) => {
		const brick = activeBrick(cockpit, 'listing projects');
		if (!brick) { return; }
		const { entries } = await cockpit.client.request('files/list', { brick: brick.brickId, path: PROJECTS_PATH });
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
	// Picking a brick by name, in the owner's order; picking connects it over every channel it is
	// available on, pairing first a brick only an inquiry has heard.
	command('ev3-cockpit.connectBrick', async ({ client, bridge }) => {
		const picker = vscode.window.createQuickPick<BrickPickRow>();
		picker.title = 'EVƎ Cockpit: connect a brick';
		picker.placeholder = 'Pick a brick';
		picker.keepScrollPosition = true;
		const picked = await pickBrick(picker, bridge.list, () => client.request('bricks/inquiry', {}).then(() => undefined));
		if (!picked) { return; }
		await connectPickedBrick(picked, {
			list: bridge.list, bricks: bridge.bricks, log: logger, progress,
			showInfo: (message) => { void notify.info(message); },
			showError: (message) => { void notify.error(message); },
		});
	});

	// ── Disconnect a brick ──────────────────────────────────────
	// This window's hold only; the person hears who else holds it and may end it for all.
	command('ev3-cockpit.disconnectBrick', async ({ client }) => {
		await disconnectBrick(client, {
			pick: (items) => vscode.window.showQuickPick([...items], { title: 'EVƎ Cockpit: disconnect a brick', placeHolder: 'Pick a brick to disconnect' }),
			notify: (message, ...actions) => notify.info(message, ...actions),
			log: (message) => logger.info(message),
		}, (brick) => brick.channels.map((c) => `${c.transport.toUpperCase()} ${c.state}`).join(' · '));
	});

	// The picker, modal confirmation, progress and messages the forget and clear-list commands share.
	const brickCommandUi = <B>(bridge: DaemonBridge, bricks: B, title: string, placeHolder: string): BrickCommandDeps<B> => ({
		list: bridge.list, bricks, log: logger,
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

	// ── Settings ────────────────────────────────────────────────
	command('ev3-cockpit.settings', async ({ bridge }) => {
		await editSettings(bridge.settings, {
			pick: (items, options) => vscode.window.showQuickPick([...items], options),
			input: (options) => vscode.window.showInputBox({ title: options.title, value: options.value, prompt: options.prompt, validateInput: options.validate }),
			confirm: async (message, detail, action) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
			showInfo: (message) => { void notify.info(message); },
			showError: (message) => { void notify.error(message); },
		});
	});

	// ── Restart the daemon, on the person's confirmation ────────
	command('ev3-cockpit.restartDaemon', async ({ bridge }) => {
		const restart = 'Restart';
		const choice = await vscode.window.showWarningMessage('Restart the cockpit daemon now?', {
			modal: true,
			detail: 'It ends once no write is in progress, and a new one starts. Every window and terminal connects its bricks again; a program start in progress may be cut off.',
		}, restart);
		if (choice !== restart) { return; }
		const result = await bridge.restart();
		if (!result.accepted) {
			void notify.warn(`EVƎ Cockpit: the cockpit daemon did not accept the restart — ${result.reason ?? 'no reason given.'}`);
		}
	});

	logger.info('Commands registered');
}

export function deactivate(): void {
	// context.subscriptions disconnects from the daemon; the daemon ends on its own once nobody needs it.
}
