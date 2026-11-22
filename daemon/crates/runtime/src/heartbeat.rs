//! The heartbeat's rule: which probe results count as missed beats, and when misses end the
//! link.
//!
//! The probe is a battery query every interval; the session runs the loop. A probe that fails
//! because the reply could not be read proves the opposite of a lost link (the brick answered),
//! so it is not a miss: on a firmware whose battery layout differs, every probe would fail, and
//! counting those would reconnect a working brick forever instead of merely losing telemetry.

use std::time::Duration;

/// Below this the heartbeat stresses the firmware; a shorter interval asked for is raised to it.
pub const MIN_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(3000);

/// The interval actually used for a requested one.
pub fn effective_interval(requested: Duration) -> Duration {
    requested.max(MIN_HEARTBEAT_INTERVAL)
}

/// What one probe found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// A readable answer.
    Answered,
    /// An answer arrived and could not be read: the link is alive.
    Unreadable,
    /// No answer: the link failed or the reply came too late.
    Missed,
}

/// What a probe means for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Beat {
    /// The link answered.
    Ok,
    /// The link answered with something unreadable; worth reporting, not a miss.
    Anomaly,
    /// A missed beat below the threshold.
    Missed,
    /// The threshold is reached: the link is gone.
    Failed,
}

/// Consecutive missed beats against a threshold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissCounter {
    threshold: u32,
    misses: u32,
}

impl MissCounter {
    /// A counter that fails at `threshold` consecutive misses (at least one).
    pub fn new(threshold: u32) -> Self {
        Self {
            threshold: threshold.max(1),
            misses: 0,
        }
    }

    pub fn misses(&self) -> u32 {
        self.misses
    }

    pub fn reset(&mut self) {
        self.misses = 0;
    }

    /// Counts one probe. An answer of either kind clears the count, since a reply proves the
    /// link; at the threshold the count starts again, so a heartbeat restarted after a reconnect
    /// begins from zero.
    pub fn record(&mut self, probe: Probe) -> Beat {
        match probe {
            Probe::Answered => {
                self.misses = 0;
                Beat::Ok
            }
            Probe::Unreadable => {
                self.misses = 0;
                Beat::Anomaly
            }
            Probe::Missed => {
                self.misses += 1;
                if self.misses >= self.threshold {
                    self.misses = 0;
                    Beat::Failed
                } else {
                    Beat::Missed
                }
            }
        }
    }
}
