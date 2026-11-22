//! The two ports the runtime owns and the services call: asking a person, and reporting writes.
//!
//! Every dangerous action is confirmed by a person the daemon asks; a flag a client sets is not
//! consent. The runtime defines the questions and the reports; the daemon answers and shows them
//! (a dialog in the editor, a prompt in a terminal), and lower layers' tests answer with fakes.

use std::sync::Arc;

use async_trait::async_trait;
use ev3_transports::BrickKey;

pub use ev3_contract::ClientKind;

/// The client an action is done for, as the person being asked sees it named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requester {
    /// The client's own name, as it introduced itself to the daemon.
    pub name: String,
    pub kind: ClientKind,
    /// Which connection the client is, as the daemon numbers them; `None` outside the daemon.
    /// Names are not unique, so only this tells two clients of the same name apart.
    pub connection: Option<u64>,
}

/// What a question is about, with what the person is shown besides the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsentSubject {
    /// Forget a brick on this computer and on the brick.
    Forget { brick_id: String },
    /// Remove these entries from a brick's own Bluetooth list.
    ClearBluetoothList {
        brick_id: String,
        entries: Vec<String>,
        /// This computer's own entry is among them, so its pairing with the brick ends too.
        includes_this_computer: bool,
        /// This computer's Bluetooth name, when known.
        this_computer: Option<String>,
    },
    /// Release transfer slots a cut transfer left taken on a brick.
    ReleaseSlots { brick_id: String },
}

/// One question to a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentRequest {
    pub requester: Requester,
    /// The brick the action touches; `None` for an action on this computer alone.
    pub brick_key: Option<BrickKey>,
    /// The action, in the words the person reads.
    pub action: String,
    pub subject: ConsentSubject,
}

/// How a question ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentAnswer {
    Granted,
    Declined,
    /// Nobody answered: no person could be asked, or nobody replied in time. Not consent.
    Unanswered,
}

impl ConsentAnswer {
    /// Only an explicit yes lets the action go ahead.
    pub fn granted(self) -> bool {
        self == Self::Granted
    }
}

/// Asks a person whether an action may go ahead.
#[async_trait]
pub trait ConsentPort: Send + Sync {
    async fn ask(&self, request: ConsentRequest) -> ConsentAnswer;
}

/// A write to a brick, as it is reported while it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteActivity {
    pub brick_key: BrickKey,
    pub requester: Requester,
    /// What is being written, in the words a person reads.
    pub what: String,
}

/// A write starting or ending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityEvent {
    WriteStarted(WriteActivity),
    WriteEnded(WriteActivity),
}

/// Hears about writes as they start and end.
///
/// Synchronous on purpose: reporting must not hold up the write, and a report made while a write
/// is being abandoned cannot wait for anything.
pub trait ActivityPort: Send + Sync {
    fn report(&self, event: ActivityEvent);
}

/// A write in progress: reports its start when made and its end when dropped.
///
/// Dropped, not closed by hand, so a write that fails or whose caller abandons it still reports
/// its end; a start with no end would show the brick being written to for good.
pub struct WriteScope {
    port: Arc<dyn ActivityPort>,
    activity: WriteActivity,
}

impl WriteScope {
    pub fn begin(port: Arc<dyn ActivityPort>, activity: WriteActivity) -> Self {
        port.report(ActivityEvent::WriteStarted(activity.clone()));
        Self { port, activity }
    }

    pub fn activity(&self) -> &WriteActivity {
        &self.activity
    }
}

impl Drop for WriteScope {
    fn drop(&mut self) {
        self.port
            .report(ActivityEvent::WriteEnded(self.activity.clone()));
    }
}
