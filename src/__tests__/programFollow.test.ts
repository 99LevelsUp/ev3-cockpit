/**
 * Following a brick's program through its telemetry row (step-6 plan U9).
 *
 * The program service no longer polls: it claims `program.user.running` on its brick and hears the
 * read model's changes. A stale or dropped value says nothing about the program, so it tells
 * nothing. The state is told after the read model's dispatch, never inside it: the delivery is the
 * read model's only listener that reacts synchronously (review of U8, round 4), and a consumer's
 * program listener must not become a second one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrickId } from '../contracts';
import { followProgramRow } from '../programs/programService';
import type { ReadModelChange, ReadValue } from '../telemetry/telemetryReadModel';

const A = 'AAA' as BrickId;
const B = 'BBB' as BrickId;
const ROW = 'program.user.running';

function fakeTelemetry(snapshot: ReadValue[] = []) {
	const claims: { brickId: string; rowIds: readonly string[]; intervalMs: number; owner: string }[] = [];
	const released: string[] = [];
	let onChange: ((change: ReadModelChange) => void) | undefined;
	let onEnded: ((event: { brickKey: string; handles: readonly string[] }) => void) | undefined;
	return {
		claims, released,
		change: (change: ReadModelChange) => onChange?.(change),
		endClaims: (brickKey: string, handles: readonly string[]) => onEnded?.({ brickKey, handles }),
		telemetry: {
			claim: (brickId: BrickId, request: { rowIds: readonly string[]; intervalMs: number }, owner: string) => {
				claims.push({ brickId, ...request, owner });
				return { handle: `h${claims.length}`, grant: {} };
			},
			release: (handle: string) => { released.push(handle); },
			snapshot: (brickId: BrickId, rowIds?: readonly string[]) =>
				snapshot.filter((value) => brickId === A && (!rowIds || rowIds.includes(value.rowId))),
			onChange: (listener: (change: ReadModelChange) => void) => {
				onChange = listener;
				return { dispose: () => { onChange = undefined; } };
			},
			onClaimsEnded: (listener: (event: { brickKey: string; handles: readonly string[] }) => void) => {
				onEnded = listener;
				return { dispose: () => { onEnded = undefined; } };
			},
		},
	};
}

const value = (running: unknown, stale = false): ReadValue =>
	({ rowId: ROW, value: running as boolean, sampledAt: 1, stale });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('Following the program row (step-6 U9)', () => {
	it('claims the row on its brick at the interval it is given, as the cockpit', () => {
		const t = fakeTelemetry();
		followProgramRow(t.telemetry, A, () => 750).follow(() => undefined, () => undefined);
		assert.deepEqual(t.claims, [{ brickId: A, rowIds: [ROW], intervalMs: 750, owner: 'cockpit:programs' }]);
	});

	it('tells the state there is now, then each change of its brick, after the read model\'s dispatch', async () => {
		const t = fakeTelemetry([value(false)]);
		const heard: boolean[] = [];
		followProgramRow(t.telemetry, A, () => 1000).follow((running) => heard.push(running), () => undefined);
		t.change({ brickKey: A, rows: [value(true)], removed: [] });
		assert.deepEqual(heard, [], 'nothing inside the call or the dispatch');

		await settle();
		assert.deepEqual(heard, [false, true]);
	});

	it('tells nothing for another brick, a stale or dropped value, or a value that is not a state', async () => {
		const t = fakeTelemetry();
		const heard: boolean[] = [];
		followProgramRow(t.telemetry, A, () => 1000).follow((running) => heard.push(running), () => undefined);
		t.change({ brickKey: B, rows: [value(true)], removed: [] });
		t.change({ brickKey: A, rows: [value(true, true)], removed: [] });
		t.change({ brickKey: A, rows: [], removed: [ROW] });
		t.change({ brickKey: A, rows: [value(1)], removed: [] });
		await settle();
		assert.deepEqual(heard, []);
	});

	it('releases its claim once when it ends, and tells nothing that was on its way', async () => {
		const t = fakeTelemetry();
		const heard: boolean[] = [];
		const following = followProgramRow(t.telemetry, A, () => 1000).follow((running) => heard.push(running), () => undefined);
		t.change({ brickKey: A, rows: [value(true)], removed: [] });

		following.dispose();
		following.dispose();
		await settle();

		assert.deepEqual(t.released, ['h1']);
		assert.deepEqual(heard, []);
	});
	it('says when the brick\'s session ended its claim, and tells nothing after (U9 review 1)', async () => {
		const t = fakeTelemetry();
		const heard: boolean[] = [];
		let ended = 0;
		followProgramRow(t.telemetry, A, () => 1000).follow((running) => heard.push(running), () => { ended += 1; });
		t.endClaims(B, ['h1']);
		assert.equal(ended, 0, 'another brick\'s claims');
		t.change({ brickKey: A, rows: [value(true)], removed: [] });

		t.endClaims(A, ['h1']);
		t.change({ brickKey: A, rows: [value(false)], removed: [] });
		await settle();

		assert.equal(ended, 1);
		assert.deepEqual(heard, [], 'what was queued before the end, and anything after, is not told');
	});

	it('tells when each state was sampled, so a newer one already known wins (U9 review 1)', async () => {
		const t = fakeTelemetry();
		const heard: [boolean, number][] = [];
		followProgramRow(t.telemetry, A, () => 1000).follow((running, at) => heard.push([running, at]), () => undefined);
		t.change({ brickKey: A, rows: [{ ...value(true), sampledAt: 42 }], removed: [] });
		await settle();
		assert.deepEqual(heard, [[true, 42]]);
	});
});
