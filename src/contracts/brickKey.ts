import { Transport } from './enums';

/** Stable identifier for a brick within a given transport. Never based on displayName. */
export type BrickKey = string & { readonly __brand: 'BrickKey' };

export function makeBrickKey(transport: Transport, id: string): BrickKey {
	return `${transport}:${id}` as BrickKey;
}
