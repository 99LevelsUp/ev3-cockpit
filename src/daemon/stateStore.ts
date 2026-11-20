/**
 * Small JSON files in the daemon's state folder: what one daemon leaves for the next. Every write
 * goes to a temporary file first and is renamed into place, so a crash never leaves half a file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrickRef } from '../core/contracts';
import type { LedgerStore, TransferDebt } from '../core/fs/transferLedger';

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

/** The bricks' unpaid transfer debts, kept in one file across daemons. */
export function fileLedgerStore(file: string): LedgerStore {
	const all = readJson<Record<string, TransferDebt[]>>(file, {});
	return {
		load: (brickKey: BrickRef) => all[brickKey] ?? [],
		save: (brickKey: BrickRef, debts: readonly TransferDebt[]) => {
			if (debts.length === 0) { delete all[brickKey]; } else { all[brickKey] = [...debts]; }
			writeJson(file, all);
		},
	};
}
