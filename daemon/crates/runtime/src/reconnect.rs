//! The reconnect backoff: how long to wait before each attempt.

use std::time::Duration;

/// The backoff's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffConfig {
    pub base: Duration,
    pub max: Duration,
    pub multiplier: u32,
    /// `None`: never give up. A session a user signed in to keeps trying for as long as the
    /// sign-in stands; unplugging a cable is the world's doing, signing out is the user's. A
    /// ceiling of ten attempts once spanned about three minutes, and a brick that came back 35
    /// seconds after that was never picked up although discovery saw it the whole time.
    pub max_attempts: Option<u32>,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_millis(1000),
            max: Duration::from_millis(30_000),
            multiplier: 2,
            max_attempts: None,
        }
    }
}

/// Exponential backoff: `base × multiplier^attempt`, capped at `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    config: BackoffConfig,
    attempts: u32,
}

impl Backoff {
    pub fn new(config: BackoffConfig) -> Self {
        Self {
            config,
            attempts: 0,
        }
    }

    /// Attempts made since the last reset.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn exhausted(&self) -> bool {
        self.config
            .max_attempts
            .is_some_and(|max| self.attempts >= max)
    }

    /// The wait before the next attempt, counting it; `None` once the attempts are used up.
    pub fn next_delay(&mut self) -> Option<Duration> {
        if self.exhausted() {
            return None;
        }
        let factor = u128::from(self.config.multiplier)
            .checked_pow(self.attempts)
            .unwrap_or(u128::MAX);
        let delay_ms = self
            .config
            .base
            .as_millis()
            .saturating_mul(factor)
            .min(self.config.max.as_millis());
        self.attempts = self.attempts.saturating_add(1);
        Some(Duration::from_millis(
            u64::try_from(delay_ms).unwrap_or(u64::MAX),
        ))
    }

    /// Starts a fresh cycle.
    pub fn reset(&mut self) {
        self.attempts = 0;
    }
}
