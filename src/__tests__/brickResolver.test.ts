/** Which brick a client means: by id or name, waiting for a just-started daemon's first discovery. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import { ResolverBrick, resolveBrick } from '../daemon/brickResolver';

const deps = (bricks: ResolverBrick[], settle: () => Promise<void> = () => Promise.resolve()) => ({ bricks: () => bricks, discoverySettled: settle });
const code = (c: WireErrorCode) => (e: unknown) => e instanceof ContractError && e.code === c;

describe('resolving a brick', () => {
	it('finds a brick by id, or by its name in any case', async () => {
		const d = deps([{ brickId: 'usb:1', name: 'CCC', connected: false }]);
		assert.equal(await resolveBrick(d, 'usb:1', 'mcp'), 'usb:1');
		assert.equal(await resolveBrick(d, 'ccc', 'mcp'), 'usb:1');
	});

	it('refuses a name two bricks share, listing both', async () => {
		const d = deps([{ brickId: 'usb:1', name: 'EV3', connected: true }, { brickId: 'bt:2', name: 'EV3', connected: false }]);
		await assert.rejects(resolveBrick(d, 'EV3', 'cli'), (e: unknown) => code(WireErrorCode.BrickAmbiguous)(e)
			&& (e as ContractError).data.candidates?.length === 2);
		assert.equal(await resolveBrick(d, 'bt:2', 'cli'), 'bt:2');
	});

	it('waits for the first discovery round before refusing a name it has not heard yet', async () => {
		const bricks: ResolverBrick[] = [];
		const d = deps(bricks, async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			bricks.push({ brickId: 'bt:9', name: 'CCC', connected: false });
		});
		assert.equal(await resolveBrick(d, 'CCC', 'cli'), 'bt:9');
		await assert.rejects(resolveBrick(deps([]), 'Nobody', 'cli'), code(WireErrorCode.BrickNotFound));
	});

	it('uses the one connected brick for a CLI that names none, never for an agent', async () => {
		const one = deps([{ brickId: 'usb:1', name: 'CCC', connected: true }, { brickId: 'bt:2', name: 'BBB', connected: false }]);
		assert.equal(await resolveBrick(one, undefined, 'cli'), 'usb:1');
		await assert.rejects(resolveBrick(one, undefined, 'mcp'), code(WireErrorCode.InvalidRequest));
		const two = deps([{ brickId: 'usb:1', name: 'CCC', connected: true }, { brickId: 'bt:2', name: 'BBB', connected: true }]);
		await assert.rejects(resolveBrick(two, undefined, 'cli'), code(WireErrorCode.BrickAmbiguous));
		await assert.rejects(resolveBrick(deps([]), undefined, 'cli'), code(WireErrorCode.NotConnected));
	});
});
