/**
 * URI parsing and construction helpers for ev3:// URIs.
 *
 * @packageDocumentation
 */

import { canonicalizeEv3Path } from './pathPolicy';

export interface ParsedEv3UriParts {
	brickId: string;
	remotePath: string;
}

export function parseEv3UriParts(authority: string, path: string): ParsedEv3UriParts {
	const brickId = authority.trim();
	if (!brickId) {
		throw new Error('EVƎ URI must include brick authority (ev3://<brickId>/...).');
	}

	const remotePath = canonicalizeEv3Path(path);
	return {
		brickId,
		remotePath
	};
}
