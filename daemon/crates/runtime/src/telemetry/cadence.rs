//! Per-transport telemetry cadence and each link's usual round trip.
//!
//! One composed frame is one command, so a tick period converts straight into a share of the
//! transport's measured sustained rate:
//!
//! | Transport | Sustained   | Worst RTT | Target       | Floor        |
//! |-----------|-------------|-----------|--------------|--------------|
//! | USB       | 176 cmd/s   | 9 ms      | 100 ms (6%)  | 50 ms (11%)  |
//! | TCP       | 62 cmd/s    | 58 ms     | 200 ms (8%)  | 100 ms (16%) |
//! | BT        | 10.7 cmd/s  | 121 ms    | 500 ms (19%) | 250 ms (37%) |
//!
//! Bluetooth constrains the design. Its whole capacity is 10.7 commands a second, and the
//! heartbeat and whatever the user does come out of the same budget, so "10 Hz everywhere" would
//! take the entire link. Two hertz leaves better than eight commands a second for everything
//! else. The floor is a figure of its own because throttling moves the tick and nothing else, and
//! must not move it below where the heartbeat stops fitting. The cadence is a share of the link
//! chosen on purpose, so it is written out rather than derived from the measurements.

use ev3_transports::Transport;

/// A transport's telemetry tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cadence {
    /// The tick the foreground brick runs at, in milliseconds.
    pub foreground_ms: u64,
    /// The fastest tick this transport permits, in milliseconds: a client may ask for more and is
    /// granted this at best. The gap to `foreground_ms` is the room throttling moves in.
    pub floor_ms: u64,
}

/// The cadence of a transport. The mock has no wire; its figures mirror USB so tests run the
/// production path. An unknown transport gets Bluetooth's: guessing fast on a link that cannot
/// carry it starves the heartbeat, guessing slow only slows a panel.
pub fn cadence_for(transport: Option<Transport>) -> Cadence {
    match transport {
        Some(Transport::Usb | Transport::Mock) => Cadence {
            foreground_ms: 100,
            floor_ms: 50,
        },
        Some(Transport::Tcp) => Cadence {
            foreground_ms: 200,
            floor_ms: 100,
        },
        Some(Transport::Bt) | None => Cadence {
            foreground_ms: 500,
            floor_ms: 250,
        },
    }
}

/// A link's usual round trip in milliseconds, measured. The mock is timed as USB; a transport not
/// known is timed as the slowest, Bluetooth, so the throttle's limit errs wide.
pub fn typical_round_trip_ms(transport: Option<Transport>) -> f64 {
    match transport {
        Some(Transport::Usb | Transport::Mock) => 10.0,
        Some(Transport::Tcp) => 60.0,
        Some(Transport::Bt) | None => 130.0,
    }
}
