//! How fast one brick's telemetry tick may run, from how its round trips behave.
//!
//! Throttling moves one knob, the tick, by a factor over the plan's period: dividers and phases
//! stay. The input is each telemetry frame's round trip as a distribution, not an average: a brick
//! drawing its port screen keeps a 6 ms median and a 37 ms p95, and only the tail tells it from a
//! quiet one. Queue depth is not an input: one frame in flight per brick pins it at 0 or 1.
//!
//! Tumbling windows of `window_size` round trips. At the end of each, the window's p95 is set
//! against `tail_factor` × the link's usual round trip: over it, the factor grows one `step`, up to
//! `max_slowdown`; within it for `calm_windows` windows in a row, it shrinks one step, down to 1.
//! One stall in a window is not its p95; two in twenty are.

use super::error::TelemetryError;
use super::settings::ThrottleSettings;

/// What the diagnostic display shows for a brick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThrottleState {
    /// The tick as a multiple of the plan's: 1 is not throttled.
    pub factor: f64,
    /// The p95 a window may reach, in milliseconds.
    pub limit_ms: f64,
    /// The last complete window's p95, in milliseconds; `None` before the first.
    pub p95_ms: Option<f64>,
    /// Round trips over the limit in the last complete window.
    pub stalls: usize,
    /// Round trips gathered towards the next decision.
    pub window_samples: usize,
}

#[derive(Debug, Clone)]
pub struct TickThrottle {
    settings: ThrottleSettings,
    round_trip_ms: f64,
    trips: Vec<f64>,
    calm: u32,
    current: f64,
    last: Option<(f64, usize)>,
}

impl TickThrottle {
    /// A throttle for a link whose usual round trip is `round_trip_ms`.
    pub fn new(settings: ThrottleSettings, round_trip_ms: f64) -> Result<Self, TelemetryError> {
        settings.check()?;
        Ok(Self {
            settings,
            round_trip_ms,
            trips: Vec::new(),
            calm: 0,
            current: 1.0,
            last: None,
        })
    }

    /// The tick as a multiple of the plan's.
    pub fn factor(&self) -> f64 {
        self.current
    }

    /// Takes one frame's round trip; true when the factor changed.
    pub fn observe(&mut self, round_trip_ms: f64) -> bool {
        self.trips.push(round_trip_ms);
        if self.trips.len() < self.settings.window_size as usize {
            return false;
        }
        let mut sorted = std::mem::take(&mut self.trips);
        sorted.sort_by(f64::total_cmp);
        let rank = (0.95 * sorted.len() as f64).ceil() as usize;
        let p95 = sorted[rank.saturating_sub(1)];
        let limit = self.limit_ms();
        self.last = Some((p95, sorted.iter().filter(|&&ms| ms > limit).count()));
        if !self.settings.enabled {
            return false;
        }
        let before = self.current;
        if p95 > limit {
            self.calm = 0;
            self.current = (self.current * self.settings.step).min(self.settings.max_slowdown);
        } else {
            self.calm += 1;
            if self.calm >= self.settings.calm_windows && self.current > 1.0 {
                self.calm = 0;
                self.current = (self.current / self.settings.step).max(1.0);
            }
        }
        self.current != before
    }

    /// New settings apply at once; true when that changed the factor. What was gathered under the
    /// old ones (the window in progress, the calm count, the last window's numbers) is dropped, so
    /// a decision and the display never mix two limits. Refuses settings out of range, changing
    /// nothing.
    pub fn configure(&mut self, settings: ThrottleSettings) -> Result<bool, TelemetryError> {
        settings.check()?;
        self.settings = settings;
        self.trips.clear();
        self.calm = 0;
        self.last = None;
        let before = self.current;
        self.current = if settings.enabled {
            self.current.min(settings.max_slowdown)
        } else {
            1.0
        };
        Ok(self.current != before)
    }

    pub fn state(&self) -> ThrottleState {
        ThrottleState {
            factor: self.current,
            limit_ms: self.limit_ms(),
            p95_ms: self.last.map(|(p95, _)| p95),
            stalls: self.last.map_or(0, |(_, stalls)| stalls),
            window_samples: self.trips.len(),
        }
    }

    fn limit_ms(&self) -> f64 {
        self.settings.tail_factor * self.round_trip_ms
    }
}
