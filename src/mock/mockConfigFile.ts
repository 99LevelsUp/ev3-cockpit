/**
 * The simulated bricks a workspace defines for itself (REQUIREMENTS §13, IMPLEMENTATION_PLAN 1.6.10).
 *
 * A JSON file in the workspace, read when the simulated bricks are on, at activation as the
 * `ev3-cockpit.mockBricks` setting is: a changed file takes effect after reloading the window. No
 * file keeps the built-in set; a file that cannot be read, parsed or validated keeps it too, and
 * says why, so a typo never leaves a developer without bricks and without a reason.
 */

import * as path from 'node:path';
import { MockConfig, validateMockConfig } from './mockConfig';

/** Where in a workspace folder the file lives. */
export const MOCK_CONFIG_FILE = path.join('.vscode', 'ev3-cockpit-mock.json');

export type MockConfigFileResult =
	/** No file: the built-in set. */
	| { readonly kind: 'absent' }
	| { readonly kind: 'loaded'; readonly config: MockConfig; readonly file: string }
	| { readonly kind: 'invalid'; readonly file: string; readonly reason: string };

/** Reads a file as text, or throws; an `ENOENT` code means it is not there. */
export type ReadText = (file: string) => string;

/** Loads the first workspace folder's file that exists; the folders in the workspace's order. */
export function loadMockConfigFile(folders: readonly string[], readText: ReadText): MockConfigFileResult {
	for (const folder of folders) {
		const file = path.join(folder, MOCK_CONFIG_FILE);
		let text: string;
		try {
			text = readText(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { continue; }
			return { kind: 'invalid', file, reason: `cannot be read: ${(error as Error)?.message ?? String(error)}` };
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			return { kind: 'invalid', file, reason: `is not valid JSON: ${(error as Error).message}` };
		}
		try {
			return { kind: 'loaded', config: validateMockConfig(raw), file };
		} catch (error) {
			return { kind: 'invalid', file, reason: (error as Error).message };
		}
	}
	return { kind: 'absent' };
}
