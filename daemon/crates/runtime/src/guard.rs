//! The firmware guard: a command rate ceiling per brick, and failure counting per channel.
//!
//! Two keys, because the two protections are about different things. Firmware stress is a
//! property of the brick: commands arriving over USB and Bluetooth at once still land on one VM,
//! so the rate window is shared by every channel to that brick. Failures are a property of a
//! link: a pulled cable fails every USB send while the Bluetooth link to the same brick is
//! healthy, and counting those failures against the brick would degrade it and block the
//! standby channel traffic is about to move to.
//!
//! Dropped on purpose and not to be re-added: "one active transport per brick" and a 2 s cooldown
//! before switching. Measured on three bricks and two firmware versions with USB and Bluetooth
//! open to one brick and commands in flight on both, nothing froze, and the incident the rule
//! cited has no record.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ev3_transports::BrickKey;
use tokio::time::Instant;

use crate::error::SessionError;

/// The rate window's length.
const WINDOW: Duration = Duration::from_secs(1);

/// The guard's limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuardConfig {
    /// Commands per brick per second, across all its channels.
    ///
    /// A backstop against a pathological caller, not a meter on normal traffic: each transport
    /// is serial and so limits itself (measured sustained: USB 176, TCP 62, Bluetooth 11 per
    /// second; a file through libusb about 380 exchanges per second). USB, TCP and Bluetooth at
    /// full speed together come to under 500; 1000 leaves that twice over. It was 200 until a
    /// 100 000-byte file was refused halfway.
    pub max_commands_per_sec: usize,
    /// Consecutive failures on one channel before it is degraded.
    pub degradation_threshold: u32,
}

impl Default for GuardConfig {
    fn default() -> Self {
        Self {
            max_commands_per_sec: 1000,
            degradation_threshold: 3,
        }
    }
}

/// The brick a channel leads to: the twelve hardware digits when the key carries them, else the
/// key itself. The EV3 uses its Bluetooth address as its USB serial and in its TCP beacon, so
/// one brick's channels share these digits.
pub fn brick_id_of(key: &BrickKey) -> String {
    key.hardware_id().unwrap_or_else(|| key.as_str().to_owned())
}

#[derive(Debug, Default)]
struct Health {
    consecutive_failures: u32,
    degraded: bool,
    last_rtt: Option<Duration>,
}

#[derive(Default)]
struct State {
    /// Send times within the last window, by brick.
    windows: HashMap<String, VecDeque<Instant>>,
    /// Health by channel.
    channels: HashMap<BrickKey, Health>,
}

/// The guard every session shares.
pub struct Guard {
    config: GuardConfig,
    state: Mutex<State>,
}

impl Default for Guard {
    fn default() -> Self {
        Self::new(GuardConfig::default())
    }
}

impl Guard {
    pub fn new(config: GuardConfig) -> Self {
        Self {
            config,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes a send slot before a command goes over `channel`; fails at once if the channel is
    /// degraded.
    ///
    /// A full window waits until its oldest send leaves it; it does not refuse. The commands
    /// that fill a window come in runs, a file sent in chunks most of all: refusing one mid-run
    /// left a half-written file and failed the commands queued behind it. Waiting slows a
    /// runaway caller to the ceiling and fails nothing a working caller asked for.
    pub async fn acquire(&self, channel: &BrickKey) -> Result<(), SessionError> {
        let brick = brick_id_of(channel);
        // Another channel to the brick may take the freed slot first; the loop asks again.
        while let Some(wait) = self.take(&brick, channel)? {
            tokio::time::sleep(wait).await;
        }
        Ok(())
    }

    /// Takes a slot and answers `None`, or answers how long until the oldest send leaves the
    /// window.
    fn take(&self, brick: &str, channel: &BrickKey) -> Result<Option<Duration>, SessionError> {
        let mut state = self.lock();
        if state.channels.get(channel).is_some_and(|h| h.degraded) {
            return Err(SessionError::Degraded {
                brick_key: channel.clone(),
            });
        }
        let now = Instant::now();
        let window = state.windows.entry(brick.to_owned()).or_default();
        while window
            .front()
            .is_some_and(|sent| now.duration_since(*sent) >= WINDOW)
        {
            window.pop_front();
        }
        if window.len() < self.config.max_commands_per_sec {
            window.push_back(now);
            return Ok(None);
        }
        let oldest = *window.front().unwrap_or(&now);
        // A millisecond past the oldest send's turn, so the retry finds it gone.
        let turn = oldest + WINDOW + Duration::from_millis(1);
        Ok(Some(turn.saturating_duration_since(now)))
    }

    /// A send over `channel` succeeded: its failure count starts again.
    pub fn record_success(&self, channel: &BrickKey, rtt: Option<Duration>) {
        let mut state = self.lock();
        let health = state.channels.entry(channel.clone()).or_default();
        health.consecutive_failures = 0;
        health.degraded = false;
        if rtt.is_some() {
            health.last_rtt = rtt;
        }
    }

    /// A send over `channel` failed; enough in a row degrade it.
    pub fn record_failure(&self, channel: &BrickKey) {
        let mut state = self.lock();
        let health = state.channels.entry(channel.clone()).or_default();
        health.consecutive_failures += 1;
        if health.consecutive_failures >= self.config.degradation_threshold {
            health.degraded = true;
        }
    }

    /// Clears a channel's failure history and round trip. Called when its session ends or
    /// reconnects.
    ///
    /// The failures belonged to the link that closed or died. A degraded channel has no way back
    /// on its own, since every send is refused before it reaches the link, so without this a
    /// cable that comes back would be refused for good. Only this channel: another channel to
    /// the same brick keeps its own count.
    pub fn reset_health(&self, channel: &BrickKey) {
        let mut state = self.lock();
        if let Some(health) = state.channels.get_mut(channel) {
            *health = Health::default();
        }
    }

    pub fn is_degraded(&self, channel: &BrickKey) -> bool {
        self.lock()
            .channels
            .get(channel)
            .is_some_and(|h| h.degraded)
    }

    /// The last round trip a successful send over `channel` took.
    pub fn last_rtt(&self, channel: &BrickKey) -> Option<Duration> {
        self.lock().channels.get(channel).and_then(|h| h.last_rtt)
    }
}
