/**
 * "Disconnect a Brick" with holders (R36): a disconnect drops only this window's hold. When others
 * still hold the brick it stays connected, the person is told who holds it, and is offered to
 * disconnect it for everyone.
 *
 * Free of `vscode`: the command hands it a picker and a notification.
 */

import type { ContractBrick } from '../../contract/models';

export const FOR_EVERYONE_ACTION = 'Disconnect for everyone';

export interface DisconnectClient {
	bricks(): readonly ContractBrick[];
	request(method: 'bricks/disconnect', params: { brick: string; forEveryone?: boolean }): Promise<{ readonly stillHeldBy: readonly string[] }>;
}

export interface DisconnectUi {
	pick<T extends { readonly label: string }>(items: readonly T[]): PromiseLike<T | undefined>;
	/** A notification with actions; resolves with the one chosen, or undefined when dismissed. */
	notify(message: string, ...actions: string[]): PromiseLike<string | undefined>;
	log(message: string): void;
}

export async function disconnectBrick(client: DisconnectClient, ui: DisconnectUi, describe: (brick: ContractBrick) => string): Promise<void> {
	const connected = client.bricks().filter((b) => b.connected);
	if (connected.length === 0) {
		await ui.notify('EVƎ Cockpit: no brick is connected.');
		return;
	}
	const picked = await ui.pick(connected.map((brick) => ({ label: brick.name, description: describe(brick), brick })));
	if (!picked) { return; }
	const { brick } = picked;
	const result = await client.request('bricks/disconnect', { brick: brick.brickId });
	ui.log(`Disconnected ${brick.name} (${brick.brickId})${result.stillHeldBy.length > 0 ? `; still held by ${result.stillHeldBy.join(', ')}` : ''}`);
	if (result.stillHeldBy.length === 0) { return; }
	const choice = await ui.notify(
		`EVƎ Cockpit: ${brick.name} stays connected — ${result.stillHeldBy.join(', ')} ${result.stillHeldBy.length === 1 ? 'holds' : 'hold'} it too.`,
		FOR_EVERYONE_ACTION);
	if (choice !== FOR_EVERYONE_ACTION) { return; }
	await client.request('bricks/disconnect', { brick: brick.brickId, forEveryone: true });
	ui.log(`Disconnected ${brick.name} for everyone`);
}
