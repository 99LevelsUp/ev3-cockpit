//! Binds the telemetry scheduler to one connected brick.
//!
//! The scheduler composes frames and decides when to send them; it does not know how to reach a
//! brick. Here frames go out as `telemetry:frame` through the brick's own command queue. A frame
//! sent straight to the link would run beside the heartbeat instead of taking turns with it: two
//! writers on one serial link, each unaware of the other's outstanding command. The scheduler's
//! one-frame-in-flight rule then bounds what telemetry adds to that queue to one entry, so a
//! stalled brick delays a sample instead of growing a backlog that starves the heartbeat.

use std::sync::Arc;

use async_trait::async_trait;
use ev3_protocol::commands::FIRMWARE_BUFFER_BYTES;
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_transports::Transport;
use ev3_transports::usb::HID_PACKET_BYTES;
use tokio::time::Instant;

use crate::bricks::{BrickManager, CommandOptions};

use super::assembler::FrameLimits;
use super::cadence::cadence_for;
use super::clock::WallClock;
use super::error::TelemetryError;
use super::registry::ev3_row_registry;
use super::row::TelemetryRow;
use super::scheduler::{
    ErrorListener, FrameLink, SchedulerOptions, SchedulerStats, TelemetryScheduler, ValuesListener,
};

/// What telemetry needs of the brick layer. Narrow, so a test can stand in for it.
#[async_trait]
pub trait TelemetrySender: Send + Sync {
    /// Sends one command to a brick through its command queue.
    async fn send(
        &self,
        brick_id: &str,
        command: BrickCommand,
    ) -> Result<BrickResponse, TelemetryError>;

    /// The largest packet the brick's live link carries, when that is known.
    fn max_packet_bytes(&self, brick_id: &str) -> Option<usize>;

    /// The transport the brick's traffic goes over now; `None` with no route.
    fn transport_of(&self, brick_id: &str) -> Option<Transport>;
}

#[async_trait]
impl TelemetrySender for BrickManager {
    async fn send(
        &self,
        brick_id: &str,
        command: BrickCommand,
    ) -> Result<BrickResponse, TelemetryError> {
        BrickManager::send(self, brick_id, &command, CommandOptions::default())
            .await
            .map_err(|error| TelemetryError::Frame(error.to_string()))
    }

    fn max_packet_bytes(&self, brick_id: &str) -> Option<usize> {
        BrickManager::max_packet_bytes(self, brick_id)
    }

    fn transport_of(&self, brick_id: &str) -> Option<Transport> {
        self.transport_of_brick(brick_id)
    }
}

/// The packet budget of a brick's link now.
///
/// Asked on every frame, because the answer changes under a brick that stays signed in: a USB
/// brick that comes back on the HID fallback is the same brick on a link a sixteenth the size.
/// Asked once, this would keep composing 1024-byte frames for a 64-byte link, and the firmware
/// would answer the truncated request rather than complain. When the link cannot say, USB is
/// taken at the HID size, which every USB link carries, and anything else at the firmware's
/// buffer.
pub fn frame_limits_for(sender: &dyn TelemetrySender, brick_id: &str) -> FrameLimits {
    let live = sender.max_packet_bytes(brick_id);
    let fallback = match sender.transport_of(brick_id) {
        Some(Transport::Usb) => Some(HID_PACKET_BYTES),
        _ => None,
    };
    FrameLimits {
        max_packet_bytes: live.or(fallback).unwrap_or(FIRMWARE_BUFFER_BYTES),
    }
}

/// Hears each frame's round trip in milliseconds.
pub type RoundTripListener = Arc<dyn Fn(f64) + Send + Sync>;

pub struct BrickTelemetryOptions {
    pub sender: Arc<dyn TelemetrySender>,
    pub brick_id: String,
    /// Rows to drive; the full EV3 catalogue when `None`.
    pub rows: Option<Vec<TelemetryRow>>,
    /// The tick in milliseconds; the transport's foreground cadence when `None`.
    pub tick_period_ms: Option<f64>,
    /// The fastest tick [`BrickTelemetry::set_period`] grants; the transport's floor when `None`.
    pub floor_ms: Option<f64>,
    pub on_values: Option<ValuesListener>,
    pub on_error: Option<ErrorListener>,
    /// Each frame's round trip, from handing it to the queue to its answer or failure: the
    /// throttle's input. The wait in the queue counts on purpose: a brick busy with a transfer is a
    /// brick to slow down for.
    pub on_round_trip: Option<RoundTripListener>,
    pub clock: WallClock,
}

