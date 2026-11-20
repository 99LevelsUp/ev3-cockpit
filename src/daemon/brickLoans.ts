/**
 * The user's daemon lending bricks to a development daemon (KTD17).
 *
 * A development daemon reaches the user's daemon only over a `peer` connection, which carries the
 * held bricks for it to show as blocked and the requests to borrow one brick or all of them.
 *
 * - One brick: every client holding it is asked (`brickLoan`); only when all say yes is it signed
 *   out, its devices go on the gate's list so nothing here opens them, and it is lent. A brick held
 *   through `ev3 connect`, or remembered for the long-lived clients, has a holder nobody can ask, so
 *   the loan is refused with the command that releases it.
 * - All bricks: the same consent from every holding client, then the daemon enters Lent and opens
 *   nothing, the radio included.
 * - Return: when the peer connection closes, every loan it took comes back and the bricks that had
 *   holders are connected again.
 */

import type { LoanResult } from '../contract/methods';
import type { BrickStatus } from '../contract/models';
import { BrickId, Transport } from '../core/contracts';
import type { Runtime } from '../core/runtime/createRuntime';
import type { LoanGate, UsbLocation } from '../core/runtime/deviceGate';
import { UsbTransportProvider } from '../core/transports';
import type { Holder } from './holders';
import type { DaemonClient } from './main';
import { ask } from './questions';
import type { Lifecycle } from './stateMachine';
import type { Surface } from './surface';

interface Loan {
	readonly peerId: string;
	readonly holders: readonly Holder[];
	readonly usb: readonly UsbLocation[];
}

export interface BrickLoansDeps {
	readonly surface: Surface;
	readonly runtime: Runtime;
	readonly lifecycle: Lifecycle;
	readonly gate: LoanGate;
	readonly clients: ReadonlyMap<string, DaemonClient>;
	readonly log: { info(message: string, client?: string): void; warn(message: string): void };
}

export interface BrickLoans {
	/** Serves a peer connection: held bricks and loans; its loans come back when it closes. */
	attachPeer(peer: DaemonClient): void;
	/** True while anything is lent. */
	readonly anyLent: boolean;
}

const LENT_TO = 'lent to a development daemon';

