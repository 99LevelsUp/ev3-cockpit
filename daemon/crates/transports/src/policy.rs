//! Which providers a daemon may build, from the channel it serves and the mode it was started in.
//!
//! A daemon on a test channel never opens real hardware except to record, and a daemon on the
//! user's channel never runs on recordings and never records. Both are decided here, once, before
//! any provider exists.

use std::fmt;

/// Whose daemon this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    /// The user's own channel: real bricks.
    User,
    /// A channel a test or CI run opens.
    Test,
}

/// What the daemon was asked to run on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonMode {
    /// Real providers.
    Hardware,
    /// Real providers, each wrapped by the recorder.
    Record,
    /// Providers that serve a recording.
    Replay,
}

/// The providers a daemon builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSource {
    /// Real providers; `record` wraps each in the recorder.
    Hardware { record: bool },
    /// Replay providers only.
    Replay,
}

impl ProviderSource {
    /// The mode the hello tells clients: `hardware` or `replay`.
    pub fn hello_mode(self) -> &'static str {
        match self {
            Self::Hardware { .. } => "hardware",
            Self::Replay => "replay",
        }
    }

    /// Whether any provider that opens real hardware may be built.
    pub fn opens_hardware(self) -> bool {
        matches!(self, Self::Hardware { .. })
    }
}

/// A channel and mode that must not run together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError {
    pub message: String,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PolicyError {}

/// Decides which providers a daemon on `channel`, started in `mode`, builds.
///
/// A test channel replays, and opens the real hardware only to record, each provider wrapped by
/// the recorder. The user's channel runs on the hardware and never records, so nothing a person
/// does with their bricks is written down; it never replays either.
pub fn provider_source(
    channel: ChannelKind,
    mode: DaemonMode,
) -> Result<ProviderSource, PolicyError> {
    match (channel, mode) {
        (ChannelKind::User, DaemonMode::Hardware) => Ok(ProviderSource::Hardware { record: false }),
        (ChannelKind::User, DaemonMode::Record) => Err(PolicyError {
            message: "A daemon on the user's channel never records; record on a test channel (--channel <name> --mode record).".into(),
        }),
        (ChannelKind::User, DaemonMode::Replay) => Err(PolicyError {
            message: "A daemon on the user's channel never runs on recordings.".into(),
        }),
        (ChannelKind::Test, DaemonMode::Replay) => Ok(ProviderSource::Replay),
        (ChannelKind::Test, DaemonMode::Record) => Ok(ProviderSource::Hardware { record: true }),
        (ChannelKind::Test, DaemonMode::Hardware) => Err(PolicyError {
            message: "A daemon on a test channel never opens real hardware except to record; start it in replay or record mode.".into(),
        }),
    }
}
