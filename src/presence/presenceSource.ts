import type { TransportMode } from '../types/enums';

export interface PresenceRecord {
	candidateId: string;
	transport: TransportMode;
	displayName: string;
	detail: string;
	connectable: boolean;
	lastSeenMs: number;
	mac?: string;
	connectionParams: ConnectionParams;
}

export type ConnectionParams =
	| { mode: 'usb'; usbPath: string }
	| { mode: 'bt'; btPortPath?: string; mac?: string }
	| { mode: 'tcp'; tcpHost: string; tcpPort: number; tcpSerialNumber?: string }
	| { mode: 'mock' };

export type PresenceChangeCallback = (records: ReadonlyMap<string, PresenceRecord>) => void;

export interface PresenceSource {
	readonly transport: TransportMode;
	start(): void;
	stop(): void;
	getPresent(): ReadonlyMap<string, PresenceRecord>;
	onChange(callback: PresenceChangeCallback): void;
}
