//! Telemetry rows, their schedule and the throttle.
//!
//! From the bottom up: a row is one value with its own cadence ([`row`]); the catalogue names
//! every row an EV3 offers ([`ev3_rows`], [`registry`]); the assembler packs the rows that come up
//! on a tick into one direct command and says where each result landed ([`assembler`]); the
//! scheduler runs one base tick per brick with dividers and at most one frame in flight
//! ([`scheduler`]); the brick loop sends those frames through the brick's command queue and times
//! them ([`brick_loop`]); the throttle slows a brick's tick from its round trips ([`throttle`]).
//!
//! Above them: the claims say which rows of a brick are wanted and how often ([`claims`]); the
//! service runs one loop per brick someone wants read and follows the brick layer ([`service`]);
//! the read model keeps the last value of every row and says when it went stale ([`read_model`]);
//! the delivery tells every subscription its snapshot and changes in one order ([`delivery`]).

pub mod assembler;
pub mod brick_loop;
pub mod cadence;
pub mod claims;
pub mod clock;
pub mod delivery;
mod dispatch;
pub mod error;
pub mod ev3_rows;
pub mod port_state;
pub mod read_model;
pub mod registry;
pub mod row;
pub mod scheduler;
pub mod service;
pub mod settings;
pub mod throttle;

pub use assembler::{AssembledFrame, FrameLimits, PlacedRow};
pub use brick_loop::{BrickTelemetry, BrickTelemetryOptions, TelemetrySender};
pub use cadence::{Cadence, cadence_for, typical_round_trip_ms};
pub use claims::{ClaimRequest, Grant, RowRate};
pub use clock::WallClock;
pub use delivery::{DeliveryHandle, DeliveryTarget, TelemetryDelivery};
pub use error::TelemetryError;
pub use port_state::{PortState, port_state_of};
pub use read_model::{ReadModelChange, ReadValue, TelemetryReadModel, chain_depth_of};
pub use registry::{RowRegistry, ev3_row_registry};
pub use row::{Lifetime, Reading, RowCodec, RowValue, TelemetryRow, Tier};
pub use scheduler::{FrameLink, SchedulerOptions, SchedulerStats, TelemetryScheduler};
pub use service::{
    BrickThrottleState, ClaimTicket, Intervals, ReadMode, TelemetryEvent, TelemetryHost,
    TelemetryService, TelemetryServiceOptions, follow_bricks,
};
pub use settings::{ProgramPresetSettings, StaleSettings, ThrottleSettings};
pub use throttle::{ThrottleState, TickThrottle};
