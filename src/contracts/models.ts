import { ActivityMode, ConnectionState, PresenceState, TelemetryCategory, Transport } from './enums';
import { BrickKey } from './brickKey';

export interface SignalInfo {
    rssi?: number;
    strength?: 'strong' | 'medium' | 'weak';
}

export interface DiscoveryItem {
    brickKey: BrickKey;
    displayName: string;
    transport: Transport;
    presenceState: PresenceState;
    remembered: boolean;
    connected: boolean;
    favorite: boolean;
    signalInfo?: SignalInfo;
    availableTransports: Transport[];
    btVisible?: boolean;
    lastSeenAt: number;
}

export type HeartbeatState = 'ok' | 'missed' | 'unknown';

export interface ConnectedSession {
    brickKey: BrickKey;
    displayName: string;
    transport: Transport;
    connectionState: ConnectionState;
    activeMode: ActivityMode;
    lastError?: string;
    subscribedCategories: TelemetryCategory[];
    heartbeatState: HeartbeatState;
}

export type ValueDisplayStyle = 'numeric' | 'visual';

export interface BatteryState {
    level: number;
    voltage?: number;
}

export interface PortState {
    port: string;
    peripheralType?: string;
    value?: number | string;
    unit?: string;
    timestamp?: number;
}

export interface ActiveBrickViewModel {
    brickKey: BrickKey;
    displayName: string;
    transport: Transport;
    connectionState: ConnectionState;
    battery?: BatteryState;
    availableTransports: Transport[];
    btVisible?: boolean;
    motorPorts: PortState[];
    sensorPorts: PortState[];
    buttons: Record<string, boolean>;
    firmwareVersion?: string;
    favorite: boolean;
    valueDisplayStyle: ValueDisplayStyle;
}
