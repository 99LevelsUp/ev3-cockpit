import { ConnectionState, TelemetryCategory, Transport } from './enums';
import { BrickKey } from './brickKey';

export interface ConnectedBrickSnapshot {
    brickKey: BrickKey;
    displayName: string;
    transport: Transport;
    connectionState: ConnectionState;
}

export interface BrickStateChangeEvent {
    brickKey: BrickKey;
    previousState: ConnectionState;
    currentState: ConnectionState;
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
