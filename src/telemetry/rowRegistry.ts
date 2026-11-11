/**
 * The rows a brick offers (IMPLEMENTATION_PLAN 3.1.6; step-6 plan U2; DESIGN §9.3).
 *
 * Registering a row validates it and refuses what will not fit, rather than documenting the
 * limits. Whoever adds a row — the cockpit or, later, another extension — learns at
 * `register` that the row cannot be placed, not from a corrupt frame at runtime. The bound is
 * the tightest link a brick can be on, the 64-byte HID fallback: 59 bytes of declared globals
 * and 57 of bytecode. A row that fits there fits everywhere.
 *
 * Mode conflicts are not a registration matter: two rows reading two modes of one sensor are
 * alternatives a subscriber chooses between, and the assembler keeps them out of one frame.
 */

import { bytecodeBudgetFor, FrameAssemblyError, validateRow } from './frameAssembler';
import { allEv3Rows, sensorValueRow, SENSOR_PORT_NAMES } from './ev3Rows';
import type { TelemetryRow, TelemetryTier } from './telemetryRow';

/** One row as a consumer sees it: plain data. */
export interface RowDescriptor {
	readonly id: string;
	readonly tier: TelemetryTier;
	readonly unit?: string;
	readonly port?: string;
}

/** The tightest link: rows are validated against it. */
const HID_LIMITS = { maxPacketBytes: 64 };

/** The first slot whose global reference takes two bytes (GV1); a row's widest bytecode. */
const WIDEST_SLOT = 32;

/** Dot-separated segments, the first starting with a lowercase letter: `ports.sensor.1.value`. */
const ROW_ID = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

export class RowRegistry {
	private readonly rows = new Map<string, TelemetryRow>();
	/** Rows that can be read in another mode: the row in a given mode, under the same id (D6). */
	private readonly variants = new Map<string, (mode: number) => TelemetryRow>();

	/** Lets a registered row be read in other modes; the row a mode gives keeps the id. */
	registerModes(id: string, inMode: (mode: number) => TelemetryRow): void {
		if (!this.rows.has(id)) { throw new FrameAssemblyError(`Row '${id}' is not registered.`); }
		this.variants.set(id, inMode);
	}

	/** The row in the given mode, or undefined when the row has no modes. */
	inMode(id: string, mode: number): TelemetryRow | undefined {
		return this.variants.get(id)?.(mode);
	}

	/** The port whose mode a row selects, for rows that can be read in other modes. */
	modePorts(): Set<string> {
		const ports = new Set<string>();
		for (const id of this.variants.keys()) {
			const port = this.rows.get(id)?.port;
			if (port !== undefined) { ports.add(port); }
		}
		return ports;
	}

	/** Adds a row, or throws `FrameAssemblyError` and adds nothing. */
	register(row: TelemetryRow): void {
		if (typeof row.id !== 'string' || !ROW_ID.test(row.id)) {
			throw new FrameAssemblyError(`Row id '${String(row.id)}' is not a namespaced path like 'ports.sensor.1.value'.`);
		}
		if (this.rows.has(row.id)) {
			throw new FrameAssemblyError(`Row '${row.id}' is already registered.`);
		}
		if (row.lifetime.kind === 'repeating'
			&& !(Number.isInteger(row.lifetime.divider) && row.lifetime.divider >= 1)) {
			throw new FrameAssemblyError(`Row '${row.id}' repeats on divider ${row.lifetime.divider}; a divider is a whole number of ticks, 1 or more.`);
		}
		validateRow(row, HID_LIMITS);
		const bytecode = row.emit(WIDEST_SLOT).length;
		const budget = bytecodeBudgetFor(HID_LIMITS);
		if (bytecode > budget) {
			throw new FrameAssemblyError(`Row '${row.id}' needs ${bytecode} bytes of bytecode; ${budget} go out on the HID fallback.`);
		}
		this.rows.set(row.id, row);
	}

	get(id: string): TelemetryRow | undefined {
		return this.rows.get(id);
	}

	/** Every registered row, in registration order, which is truncation priority (`allEv3Rows`). */
	all(): TelemetryRow[] {
		return [...this.rows.values()];
	}

	/** Every registered row as plain data. */
	list(): RowDescriptor[] {
		return this.all().map((row) => ({
			id: row.id,
			tier: row.tier,
			...(row.unit !== undefined ? { unit: row.unit } : {}),
			...(row.port !== undefined ? { port: row.port } : {}),
		}));
	}
}

/** A registry holding every row an EV3 brick offers. */
export function createEv3RowRegistry(): RowRegistry {
	const registry = new RowRegistry();
	for (const row of allEv3Rows()) { registry.register(row); }
	// A sensor is read in the mode its claim asks for (D6); motors' tacho has no mode.
	SENSOR_PORT_NAMES.forEach((port, index) => {
		registry.registerModes(`ports.sensor.${port}.value`, (mode) => sensorValueRow(index, mode));
	});
	return registry;
}
