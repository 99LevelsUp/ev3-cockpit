import { Transport } from './enums';
import { InvalidBrickKeyError } from '../errors/CockpitError';

/** Stable identifier for a brick within a given transport. Never based on displayName. */
export type BrickKey = string & { readonly __brand: 'BrickKey' };

/** Separator between the transport prefix and the transport-local identifier. */
const SEPARATOR = ':';

/**
 * Build a brick key from a transport and a transport-local identifier.
 *
 * No transport value contains the separator, so an identifier that does (a
 * Bluetooth MAC) stays unambiguous: everything after the *first* separator belongs
 * to the identifier.
 *
 * Case is preserved. Favorites and auto-connect are bound to this string, so a
 * brick that reports its identifier in two different cases would split in two --
 * but only the transport knows whether its identifier is case-insensitive. Hex
 * serials and MACs are (USB and BT upper-case theirs before calling); a mock id or
 * a TCP hostname is not, and folding those here would corrupt them.
 *
 * @throws if the identifier is empty or blank -- `usb:` identifies nothing.
 */
export function makeBrickKey(transport: Transport, id: string): BrickKey {
	const trimmed = id.trim();
	if (trimmed.length === 0) {
		throw new InvalidBrickKeyError(
			`Cannot build a brick key for ${transport} from an empty identifier.`
		);
	}
	return `${transport}${SEPARATOR}${trimmed}` as BrickKey;
}

/** The transport half of a brick key, or undefined if the key is malformed. */
export function brickKeyTransport(key: BrickKey | string): Transport | undefined {
	const index = key.indexOf(SEPARATOR);
	if (index <= 0) { return undefined; }
	const prefix = key.slice(0, index);
	return (Object.values(Transport) as string[]).includes(prefix)
		? (prefix as Transport)
		: undefined;
}

/**
 * The identifier half of a brick key, or undefined if the key is malformed.
 *
 * Splits on the *first* separator only, so a Bluetooth MAC keeps its colons.
 */
export function brickKeyId(key: BrickKey | string): string | undefined {
	const index = key.indexOf(SEPARATOR);
	if (index <= 0 || index === key.length - 1) { return undefined; }
	return key.slice(index + 1);
}