impl BrickTelemetryOptions {
    pub fn new(sender: Arc<dyn TelemetrySender>, brick_id: impl Into<String>) -> Self {
        Self {
            sender,
            brick_id: brick_id.into(),
            rows: None,
            tick_period_ms: None,
            floor_ms: None,
            on_values: None,
            on_error: None,
            on_round_trip: None,
            clock: WallClock::system(),
        }
    }
}

struct BrickFrameLink {
    sender: Arc<dyn TelemetrySender>,
    brick_id: String,
    on_round_trip: Option<RoundTripListener>,
}

#[async_trait]
impl FrameLink for BrickFrameLink {
    async fn send_frame(&self, payload: Vec<u8>) -> Result<Vec<u8>, TelemetryError> {
        let started = Instant::now();
        let response = self
            .sender
            .send(&self.brick_id, BrickCommand::TelemetryFrame { payload })
            .await;
        if let Some(listener) = &self.on_round_trip {
            listener(started.elapsed().as_secs_f64() * 1000.0);
        }
        match response? {
            BrickResponse::TelemetryFrame { payload } => Ok(payload),
            // The queue answered a different command than the one that went in: the
            // counter-to-reply pairing is wrong somewhere below. Coercing it would hand the row
            // parser a buffer laid out by somebody else's frame, and readings that look plausible
            // and came from nowhere.
            other => Err(TelemetryError::Frame(format!(
                "Telemetry frame for brick {} came back as another command's reply: {other:?}.",
                self.brick_id
            ))),
        }
    }

    fn frame_limits(&self) -> FrameLimits {
        frame_limits_for(self.sender.as_ref(), &self.brick_id)
    }
}

/// A telemetry loop for one brick. Cheap to clone; clones drive the same loop.
#[derive(Clone)]
pub struct BrickTelemetry {
    scheduler: TelemetryScheduler,
    floor_ms: f64,
}

impl BrickTelemetry {
    /// The loop for one brick; not started, because who runs telemetry and when is the service's
    /// decision. Its cadence belongs to the transport the brick is on now: a route change starts a
    /// new loop rather than retiming this one.
    pub fn new(options: BrickTelemetryOptions) -> Result<Self, TelemetryError> {
        let cadence = cadence_for(options.sender.transport_of(&options.brick_id));
        let tick_period_ms = options
            .tick_period_ms
            .unwrap_or(cadence.foreground_ms as f64);
        let floor_ms = options.floor_ms.unwrap_or(cadence.floor_ms as f64);
        // Through the registry, so every row was validated against the tightest link.
        let rows = options
            .rows
            .unwrap_or_else(|| ev3_row_registry().all().to_vec());
        let link = BrickFrameLink {
            sender: options.sender,
            brick_id: options.brick_id,
            on_round_trip: options.on_round_trip,
        };
        let scheduler = TelemetryScheduler::new(SchedulerOptions {
            rows,
            link: Arc::new(link),
            tick_period_ms,
            on_values: options.on_values,
            on_error: options.on_error,
            clock: options.clock,
        })?;
        Ok(Self {
            scheduler,
            floor_ms,
        })
    }

    pub fn scheduler(&self) -> &TelemetryScheduler {
        &self.scheduler
    }

    /// Whether `other` is this same loop, not a restarted one.
    pub fn is_same(&self, other: &Self) -> bool {
        self.scheduler.is_same(&other.scheduler)
    }

    pub fn start(&self) {
        self.scheduler.start();
    }

    pub fn stop(&self) {
        self.scheduler.stop();
    }

    pub fn dispose(&self) {
        self.scheduler.dispose();
    }

    pub async fn run_tick(&self) {
        self.scheduler.run_tick().await;
    }

    pub fn stats(&self) -> SchedulerStats {
        self.scheduler.stats()
    }

    /// The tick this loop runs at, in milliseconds.
    pub fn tick_period_ms(&self) -> f64 {
        self.scheduler.tick_period_ms()
    }

    /// The rows this loop reads now.
    pub fn rows(&self) -> Vec<TelemetryRow> {
        self.scheduler.current_rows()
    }

    /// Changes the tick, clamped to the transport's floor; returns the tick granted.
    pub fn set_period(&self, ms: f64) -> Result<f64, TelemetryError> {
        let granted = ms.max(self.floor_ms);
        self.scheduler.set_period(granted)?;
        Ok(granted)
    }

    /// Replaces the rows while running.
    pub fn set_rows(&self, rows: Vec<TelemetryRow>) -> Result<(), TelemetryError> {
        self.scheduler.set_rows(rows)
    }
}
