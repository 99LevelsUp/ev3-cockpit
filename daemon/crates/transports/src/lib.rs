//! Transports to the brick: the provider trait every link implements, the exchange machinery
//! the links share, and record and replay at the provider level.
//!
//! A provider carries bytes and knows nothing about what a command means; the command layer
//! above owns the codec. Record and replay sit at the provider trait, so a recorded session
//! stands in for the hardware without anything above the providers noticing.

pub mod brick_key;
pub mod bt;
#[cfg(target_os = "linux")]
pub mod bt_linux;
#[cfg(windows)]
pub mod bt_windows;
pub mod error;
pub mod fixture;
pub mod pending;
pub mod policy;
pub mod provider;
pub mod recorder;
pub mod replay;
pub mod scrub;
pub mod tcp;
pub mod usb;

pub use brick_key::{BrickKey, Transport};
pub use error::{ErrorCode, TransportError};
pub use pending::{Exchanger, LinkIo, MAX_STALE_REPLIES, MessageCounter};
pub use policy::{ChannelKind, DaemonMode, PolicyError, ProviderSource, provider_source};
pub use provider::{
    DiscoveryItem, DiscoveryScanResult, ForgetResidue, NameSource, PairingOutcome, PresenceState,
    ProbeLink, SendOptions, SessionHandle, SignalInfo, SignalStrength, TransportCapabilities,
    TransportProvider,
};
pub use recorder::Recorder;
pub use replay::{FixtureError, Replay, ReplayMode};
pub use scrub::{ScrubError, Scrubber};
