import { ActivityMode, ChannelState, ConnectionState, PresenceState, TelemetryCategory, Transport } from './enums';
import { BrickId, BrickKey } from './brickKey';

export interface SignalInfo {
    rssi?: number;
    strength?: 'strong' | 'medium' | 'weak';
}

/**
 * Where a brick's name came from, which decides how far it can be trusted.
 *
 * Only `brick` (the brick's own `info` reply) and `beacon` (its TCP announcement) follow a
 * rename; the rest are records that go stale. Measured 29.10.2026: the USB descriptor is
 * fixed when the cable goes in, and Windows' Bluetooth record catches up only at the next
 * Bluetooth connection (step-1 plan §4a).
 */
export type NameSource = 'brick' | 'beacon' | 'usb-descriptor' | 'bt-cache' | 'fallback';

/**
 * What one transport reports about one brick it can see — one channel, before bricks are
 * grouped. The discovery list itself is made of {@link BrickEntry}s.
 *
 * Invariant: when `presenceState === PresenceState.Remembered`, `remembered` is always `true`.
 * The inverse does not hold — a brick can be `remembered: true` with `presenceState: Available`
 * (a saved brick that is currently visible).
 */
export interface DiscoveryItem {
    brickKey: BrickKey;
    displayName: string;
    /** Where `displayName` came from; `fallback` when omitted. */
    nameSource?: NameSource;
    transport: Transport;
    presenceState: PresenceState;
    remembered: boolean;
    connected: boolean;
    favorite: boolean;
    /** Paired with this computer. Bluetooth only. */
    paired?: boolean;
    /**
     * Whether a paired brick answered its recent presence checks. Bluetooth only; absent
     * before the first check, when Windows' record is all there is to go on.
     */
    heard?: boolean;
    /** When a paired brick last answered a presence check. */
    heardAt?: number;
    signalInfo?: SignalInfo;
    btVisible?: boolean;
    lastSeenAt: number;
}

/** A brick's name and how much it can be trusted. */
export interface BrickName {
    readonly value: string;
    readonly source: NameSource;
    /** True when the brick itself said so (`brick` or `beacon`); the list may mark the rest. */
    readonly confirmed: boolean;
}

/** One channel of a brick entry. */
export interface BrickChannelSnapshot {
    readonly brickKey: BrickKey;
    readonly transport: Transport;
    /** The provider's channel priority; traffic prefers the highest connected one. */
    readonly priority: number;
    readonly state: ChannelState;
    readonly signalInfo?: SignalInfo;
    /** When discovery last saw this channel, or 0 if it never has. */
    readonly lastSeenAt: number;
    /** When the brick last answered a presence check over this channel, if it ever has. */
    readonly heardAt?: number;
}

/**
 * One row of the discovery list: one brick, however many channels reach it.
 *
 * A channel this session has never seen is not listed and its state is `absent`.
 */
export interface BrickEntry {
    readonly brickId: BrickId;
    readonly name: BrickName;
    /** Highest priority first. */
    readonly channels: readonly BrickChannelSnapshot[];
    /** Paired with this computer over Bluetooth. */
    readonly paired: boolean;
    readonly remembered: boolean;
    readonly favorite: boolean;
    readonly lastSeenAt: number;
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
