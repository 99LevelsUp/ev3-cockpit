import * as vscode from 'vscode';
import { DisposableStore } from './events';
import { BtPairingEvent } from './transports/btPairingHelper';
import { createBrickFilesystem, BrickFilesystem } from './fs/brickFilesystem';
import { createRuntime } from './runtime/createRuntime';
import { brickLabel, transportLabel } from './runtime/brickLabels';
import { BrickUnreachableError, ConnectionAbandonedError, TimeoutError } from './errors/CockpitError';
import { BrickEntry, BrickId, ChannelState, Transport, brickKeyId } from './contracts';
import { compareBricks } from './ui/brickOrder';

/** Where the brick keeps user projects. The one path worth a default. */
const PROJECTS_PATH = '/home/root/lms2012/prjs';

/** How a channel reads in a list row. The panel (Phase 5) shows the same as coloured icons. */
function describeChannels(brick: BrickEntry): string {
	return brick.channels.map((channel) => {
		const transport = channel.transport.toUpperCase();
		switch (channel.state) {
		case ChannelState.Connected: return `${transport} connected`;
		case ChannelState.Available: return `${transport} available`;
		// A paired Bluetooth brick that stopped answering is "not heard": it may be off, or
		// out of range; Windows lists it either way.
		default: return channel.transport === Transport.BT ? `${transport} not heard` : `${transport} lost`;
		}
	}).join(' · ');
}

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
		interface BrickItem extends vscode.QuickPickItem { brickId: BrickId }

		const picker = vscode.window.createQuickPick<BrickItem>();
		picker.title = 'EVƎ Cockpit: connect a brick';
		picker.placeholder = 'Pick a brick';
		// The list changes while someone is choosing from it; the highlight has to stay on the
		// brick they arrowed to, not on whatever row it used to be.
		picker.keepScrollPosition = true;

		const render = (): void => {
			const focused = picker.activeItems[0]?.brickId;
			picker.items = [...aggregator.getDiscoveryList()]
				.sort(compareBricks)
				.map((brick) => ({
					label: `${bricks.isSignedIn(brick.brickId) ? '$(check) ' : ''}${brick.name.value}`,
					description: `${brick.name.confirmed ? '' : '(name unconfirmed) '}${describeChannels(brick)}`
						+ `${brick.channels.some((c) => c.transport === Transport.BT) && !brick.paired ? ' · new' : ''}`,
					detail: brick.brickId,
					brickId: brick.brickId,
				}));
			const keep = picker.items.find((item) => item.brickId === focused);
			if (keep) { picker.activeItems = [keep]; }
		};
		const listening = aggregator.onListChanged(render);
		render();

		// Look for new Bluetooth bricks now rather than at the next background round, so one
		// switched on a moment ago shows up while the list is open.
		if (btPresence) {
			picker.busy = true;
			void btPresence.runInquiry().finally(() => { picker.busy = false; });
		}

		const picked = await new Promise<BrickId | undefined>((resolve) => {
			picker.onDidAccept(() => resolve(picker.selectedItems[0]?.brickId));
			picker.onDidHide(() => resolve(undefined));
			picker.show();
		});
		listening.dispose();
		picker.hide();
		picker.dispose();
		if (!picked) { return; }

		const brick = aggregator.getBrick(picked);
		const label = brick?.name.value ?? picked;
		if (bricks.isSignedIn(picked)) {
			bricks.setActiveBrick(picked);
			void vscode.window.showInformationMessage(`EVƎ Cockpit: ${label} is the active brick.`);
			return;
		}

		// A brick only an inquiry has heard has nothing to connect over until it is paired.
		const bt = brick?.channels.find((c) => c.transport === Transport.BT);
		const onlyNewBluetooth = brick && !brick.paired && bt && brick.channels.length === 1;
		if (onlyNewBluetooth && btDiscovery) {
			const mac = brickKeyId(bt.brickKey) ?? '';
			const paired = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `EVƎ Cockpit: pairing ${label}`, cancellable: false },
				async (progress) => {
					const result = await btDiscovery.pair(mac, (event: BtPairingEvent) => {
						logger.debug(`Pairing ${brickLabel(aggregator, picked)}: ${JSON.stringify(event)}`);
						// Prompt on `found`, not on `pairingRequested`: by the time the brick is
						// asking, whoever is meant to press it has seconds. On `found` they have
						// the whole ceremony.
						if (event.type === 'found' && event.alreadyPaired === false) {
							progress.report({ message: 'Confirm on the brick\'s display, then accept PIN 1234.' });
						}
					});
					if (!result.ok) {
						logger.warn(`Pairing ${brickLabel(aggregator, picked)} failed: ${result.reason ?? 'no reason given'}`);
						void vscode.window.showErrorMessage(
							`EVƎ Cockpit: could not pair ${label} — ${result.reason ?? 'no reason given.'}`);
					}
					return result.ok;
				});
			if (!paired) { return; }
		}

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `EVƎ Cockpit: connecting to ${label}`, cancellable: false },
			async () => {
				// A freshly paired brick is not in the discovery list as paired yet — the OS knows
				// the pairing immediately, the next scheduled scan is up to a poll interval away.
				await scheduler.scanOnce().catch(() => { /* connect is what matters here */ });
				try {
					await bricks.signIn(picked);
					const route = bricks.routeOf(picked);
					logger.info(`Connected to ${brickLabel(aggregator, picked)} over ${route ? transportLabel(route) : 'no channel'}`);
					void vscode.window.showInformationMessage(`EVƎ Cockpit: connected to ${label}.`);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					// The user disconnected it before it was through; nothing failed.
					if (err instanceof ConnectionAbandonedError) {
						logger.info(`Connecting to ${brickLabel(aggregator, picked)} stopped: it was disconnected meanwhile`);
						return;
					}
					logger.error(`Connecting to ${brickLabel(aggregator, picked)} failed:`, err);
					// The cause of a brick that did not answer is the Winsock code, which says
					// nothing to the person holding the brick; it stays in the log.
					const unanswered = err instanceof BrickUnreachableError || err instanceof TimeoutError;
					void vscode.window.showErrorMessage(unanswered
						? `EVƎ Cockpit: ${label} did not answer. Check that it is switched on and in range, then try again.`
						: `EVƎ Cockpit: could not connect to ${label} — ${err.message}`);
				}
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
