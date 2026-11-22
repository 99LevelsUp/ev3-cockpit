//! The wall clock telemetry stamps its values with.
//!
//! Values carry milliseconds since the Unix epoch, which the contract promises. The system clock
//! is read on every call, so a value sampled after the computer slept carries the real time; a
//! monotonic clock stops while the machine is suspended and would lag by the time slept. Tests
//! anchor the clock instead, so tokio's paused clock moves it with the timers.

use std::time::{SystemTime, UNIX_EPOCH};

use tokio::time::Instant;

#[derive(Debug, Clone, Copy)]
pub struct WallClock {
    /// For a test clock: the epoch time it read when made, and when that was.
    anchor: Option<(u64, Instant)>,
}

impl WallClock {
    /// The system clock.
    pub fn system() -> Self {
        Self { anchor: None }
    }

    /// A clock that reads `epoch_ms` now and counts on with tokio's clock: for tests.
    pub fn starting_at(epoch_ms: u64) -> Self {
        Self {
            anchor: Some((epoch_ms, Instant::now())),
        }
    }

    /// Milliseconds since the Unix epoch.
    pub fn now_ms(&self) -> u64 {
        match self.anchor {
            None => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
            Some((epoch_ms, start)) => {
                let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
                epoch_ms.saturating_add(elapsed)
            }
        }
    }
}

impl Default for WallClock {
    fn default() -> Self {
        Self::system()
    }
}