export function createBrickLoans(deps: BrickLoansDeps): BrickLoans {
	const { surface, runtime, lifecycle, gate, clients, log } = deps;
	const loans = new Map<string, Loan>();
	let all: { readonly peerId: string; readonly holders: Readonly<Record<string, readonly Holder[]>> } | undefined;

	const nameOf = (brickId: string): string => runtime.aggregator.getBrick(brickId as BrickId)?.name.value ?? brickId;
	const usbOf = (brickId: string): UsbLocation[] => {
		const usb = runtime.registry.all().find((p): p is UsbTransportProvider => p instanceof UsbTransportProvider);
		const entry = runtime.aggregator.getBrick(brickId as BrickId);
		if (!usb || !entry) { return []; }
		return entry.channels
			.filter((c) => c.transport === Transport.USB)
			.map((c) => usb.locationOf(c.brickKey))
			.filter((l): l is UsbLocation => l !== undefined);
	};
	const announce = (brickIds: readonly string[], lent: boolean, everything: boolean): void => {
		lifecycle.setLentBricks(loans.size);
		surface.broadcast('daemon/lent', { all: everything, brickIds, lent });
		surface.refreshBricks();
	};

	/** Holders nobody can ask refuse the loan; the rest are asked. Undefined when every one said yes. */
	const consent = async (peer: DaemonClient, bricks: Readonly<Record<string, readonly Holder[]>>): Promise<LoanResult | undefined> => {
		for (const [brickId, set] of Object.entries(bricks)) {
			const name = nameOf(brickId);
			if (set.some((h) => h.kind === 'hold')) {
				return { lent: false, refusedBy: 'ev3 connect', reason: `${name} is held through ev3 connect; run ev3 disconnect ${name} first.` };
			}
			if (set.some((h) => h.kind === 'remembered')) {
				return { lent: false, refusedBy: 'remembered bricks', reason: `${name} is kept connected for the long-lived clients; run ev3 disconnect ${name} first.` };
			}
		}
		const askedBy = new Map<string, string[]>();
		for (const [brickId, set] of Object.entries(bricks)) {
			for (const h of set) {
				if (h.kind === 'client' && clients.has(h.clientId)) { askedBy.set(h.clientId, [...(askedBy.get(h.clientId) ?? []), brickId]); }
			}
		}
		for (const [clientId, brickIds] of askedBy) {
			const client = clients.get(clientId);
			if (!client) { continue; }
			const names = brickIds.map(nameOf);
			const answer = await ask(client.endpoint, {
				kind: 'brickLoan',
				...(brickIds.length === 1 ? { brickId: brickIds[0] } : {}),
				text: `A development cockpit (${peer.identity.name}) asks to borrow ${names.join(', ')}. Lend ${brickIds.length === 1 ? 'it' : 'them'}? ${brickIds.length === 1 ? 'It comes' : 'They come'} back when that cockpit ends.`,
				details: names,
			});
			if (answer !== 'yes') {
				log.info(`Loan of ${names.join(', ')} to ${peer.identity.name} refused (${answer})`, client.identity.name);
				return { lent: false, refusedBy: client.identity.name, reason: answer === 'no' ? 'said no' : 'could not be asked' };
			}
		}
		return undefined;
	};

	/** Bricks a loan is being asked for now, and whether a loan of everything is. */
	const pending = new Set<string>();
	let pendingAll = false;
	const sameHolders = (a: Readonly<Record<string, readonly Holder[]>>, b: Readonly<Record<string, readonly Holder[]>>): boolean =>
		JSON.stringify(a) === JSON.stringify(b);
	/**
	 * What changed while the holders were being asked, if anything: the peer went, the daemon stopped
	 * serving, something else was lent, or someone took or dropped a hold nobody asked about.
	 */
	const changedWhileAsking = (peer: DaemonClient, asked: Readonly<Record<string, readonly Holder[]>>): string | undefined => {
		if (peer.endpoint.closed || !clients.has(peer.id)) { return 'The development daemon went while its holders were asked.'; }
		if (lifecycle.state !== 'serving' || gate.everything) { return 'The user\'s daemon has nothing to lend now.'; }
		const now = surface.holders.snapshot();
		const current = Object.fromEntries(Object.keys(asked).map((id) => [id, now[id] ?? []]));
		if (!sameHolders(current, asked)) { return 'Who holds the brick changed while its holders were asked; ask again.'; }
		return undefined;
	};

	const borrowBrick = async (peer: DaemonClient, brickId: string): Promise<LoanResult> => {
		if (lifecycle.state !== 'serving' || gate.everything) { return { lent: false, reason: 'The user\'s daemon has nothing to lend now.' }; }
		if (loans.has(brickId)) { return { lent: false, reason: `${nameOf(brickId)} is lent already.` }; }
		if (pending.has(brickId) || pendingAll) { return { lent: false, reason: `A loan of ${nameOf(brickId)} is being asked for already.` }; }
		if (!runtime.aggregator.getBrick(brickId as BrickId)) { return { lent: false, reason: `The user's daemon does not see ${brickId}.` }; }
		pending.add(brickId);
		try {
			const held = surface.holders.snapshot()[brickId] ?? [];
			const refusal = await consent(peer, { [brickId]: held });
			if (refusal) { return refusal; }
			const changed = changedWhileAsking(peer, { [brickId]: held });
			if (changed) { return { lent: false, reason: changed }; }
			// Lent before the sign-out is awaited: from here no client of this daemon can take the brick,
			// and a peer that leaves now finds its loan and gives it back.
			const usb = usbOf(brickId);
			surface.holders.forget(brickId);
			gate.add(brickId, usb);
			surface.blocked.set(brickId, { by: LENT_TO, holder: peer.identity.name });
			loans.set(brickId, { peerId: peer.id, holders: held, usb });
			await runtime.bricks.signOut(brickId as BrickId);
			log.info(`Lent ${nameOf(brickId)} to ${peer.identity.name}`);
			announce([brickId], true, false);
			return { lent: true, ...(usb.length > 0 ? { usb } : {}) };
		} finally {
			pending.delete(brickId);
		}
	};

	const borrowAll = async (peer: DaemonClient): Promise<LoanResult> => {
		if (lifecycle.state !== 'serving' || gate.everything || loans.size > 0 || pending.size > 0 || pendingAll) {
			return { lent: false, reason: 'The user\'s daemon has bricks lent already, or a loan is being asked for; end those first.' };
		}
		pendingAll = true;
		try {
			const snapshot = surface.holders.snapshot();
			const refusal = await consent(peer, snapshot);
			if (refusal) { return refusal; }
			const changed = changedWhileAsking(peer, snapshot) ?? (sameHolders(surface.holders.snapshot(), snapshot) ? undefined : 'Who holds the bricks changed while their holders were asked; ask again.');
			if (changed) { return { lent: false, reason: changed }; }
			if (loans.size > 0) { return { lent: false, reason: 'A brick was lent while the holders were asked; end that loan first.' }; }
			// Everything is lent before the sign-outs are awaited, for the same reason as one brick.
			gate.setAll(true);
			lifecycle.lend();
			all = { peerId: peer.id, holders: snapshot };
			const listed = runtime.aggregator.getDiscoveryList().map((b) => b.brickId as string);
			for (const brickId of listed) { surface.blocked.set(brickId, { by: LENT_TO, holder: peer.identity.name }); }
			for (const brickId of Object.keys(snapshot)) { surface.holders.forget(brickId); }
			for (const brickId of Object.keys(snapshot)) {
				await runtime.bricks.signOut(brickId as BrickId).catch((error: unknown) => log.warn(`Releasing ${brickId} for the loan failed: ${String(error)}`));
			}
			log.info(`Lent every brick to ${peer.identity.name}`);
			announce(listed, true, true);
			return { lent: true };
		} finally {
			pendingAll = false;
		}
	};

	/** Holders whose clients are still here, and holds that belong to nobody's connection. */
	const stillHere = (set: readonly Holder[]): Holder[] => set.filter((h) => h.kind !== 'client' || clients.has(h.clientId));

	const giveBack = (peerId: string): void => {
		const back: string[] = [];
		const reconnect: string[] = [];
		for (const [brickId, loan] of [...loans]) {
			if (loan.peerId !== peerId) { continue; }
			loans.delete(brickId);
			gate.remove(brickId, loan.usb);
			surface.blocked.delete(brickId);
			const kept = stillHere(loan.holders);
			if (kept.length > 0) {
				surface.holders.restore({ [brickId]: kept });
				reconnect.push(brickId);
			}
			back.push(brickId);
		}
		let everything = false;
		if (all && all.peerId === peerId) {
			everything = true;
			const snapshot = all.holders;
			all = undefined;
			gate.setAll(false);
			surface.blocked.clear();
			lifecycle.reclaim();
			for (const [brickId, set] of Object.entries(snapshot)) {
				const kept = stillHere(set);
				if (kept.length > 0) {
					surface.holders.restore({ [brickId]: kept });
					reconnect.push(brickId);
				}
			}
			void runtime.scheduler.scanOnce().catch(() => undefined);
		}
		if (back.length === 0 && !everything) { return; }
		log.info(`Loans to a development daemon ended: ${everything ? 'everything' : back.map(nameOf).join(', ')} back`);
		announce(back, false, everything);
		if (reconnect.length > 0) { surface.reconnectHeld(reconnect); }
	};

	return {
		get anyLent() { return loans.size > 0 || all !== undefined; },
		attachPeer(peer) {
			const { endpoint } = peer;
			endpoint.onRequest('peer/heldBricks', (): BrickStatus[] => surface.brickStatus());
			endpoint.onRequest('peer/borrowBrick', (params) => {
				const brickId = (params as { brickId?: unknown } | undefined)?.brickId;
				if (typeof brickId !== 'string' || brickId === '') { return { lent: false, reason: 'No brick named.' }; }
				return borrowBrick(peer, brickId);
			});
			endpoint.onRequest('peer/borrowAll', () => borrowAll(peer));
			endpoint.onClose(() => giveBack(peer.id));
			log.info(`A development daemon connected: ${peer.identity.name}`);
		},
	};
}
