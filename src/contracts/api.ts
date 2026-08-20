import { ConnectionState, TelemetryCategory, Transport } from './enums';
import { BrickKey } from './brickKey';

export interface ConnectedBrickSnapshot {
    brickKey: BrickKey;
    displayName: string;
    transport: Transport;
    connectionState: ConnectionState;
}

/**
 * Public mirror of the runtime's session state change.
 *
 * Field names match `SessionStateChangeEvent` deliberately: the two describe the
 * same event, and `currentState` here against `newState` there was a rename
 * waiting to confuse a consumer.
 */
export interface BrickStateChangeEvent {
    brickKey: BrickKey;
    previousState: ConnectionState;
    newState: ConnectionState;
}

export interface ActiveBrickSnapshot {
    brickKey: BrickKey | null;
    displayName?: string;
    transport?: Transport;
}

export interface TelemetrySnapshot {
    brickKey: BrickKey;
    category: TelemetryCategory;
    timestamp: number;
    data: unknown;
}

export interface TelemetryEvent {
    brickKey: BrickKey;
    category: TelemetryCategory;
    timestamp: number;
    delta: unknown;
}

export interface FilesystemEvent {
    brickKey: BrickKey;
    operation: 'upload' | 'download' | 'list' | 'read' | 'execute';
    path: string;
    success: boolean;
    error?: string;
}
