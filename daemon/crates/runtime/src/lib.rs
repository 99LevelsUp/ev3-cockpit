//! The brick runtime: sessions, the per-brick queue and guard, bricks across channels, files,
//! programs and telemetry, and the consent and activity ports the services call.
//!
//! What is here so far: the session layer (one brick on one channel, its command queue, the
//! guard that protects the firmware, the heartbeat that notices a dead link and the reconnect
//! that brings it back), and the brick layer above it (discovery, the list of bricks with every
//! channel that reaches each, one brick signed in across its channels, and the daisy chain),
//! with the services on top: forget, clear-list and the one-sided repair; files, transfers and
//! the debt ledger; and telemetry.

pub mod bricks;
pub mod chain;
pub mod clear;
pub mod deploy;
pub mod discovery;
pub mod error;
pub mod forget;
pub mod fs;
pub mod guard;
pub mod heartbeat;
pub mod ledger;
pub mod ports;
pub mod presence;
pub mod programs;
pub mod queue;
pub mod reconnect;
pub mod repair;
pub mod session;
pub mod shell;
pub mod telemetry;
pub mod transfer;

pub use bricks::{
    BluetoothGate, BrickConfig, BrickError, BrickEvent, BrickLog, BrickManager, BrickOptions,
    CommandOptions, LinkHold, PinnedLink, TransferPacketBytes,
};
pub use chain::{ChainDepth, capabilities_of, chain_of};
pub use clear::{ClearListReport, ClearPairingSkip, ClearSkip, ClearSkipped, ClearedEntry};
pub use deploy::{
    DEPLOY_AND_RUN_BUDGET, DeployFile, DeployReport, DeployRequest, DeployServices,
    MAX_INLINE_BYTES, deploy_and_run, same_on_brick,
};
pub use discovery::{DiscoveryConfig, DiscoveryListener, DiscoveryScheduler, PresenceChange};
pub use error::SessionError;
pub use forget::{
    BrickSideOutcome, BrickSideSkip, ForgetReport, ForgetService, PairingRemoval, PeerRemoval,
    RadioName, Refused, ThisComputer,
};
pub use fs::{
    BrickFilesystem, BrickSender, CommandSender, FileSize, FilesystemService, FsError,
    MAX_PATH_BYTES, RemoveReport, StorageUsage, WriteReporter,
};
pub use guard::{Guard, GuardConfig, brick_id_of};
pub use heartbeat::{Beat, MIN_HEARTBEAT_INTERVAL, MissCounter, Probe};
pub use ledger::{
    LedgerFile, LedgerFileError, Ledgers, ReleaseScope, TransferDebt, TransferLedger,
};
pub use ports::{
    ActivityEvent, ActivityPort, ClientKind, ConsentAnswer, ConsentPort, ConsentRequest,
    ConsentSubject, Requester, WriteActivity, WriteScope,
};
pub use presence::{
    BrickChannel, BrickEntry, BrickName, ChannelEvent, ChannelMachine, ChannelSnapshot,
    ChannelState, InvalidTransition, PresenceAggregator, PresenceEvent,
};
pub use programs::{
    BrickProgramLink, DEFAULT_CONFIRM_STEP, DEFAULT_CONFIRM_TIMEOUT, EndSink, Following,
    PROGRAM_ROW_OWNER, ProgramError, ProgramFollow, ProgramLink, ProgramOptions,
    ProgramRowTelemetry, ProgramRows, ProgramService, ProgramSubscription, RowInterval,
    StartOptions, StateSink, StopMark, StopsSince, TelemetrySource,
};
pub use queue::{CommandQueue, DrainReason};
pub use reconnect::{Backoff, BackoffConfig};
pub use repair::{
    CheckConfig, OneSidedCheck, OneSidedFound, OneSidedRepair, RepairEvent, RepairRemoval,
};
pub use session::{
    ConnectionState, HeartbeatState, SessionConfig, SessionEvent, SessionManager, SessionSnapshot,
};
pub use shell::{ShellError, run_shell};
pub use telemetry::{
    ClaimRequest, ClaimTicket, DeliveryHandle, DeliveryTarget, ProgramPresetSettings, ReadMode,
    RowRate, StaleSettings, TelemetryDelivery, TelemetryError, TelemetryEvent, TelemetryHost,
    TelemetryReadModel, TelemetryService, TelemetryServiceOptions, ThrottleSettings, WallClock,
    follow_bricks,
};
pub use transfer::{
    BrickRoute, CancelFlag, DEFAULT_STALL_TIMEOUT, FileLink, FileTransferService, RouteSource,
    TransferOptions, TransferProgress,
};
