/**
 * Which brick a client means. A brick is named by its id or by its name; a name that fits several
 * bricks is refused with the candidates, since a fresh brick is called "EV3" and a classroom has many.
 *
 * Only the CLI may leave the brick out, and then only when exactly one brick is connected: a person
 * at a terminal with one brick should not have to type its name. An agent always names its brick.
 *
 * A just-started daemon has not heard every brick yet, so a name not found waits for the first
 * discovery round before it is refused.
 */

import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import type { ClientKind } from '../contract/models';

export interface ResolverBrick {
	readonly brickId: string;
	readonly name: string;
	readonly connected: boolean;
}

export interface ResolverDeps {
	bricks(): readonly ResolverBrick[];
	/** Settles once the daemon's first discovery round is over (or its wait ran out). */
	discoverySettled(): Promise<void>;
}

function match(bricks: readonly ResolverBrick[], ref: string): ResolverBrick[] {
	const byId = bricks.filter((b) => b.brickId === ref);
	if (byId.length > 0) { return byId; }
	const wanted = ref.trim().toLowerCase();
	return bricks.filter((b) => b.name.trim().toLowerCase() === wanted);
}

export async function resolveBrick(deps: ResolverDeps, ref: string | undefined, kind: ClientKind): Promise<string> {
	if (ref === undefined || ref === '') {
		if (kind !== 'cli') {
			throw new ContractError(WireErrorCode.InvalidRequest, 'Name the brick by its id or its name.');
		}
		const connected = deps.bricks().filter((b) => b.connected);
		if (connected.length === 1) { return connected[0].brickId; }
		if (connected.length === 0) {
			throw new ContractError(WireErrorCode.NotConnected, 'No brick is connected: connect one, or name the brick.');
		}
		throw new ContractError(WireErrorCode.BrickAmbiguous, 'Several bricks are connected: name the one you mean.', {
			candidates: connected.map((b) => ({ brickId: b.brickId, name: b.name })),
		});
	}
	let found = match(deps.bricks(), ref);
	if (found.length === 0) {
		await deps.discoverySettled();
		found = match(deps.bricks(), ref);
	}
	if (found.length === 1) { return found[0].brickId; }
	if (found.length === 0) {
		throw new ContractError(WireErrorCode.BrickNotFound, `No brick is called ${ref}: list the bricks for their names and ids.`,
			{ kind: 'BrickResolveError' });
	}
	throw new ContractError(WireErrorCode.BrickAmbiguous, `Several bricks are called ${ref}: name one by its id.`, {
		candidates: found.map((b) => ({ brickId: b.brickId, name: b.name })),
		kind: 'BrickResolveError',
	});
}
