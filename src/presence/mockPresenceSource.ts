/**
 * Mock presence source providing virtual bricks for development without hardware.
 *
 * @packageDocumentation
 */

import { TransportMode } from '../types/enums';
import type { MockBrickDefinition } from '../mock/mockCatalog';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';

export class MockPresenceSource implements PresenceSource {
	public readonly transport = TransportMode.MOCK;

	private readonly present = new Map<string, PresenceRecord>();
	private readonly listeners: PresenceChangeCallback[] = [];

	public start(): void {
		// no-op — mock bricks are static
	}

	public stop(): void {
		// no-op
	}

	public getPresent(): ReadonlyMap<string, PresenceRecord> {
		return this.present;
	}

	public onChange(callback: PresenceChangeCallback): void {
		this.listeners.push(callback);
	}

	public refresh(mockBricks: MockBrickDefinition[]): void {
		const previousIds = new Set(this.present.keys());
		this.present.clear();
		const now = Date.now();

		for (const mock of mockBricks) {
			const detail = mock.role === 'master'
				? 'Mock | master'
				: mock.parentDisplayName
					? `Mock | slave of ${mock.parentDisplayName}`
					: 'Mock | slave';

			this.present.set(mock.brickId, {
				candidateId: mock.brickId,
				transport: TransportMode.MOCK,
				displayName: mock.displayName,
				detail,
				connectable: true,
				lastSeenMs: now,
				connectionParams: { mode: 'mock' }
			});
		}

		const currentIds = new Set(this.present.keys());
		const changed = previousIds.size !== currentIds.size
			|| [...previousIds].some((id) => !currentIds.has(id));

		if (changed) {
			this.fireChange();
		}
	}

	private fireChange(): void {
		for (const listener of this.listeners) {
			try {
				listener(this.present);
			} catch {
				// swallow
			}
		}
	}
}
