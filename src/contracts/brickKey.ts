import { Transport } from './enums';
import { InvalidBrickKeyError } from '../errors/CockpitError';

/** Stable identifier for a brick within a given transport. Never based on displayName. */
export type BrickKey = string & { readonly __brand: 'BrickKey' };

/**
 * Identifies a brick itself, whichever channel it is reached over.
 *
 * Twelve upper-case hex digits for a real brick: the EV3 uses its Bluetooth address as its
 * USB serial and announces the same digits in its TCP beacon, so `usb:00165342D9F2`,
 * `bt:00:16:53:42:D9:F2` and `tcp:00165342d9f2` are one brick. A key with no hardware
 * identity -- a mock brick, a TCP brick known only by its IP -- is its own id, a brick with
 * exactly one channel.
 *
 * A separate brand from {@link BrickKey} on purpose: a key names one channel to one brick,
 * and passing one where the other is expected is a bug the compiler should catch.
 */
export type BrickId = string & { readonly __brand: 'BrickId' };

/**
 * Either a brick or one channel to it — what a sender of commands accepts.
 *
 * The session manager is addressed by channel, the brick layer by brick; the services above
 * them (filesystem, telemetry) send through whichever they were handed and need neither more.
 */
export type BrickRef = BrickKey | BrickId;

const HARDWARE_ID = /^[0-9A-F]{12}$/;

/**
 * The brick a channel key belongs to.
 *
 * Only an identifier that is exactly twelve hex digits once separators are dropped counts as
 * hardware identity. Anything shorter or longer keeps the whole key, so a malformed address
 * can never be shortened into another brick's id.
 */
export function brickIdOf(key: BrickKey): BrickId {
	const digits = (brickKeyId(key) ?? '').replace(/[:-]/g, '').toUpperCase();
	return (HARDWARE_ID.test(digits) ? digits : key) as BrickId;
}

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
