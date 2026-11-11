/**
 * What is plugged into a port, by name (IMPLEMENTATION_PLAN 3.1.4, 3.2.5; step-6 plan U2).
 *
 * The firmware reports a type code (`opINPUT_DEVICE`/`GET_TYPEMODE`). The codes are the ones in
 * `bytecodes.h` of firmware 1.09d (`TYPE_*`). The names are the ones the mock configuration
 * already uses, so the mock and the brick speak one vocabulary.
 *
 * A closed vocabulary cannot name a device nobody has heard of. So a code outside it is
 * `unrecognised`, never a guess, and the raw code always travels beside the name (DESIGN §9.3).
 */

export type PeripheralType =
	| 'nxt-touch-sensor' | 'nxt-light-sensor' | 'nxt-sound-sensor' | 'nxt-color-sensor'
	| 'nxt-ultrasonic-sensor' | 'nxt-temperature-sensor'
	| 'large-motor' | 'medium-motor' | 'new-tacho-motor'
	| 'touch-sensor' | 'color-sensor' | 'ultrasonic-sensor' | 'gyro-sensor' | 'infrared-sensor'
	| 'energy-meter' | 'nxt-test-sensor' | 'nxt-iic-sensor'
	/** `TYPE_IIC_UNKNOWN` 100: an IIC device the firmware's type list does not name; it stays so (`c_input.c` 3029–3047). */
	| 'iic-unlisted'
	| 'third-party'
	/** `TYPE_TERMINAL`: the port has a console on it, not a peripheral. */
	| 'terminal'
	/** `TYPE_UNKNOWN`: something is plugged in and still identifying; reading it blocks. */
	| 'identifying'
	/** `TYPE_NONE`: the port is empty. */
	| 'none'
	/** `TYPE_ERROR`: something is plugged in and its type is invalid. */
	| 'error'
	/** A code this vocabulary does not know. */
	| 'unrecognised';

/** `TYPE_*` codes, `bytecodes.h`, firmware 1.09d. */
const BY_CODE: ReadonlyMap<number, PeripheralType> = new Map<number, PeripheralType>([
	[1, 'nxt-touch-sensor'],
	[2, 'nxt-light-sensor'],
	[3, 'nxt-sound-sensor'],
	[4, 'nxt-color-sensor'],
	[5, 'nxt-ultrasonic-sensor'],
	[6, 'nxt-temperature-sensor'],
	[7, 'large-motor'],        // TYPE_TACHO, "EV3/NXT tacho motor"
	[8, 'medium-motor'],       // TYPE_MINITACHO
	[9, 'new-tacho-motor'],    // TYPE_NEWTACHO
	[16, 'touch-sensor'],
	[29, 'color-sensor'],
	[30, 'ultrasonic-sensor'],
	[32, 'gyro-sensor'],
	[33, 'infrared-sensor'],
	[99, 'energy-meter'],
	[100, 'iic-unlisted'],     // TYPE_IIC_UNKNOWN: not in the firmware's IIC list, not "still identifying"
	[101, 'nxt-test-sensor'],
	[123, 'nxt-iic-sensor'],
	[124, 'terminal'],
	[125, 'identifying'],
	[126, 'none'],
	[127, 'error'],
]);

const THIRD_PARTY_START = 50;
const THIRD_PARTY_END = 98;

const BY_NAME: ReadonlyMap<PeripheralType, number> = new Map(
	[...BY_CODE].map(([code, name]) => [name, code] as const),
);

/** The name for a type code the firmware reported. */
export function peripheralTypeOf(code: number): PeripheralType {
	const known = BY_CODE.get(code);
	if (known) { return known; }
	if (code >= THIRD_PARTY_START && code <= THIRD_PARTY_END) { return 'third-party'; }
	return 'unrecognised';
}

/** The type code for a name; undefined for a name that stands for a range or for no code. */
export function typeCodeOf(name: PeripheralType): number | undefined {
	return BY_NAME.get(name);
}
