import * as vscode from 'vscode';
import { DisposableStore } from './events';
import { createBrickFilesystem, BrickFilesystem } from './fs/brickFilesystem';
import { setSweepConfirmation } from './fs/transferLedger';
import { createRuntime } from './runtime/createRuntime';
import { brickLabel } from './runtime/brickLabels';
import { BrickId } from './contracts';
import { BrickPickRow, describeChannels } from './ui/brickPickRows';
import { ShowProgress, connectPickedBrick, describeRepair, followPairing, pickBrick } from './ui/connectBrick';
import { clearBrickBluetoothList } from './ui/clearBluetoothList';
import { BrickCommandDeps, forgetBrick } from './ui/forgetBrick';
import { createNotifier } from './ui/notify';
import { AccessMode } from './api/accessPolicy';
import { CockpitApi, createCockpitApi } from './api/cockpitApi';
import { NotConnectedError } from './errors/CockpitError';
import { readTelemetrySettings, readThrottleSettings } from './telemetry/telemetrySettings';

/** Where the brick keeps user projects. The one path worth a default. */
const PROJECTS_PATH = '/home/root/lms2012/prjs';

/**
 * Whether to show the simulated bricks. The `ev3-cockpit.mockBricks` setting decides when
 * someone has set it; otherwise they appear only while the extension runs from source (F5),
 * so an installed build never shows six robots that are not there.
 */
function mockBricksWanted(context: vscode.ExtensionContext): boolean {
	const setting = vscode.workspace.getConfiguration('ev3-cockpit').inspect<boolean>('mockBricks');
	const chosen = setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
	return chosen ?? context.extensionMode === vscode.ExtensionMode.Development;
}

