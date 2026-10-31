import * as vscode from 'vscode';
import { DisposableStore } from './events';
import { createBrickFilesystem, BrickFilesystem } from './fs/brickFilesystem';
import { createRuntime } from './runtime/createRuntime';
import { brickLabel } from './runtime/brickLabels';
import { BrickId } from './contracts';
import { BrickPickRow, describeChannels } from './ui/brickPickRows';
import { connectPickedBrick, pickBrick } from './ui/connectBrick';

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

export function activate(context: vscode.ExtensionContext): void {
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
	}));
	const { bricks, aggregator, scheduler, btDiscovery, btPresence } = runtime;
	/** What a user calls a brick: its name, or its id until it has one. */
	const nameOf = (brickId: BrickId): string => aggregator.getBrick(brickId)?.name.value ?? brickId;

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
			void vscode.window.showWarningMessage(
				`EVƎ Cockpit: no active brick, so ${what} has nothing to talk to.`);
			return;
		}
		try {
			await body(createBrickFilesystem(bricks, brickId), brickId);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`${what} failed on ${brickLabel(aggregator, brickId)}:`, err);
			void vscode.window.showErrorMessage(`EVƎ Cockpit: ${what} on ${nameOf(brickId)} failed — ${err.message}`);
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
			void vscode.window.showInformationMessage(
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

		await connectPickedBrick(picked, {
			aggregator, bricks, scheduler, log: logger,
			pair: btDiscovery?.pair,
			progress: (title, task) => vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
				(progress) => task((message) => progress.report({ message }))),
			showInfo: (message) => { void vscode.window.showInformationMessage(message); },
			showError: (message) => { void vscode.window.showErrorMessage(message); },
		});
	}));

	// ── Disconnect a brick ──────────────────────────────────────
	// Per brick, never per channel (KD7): every channel closes, and nothing reconnects until
	// the user connects it again.
	services.add(vscode.commands.registerCommand('ev3-cockpit.disconnectBrick', async () => {
		const signedIn = bricks.signedInBricks();
		if (signedIn.length === 0) {
			void vscode.window.showInformationMessage('EVƎ Cockpit: no brick is connected.');
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

	logger.info('Connect and disconnect commands registered');

	// Phase 3+: telemetry runtime, public API, UI panel wired here.
}

export function deactivate(): void {
	// context.subscriptions handles disposal — nothing extra needed here.
}
