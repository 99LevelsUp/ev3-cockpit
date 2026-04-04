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