export function activate(context: vscode.ExtensionContext): CockpitApi {
	const logger = vscode.window.createOutputChannel('EVƎ Cockpit', { log: true });
	context.subscriptions.push(logger);

	logger.info('EVƎ Cockpit activated');

	const services = new DisposableStore();
	context.subscriptions.push(services);

	const runtime = services.add(createRuntime({
		extensionPath: context.extensionPath,
		log: logger,
		// Not in the extension test host: its suite must not page real bricks around the desk.
		startPresence: context.extensionMode !== vscode.ExtensionMode.Test,
		mockBricks: mockBricksWanted(context),
		// The user's settings; VS Code hands back package.json's default for what nobody set (D9).
		telemetrySettings: readTelemetrySettings(vscode.workspace.getConfiguration('ev3-cockpit'), (m) => logger.warn(m)),
		throttleSettings: readThrottleSettings(vscode.workspace.getConfiguration('ev3-cockpit'), (m) => logger.warn(m)),
	}));
	// A changed setting applies at once, no reload.
	services.add(vscode.workspace.onDidChangeConfiguration((e) => {
		if (!e.affectsConfiguration('ev3-cockpit.telemetry')) { return; }
		const section = vscode.workspace.getConfiguration('ev3-cockpit');
		runtime.telemetryView.configure(readTelemetrySettings(section, (m) => logger.warn(m)));
		runtime.telemetry.configureThrottle(readThrottleSettings(section, (m) => logger.warn(m)));
		logger.info('Telemetry settings changed');
	}));
	const { bricks, aggregator, btPresence } = runtime;
	/** What a user calls a brick: its name, or its id until it has one. */
	const nameOf = (brickId: BrickId): string => aggregator.getBrick(brickId)?.name.value ?? brickId;
	// Every notification is written to the log too (owner, 09.11.2026), so the log alone says
	// what the person was told while they watched the brick.
	const notify = createNotifier(logger, vscode.window);
	// A transfer whose first reply was lost may have left a slot, and its file's space, taken on the
	// brick until a reboot. Releasing it means closing every open file there, another computer's
	// live transfer included, so it is the user's call (4.6.17; owner decision 13.11.2026).
	setSweepConfirmation(bricks, async () => {
		const release = 'Release';
		const pick = await notify.info(
			'A file transfer to the brick was cut off before the brick said which file it opened, '
			+ 'so its space may stay taken until the brick restarts. Release it now? This closes every '
			+ 'file the brick has open, including a transfer another computer may be running.', release);
		return pick === release;
	});
	const notificationProgress: ShowProgress = (title, task) => {
		notify.progressShown(title);
		return vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
			(progress) => task((message) => {
				notify.progressShown(`${title} — ${message}`);
				progress.report({ message });
			}));
	};

	// ── Filesystem ──────────────────────────────────────────────
	// Palette commands are diagnostics, not the primary UX (DESIGN §14). They exist here
	// so the filesystem layer has a consumer before the API and panel arrive, and so it
	// can be exercised by hand against a real brick.
	const withActiveFilesystem = async (
		what: string,
		body: (fs: BrickFilesystem, brickId: BrickId) => Promise<void>,
	): Promise<void> => {
		const brickId = bricks.getActiveBrickId();
		if (!brickId) {
			void notify.warn(
				`EVƎ Cockpit: no active brick, so ${what} has nothing to talk to.`);
			return;
		}
		try {
			await body(createBrickFilesystem(bricks, brickId), brickId);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`${what} failed on ${brickLabel(aggregator, brickId)}:`, err);
			void notify.error(`EVƎ Cockpit: ${what} on ${nameOf(brickId)} failed — ${err.message}`);
		}
	};

	services.add(vscode.commands.registerCommand('ev3-cockpit.listProjects', () =>
		withActiveFilesystem('listing projects', async (fs, brickId) => {
			const entries = await fs.files.list(PROJECTS_PATH);
			logger.info(`Files on ${brickLabel(aggregator, brickId)} at ${PROJECTS_PATH} (${entries.length}):`);
			for (const e of entries) {
				const size = e.bytes === undefined ? '' : ` ${e.bytes} B`;
				logger.info(`  ${e.kind === 'directory' ? '[dir] ' : '      '}${e.name}${size}`);
			}
			logger.show(true);
		})));

	services.add(vscode.commands.registerCommand('ev3-cockpit.showStorage', () =>
		withActiveFilesystem('reading storage', async (fs, brickId) => {
			const usage = await fs.files.storage();
			const used = usage.totalKb - usage.freeKb;
			void notify.info(
				`EVƎ Cockpit: ${nameOf(brickId)} — ${usage.freeKb} KB free of ${usage.totalKb} KB `
				+ `(${used} KB used).`);
		})));

	logger.info('Filesystem commands registered');

	// ── Connect a brick ─────────────────────────────────────────
	// A palette command for the same reason the filesystem ones exist: it needs a consumer
	// before the panel arrives (Phase 5), and it has to be exercisable by hand on real bricks.
	//
	// The whole interaction is picking a brick by name. One row per brick, whatever reaches
	// it, in the owner's order (D5); picking it signs it in over every channel it is available
	// on (KD1). Pairing is not something a user should have to think about, let alone do first
	// in Windows: a brick only an inquiry has heard is paired first, then connected.
	services.add(vscode.commands.registerCommand('ev3-cockpit.connectBrick', async () => {
		const picker = vscode.window.createQuickPick<BrickPickRow>();
		picker.title = 'EVƎ Cockpit: connect a brick';
		picker.placeholder = 'Pick a brick';
		// The list changes while someone is choosing from it; the highlight has to stay on the
		// brick they arrowed to, not on whatever row it used to be.
		picker.keepScrollPosition = true;

		const picked = await pickBrick(picker, aggregator, (brickId) => bricks.isSignedIn(brickId),
			btPresence && (() => btPresence.runInquiry()));
		if (!picked) { return; }

		await connectPickedBrick(picked, connectUi());
	}));
	/** What "Connect a Brick" needs, for the palette command and for the public API alike. */
	function connectUi(): Parameters<typeof connectPickedBrick>[1] {
		return {
			aggregator, bricks, log: logger, progress: notificationProgress,
			showInfo: (message) => { void notify.info(message); },
			showError: (message) => { void notify.error(message); },
		};
	}

	// Every pairing shows its progress, whoever started it: the person at the brick has to know
	// when to look at its display.
	services.add(bricks.onPairingStarted((event) => {
		void followPairing(event, {
			aggregator, progress: notificationProgress,
			showError: (message) => { void notify.error(message); },
		});
	}));

	// A pairing broken on one side, found over USB or TCP: what was found and done (step-4 R6).
	services.add(bricks.onOneSidedRepair((repair) => {
		const { message, warning } = describeRepair(repair, nameOf(repair.brickId));
		void (warning ? notify.warn(message) : notify.info(message));
	}));

	// ── Disconnect a brick ──────────────────────────────────────
	// Per brick, never per channel (KD7): every channel closes, and nothing reconnects until
	// the user connects it again.
	services.add(vscode.commands.registerCommand('ev3-cockpit.disconnectBrick', async () => {
		const signedIn = bricks.signedInBricks();
		if (signedIn.length === 0) {
			void notify.info('EVƎ Cockpit: no brick is connected.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			signedIn.map((brickId) => {
				const brick = aggregator.getBrick(brickId);
				return {
					label: brick?.name.value ?? brickId,
					description: brick ? describeChannels(brick) : '',
					brickId,
				};
			}),
			{ title: 'EVƎ Cockpit: disconnect a brick', placeHolder: 'Pick a brick to disconnect' },
		);
		if (!picked) { return; }
		await bricks.signOut(picked.brickId);
		logger.info(`Disconnected ${brickLabel(aggregator, picked.brickId)}`);
	}));

	// The picker, modal confirmation, progress and messages the forget and clear-list commands share.
	const brickCommandUi = (title: string, placeHolder: string): BrickCommandDeps<typeof bricks> => ({
		aggregator, bricks, log: logger,
		pick: (rows) => vscode.window.showQuickPick(rows, { title, placeHolder }),
		confirm: async (message, detail, action) => {
			logger.info(`Asked: ${message} ${detail}`);
			const confirmed = (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
			logger.info(`Answered: ${confirmed ? action : 'cancelled'}`);
			return confirmed;
		},
		progress: (progressTitle, task) => {
			notify.progressShown(progressTitle);
			return vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: false }, task);
		},
		showInfo: (message) => { void notify.info(message); },
		showResult: (message) => {
			void notify.info(message, 'Show details').then((choice) => {
				if (choice) { logger.show(true); }
			});
		},
		showError: (message) => { void notify.error(message); },
	});

	// ── Forget a brick ──────────────────────────────────────────
	// The whole brick (step-3 KD1): signed out, unpaired, dropped from the cockpit's memory,
	// and removed from the brick's own list when it is reachable. The message names what is
	// left and where; the details are in the output channel (KTD8).
	services.add(vscode.commands.registerCommand('ev3-cockpit.forgetBrick', async () => {
		await forgetBrick(brickCommandUi('EVƎ Cockpit: forget a brick', 'Pick a brick to forget'));
	}));

	// ── Clear a brick's Bluetooth list ──────────────────────────
	// Every entry on a reachable brick, whatever its name (step-3 KD7), so stale computers stop
	// blocking new pairings. The USB session stays open; this computer's Bluetooth pairing goes
	// only when its own entry did (KTD10).
	services.add(vscode.commands.registerCommand('ev3-cockpit.clearBrickBluetoothList', async () => {
		await clearBrickBluetoothList(
			brickCommandUi('EVƎ Cockpit: clear a brick\'s Bluetooth list', 'Pick a brick to clear'));
	}));

	logger.info('Connect, disconnect, forget and clear-list commands registered');

	// ── Public API (step-5 plan, U6) ────────────────────────────
	// What other extensions get: `vscode.extensions.getExtension(…).exports`. The access mode is
	// the user's setting and the cockpit enforces it (KD2); connecting is "Connect a Brick" with
	// its progress and messages (KD4).
	const readAccessMode = (): AccessMode =>
		vscode.workspace.getConfiguration('ev3-cockpit').get<AccessMode>('accessMode') === 'full' ? 'full' : 'safe';
	const api = services.add(createCockpitApi({
		bricks,
		aggregator,
		// Telemetry for consumers (step-6 U8): claims on the service, values from the read model.
		telemetry: {
			rows: () => runtime.telemetry.rows(),
			claim: (brickId, request, owner) => runtime.telemetry.claim(brickId, request, owner),
			release: (handle) => runtime.telemetry.release(handle),
			onClaimsEnded: (listener) => runtime.telemetry.onClaimsEnded(listener),
			snapshot: (brickId, rowIds) => runtime.telemetryView.snapshot(brickId, rowIds),
			onChange: (listener) => runtime.telemetryView.onChange(listener),
		},
		connect: async (brickId) => {
			await connectPickedBrick(brickId, connectUi());
			if (!bricks.isSignedIn(brickId)) {
				throw new NotConnectedError(`Brick ${brickId} could not be connected; the cockpit said why.`);
			}
		},
		accessMode: readAccessMode,
		onAccessModeChange: (listener) => vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('ev3-cockpit.accessMode')) { listener(readAccessMode()); }
		}),
		log: logger,
	}));
	logger.info(`Public API ${api.apiVersion} ready; access mode ${readAccessMode()}`);

	// Phase 5: the panel is wired here.
	return api;
}

export function deactivate(): void {
	// context.subscriptions handles disposal — nothing extra needed here.
}
