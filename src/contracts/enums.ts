export enum Transport {
    Mock = 'mock',
    USB = 'usb',
    TCP = 'tcp',
    BT = 'bt',
}

export enum PresenceState {
    Remembered = 'remembered',
    Available = 'available',
    Unavailable = 'unavailable',
    Removed = 'removed',
}

/**
 * What one channel to one brick looks like from the list: the icon's state.
 *
 * - `absent`: never seen this session — the icon is hidden.
 * - `available`: seen and not connected.
 * - `connected`: a live session over it.
 * - `lost`: seen or connected this session and not now — a pulled cable, a brick out of
 *   range, a paired Bluetooth brick whose presence check went unanswered ("not heard").
 */
export enum ChannelState {
    Absent = 'absent',
    Available = 'available',
    Connected = 'connected',
    Lost = 'lost',
}

export enum ConnectionState {
    Connecting = 'connecting',
    Connected = 'connected',
    Reconnecting = 'reconnecting',
    Disconnected = 'disconnected',
}

export enum ActivityMode {
    Foreground = 'foreground',
    Subscribed = 'subscribed',
    Minimal = 'minimal',
    None = 'none',
}

export enum TelemetryCategory {
    Ports = 'ports',
    Filesystem = 'filesystem',
    System = 'system',
}
