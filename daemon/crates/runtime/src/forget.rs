//! Forgetting a brick on this computer and on the brick, after a person said yes.
//!
//! A forget runs every part even when one fails, and reports each part's outcome: a brick that is
//! half forgotten and says so is better than one whose pairing survived because the brick side
//! timed out. In order:
//!
//! 1. ask a person, naming the client that asked; anything but a yes changes nothing;
//! 2. hold the brick's links, so nothing opens, reopens or probes a link to it meanwhile;
//! 3. remove this computer's entry from the brick's own Bluetooth list, over a live channel when
//!    there is one, and prove it by reading the list back;
//! 4. sign the brick out, which closes every channel, the one opened for step 3 too;
//! 5. have each channel's provider forget it where the provider can: the operating-system pairing;
//! 6. clear the cockpit's memory of it: discovery's tracking first, then the list;
//! 7. lift the hold and start a scan, so a brick still in reach comes back as a stranger. The
//!    report does not wait for it: a scan can hang in the operating system.
//!
//! Outcomes carry codes and the raw error text, not sentences: the wording belongs to the client
//! that shows them. The same module holds what clearing a brick's list and the one-sided repair
//! share with a forget: reading the brick's list, removing one entry from it, and forgetting one
//! channel's pairing.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::num::NonZeroU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use ev3_protocol::{BrickCommand, BrickResponse, ProtocolError};
use ev3_transports::{BrickKey, ForgetResidue, Transport};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};

use crate::bricks::{BrickLog, BrickManager};
use crate::error::SessionError;
use crate::guard::brick_id_of;
use crate::ports::{ConsentAnswer, ConsentPort, ConsentRequest, ConsentSubject, Requester};
use crate::presence::ChannelState;
use crate::repair::OneSidedCheck;
use crate::session::{ConnectionState, SessionManager};

// ── Reports ─────────────────────────────────────────────────────────

/// How one removal from a brick's Bluetooth list ended.
///
/// Only a list read back afterwards proves anything: the firmware's handler sets no status
/// (`c_com.c` 5567-5606), so its reply says only that the brick answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerRemoval {
    /// The list read back afterwards holds one entry of that name fewer. The firmware removes only
    /// the first entry whose name matches (`c_bt.c` 2215, 3603-3622), so a brick that held the name
    /// twice still holds it once: `remaining` counts those left, `None` when none is.
    Confirmed {
        name: String,
        over: BrickKey,
        remaining: Option<NonZeroU64>,
    },
    /// Sent, and nothing shows whether it took: the removal cut the Bluetooth link it went over
    /// before any reply (`c_bt.c` 3609-3612), the reply timed out, or the list could not be read
    /// back. `detail` is the error that ended it.
    Sent {
        name: String,
        over: BrickKey,
        detail: String,
    },
    /// The list read back holds as many entries of that name as before — the firmware runs a
    /// removal only while its Bluetooth is on and idle (`c_bt.c` 3594-3656) — or the command was
    /// refused or rejected before it could run.
    Failed {
        name: String,
        over: BrickKey,
        detail: String,
    },
}

impl PeerRemoval {
    pub fn confirmed(&self) -> bool {
        matches!(self, Self::Confirmed { .. })
    }
}

/// Why nothing was removed from the brick's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrickSideSkip {
    /// This computer's Bluetooth name is unknown, and it is the only key to its entry.
    RadioNameUnknown,
    /// No channel to the brick was connected, and none could be opened.
    NotReachable,
    /// The brick's list could not be read.
    ListUnreadable,
    /// The list holds no entry named exactly as this computer; the report's `peers` has the names.
    NoMatch,
}

/// This computer's entry on the brick's own Bluetooth list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrickSideOutcome {
    Removal(PeerRemoval),
    Skipped {
        reason: BrickSideSkip,
        detail: Option<String>,
    },
}

/// One channel's operating-system pairing. Only channels whose provider can forget get one, so a
/// brick known over USB alone has none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingRemoval {
    /// Removed, or already gone, which counts as removed.
    Removed { channel: BrickKey },
    /// The provider refused; `reason` carries the operating system's own words.
    Refused { channel: BrickKey, reason: String },
}

impl PairingRemoval {
    pub fn removed(&self) -> bool {
        matches!(self, Self::Removed { .. })
    }
}

/// What forgetting a brick did, part by part.
///
/// The cockpit's own memory of the brick (discovery's tracking and the list) cannot fail to clear
/// here, so the report carries no outcome for it; the contract's is always `cleared`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetReport {
    pub brick_id: String,
    pub brick_side: BrickSideOutcome,
    /// The names on the brick's Bluetooth list as read before any removal, untrimmed; `None` when
    /// the list was not read.
    pub peers: Option<Vec<String>>,
    /// The pairing of every channel whose provider can forget.
    pub pairing: Vec<PairingRemoval>,
    /// What the providers said they left behind, exactly as they returned it.
    pub residue: Vec<ForgetResidue>,
}

/// Why a destructive operation did not run. Nothing was changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// The person said no.
    Declined,
    /// Nobody answered: no person could be asked, or nobody replied in time. Not consent.
    Unanswered,
    /// The brick is being forgotten or its list cleared already.
    Busy { brick_id: String },
}

impl Refused {
    fn from_answer(answer: ConsentAnswer) -> Option<Self> {
        match answer {
            ConsentAnswer::Granted => None,
            ConsentAnswer::Declined => Some(Self::Declined),
            ConsentAnswer::Unanswered => Some(Self::Unanswered),
        }
    }
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Declined => f.write_str("Nothing was changed: the person said no."),
            Self::Unanswered => {
                f.write_str("Nothing was changed: it needs a person's yes, and nobody answered.")
            }
            Self::Busy { brick_id } => write!(
                f,
                "Brick {brick_id} is being forgotten or its Bluetooth list cleared already."
            ),
        }
    }
}

impl std::error::Error for Refused {}

// ── Mapping onto the contract ───────────────────────────────────────

pub(crate) fn residue_to_contract(residue: &[ForgetResidue]) -> Vec<ev3_contract::ForgetResidue> {
    residue
        .iter()
        .map(|r| ev3_contract::ForgetResidue {
            location: r.location.clone(),
            reason: r.reason.clone(),
        })
        .collect()
}

impl PairingRemoval {
    pub fn to_contract(&self) -> ev3_contract::PairingRemoval {
        match self {
            Self::Removed { channel } => ev3_contract::PairingRemoval::Removed {
                channel: channel.as_str().to_owned(),
            },
            Self::Refused { channel, reason } => ev3_contract::PairingRemoval::Refused {
                channel: channel.as_str().to_owned(),
                reason: reason.clone(),
            },
        }
    }
}

impl BrickSideOutcome {
    pub fn to_contract(&self) -> ev3_contract::BrickSideOutcome {
        use ev3_contract::BrickSideOutcome as Out;
        match self {
            Self::Removal(PeerRemoval::Confirmed {
                name,
                over,
                remaining,
            }) => Out::Confirmed {
                name: name.clone(),
                over: over.as_str().to_owned(),
                remaining: *remaining,
            },
            Self::Removal(PeerRemoval::Sent { name, over, detail }) => Out::Sent {
                name: name.clone(),
                over: over.as_str().to_owned(),
                detail: detail.clone(),
            },
            Self::Removal(PeerRemoval::Failed { name, over, detail }) => Out::Failed {
                name: name.clone(),
                over: over.as_str().to_owned(),
                detail: detail.clone(),
            },
            Self::Skipped { reason, detail } => Out::Skipped {
                reason: match reason {
                    BrickSideSkip::RadioNameUnknown => {
                        ev3_contract::BrickSideSkip::RadioNameUnknown
                    }
                    BrickSideSkip::NotReachable => ev3_contract::BrickSideSkip::NotReachable,
                    BrickSideSkip::ListUnreadable => ev3_contract::BrickSideSkip::ListUnreadable,
                    BrickSideSkip::NoMatch => ev3_contract::BrickSideSkip::NoMatch,
                },
                detail: detail.clone(),
            },
        }
    }
}

impl ForgetReport {
    pub fn to_contract(&self) -> ev3_contract::ForgetReport {
        ev3_contract::ForgetReport {
            brick_id: self.brick_id.clone(),
            brick_side: self.brick_side.to_contract(),
            memory: ev3_contract::MemoryOutcome::Cleared,
            pairing: self
                .pairing
                .iter()
                .map(PairingRemoval::to_contract)
                .collect(),
            peers: self.peers.clone().unwrap_or_default(),
            residue: residue_to_contract(&self.residue),
        }
    }
}

// ── This computer's Bluetooth name ──────────────────────────────────

/// Reads this computer's Bluetooth name: the only key to its entry on a brick, which knows this
/// computer by nothing else. `None` when it cannot be read, whatever the reason.
///
/// The daemon answers from its Bluetooth provider (Windows reads it on a thread of its own, BlueZ
/// from the adapter's alias).
#[async_trait]
pub trait RadioName: Send + Sync {
    async fn radio_name(&self) -> Option<String>;
}

/// This computer's Bluetooth name, read through [`RadioName`], shared by the forget, the clear and
/// the one-sided check so the warning below is said once.
pub struct ThisComputer {
    port: Arc<dyn RadioName>,
    log: Option<Arc<dyn BrickLog>>,
    said_default: AtomicBool,
}

impl ThisComputer {
    pub fn new(port: Arc<dyn RadioName>, log: Option<Arc<dyn BrickLog>>) -> Arc<Self> {
        Arc::new(Self {
            port,
            log,
            said_default: AtomicBool::new(false),
        })
    }

    /// The name; `None` when it cannot be read or is empty.
    ///
    /// BlueZ names an adapter nobody named "BlueZ 5.82", the same on every Linux computer with that
    /// BlueZ, so a brick cannot tell them apart and the entry taken for this computer may be
    /// another's: said once in the log, with the fix.
    pub async fn name(&self) -> Option<String> {
        let name = self.port.radio_name().await.filter(|n| !n.is_empty())?;
        if is_bluez_default(&name)
            && !self.said_default.swap(true, Ordering::Relaxed)
            && let Some(log) = &self.log
        {
            log.warn(&format!(
                "This computer's Bluetooth name is BlueZ's default, \"{name}\", which every \
                 Linux computer with this BlueZ shares: a brick cannot tell them apart, so the \
                 entry taken for this computer may be another's. Give the adapter a name of its \
                 own: bluetoothctl system-alias <name>."
            ));
        }
        Some(name)
    }
}

/// `BlueZ 5.82`: BlueZ's name for an adapter nobody named.
fn is_bluez_default(name: &str) -> bool {
    let Some(version) = name.strip_prefix("BlueZ ") else {
        return false;
    };
    !version.is_empty()
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

// ── The brick's list, shared by forget, clear and the repair ────────

/// One entry of the brick's Bluetooth list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Peer {
    /// Exactly as the brick stores it, cut at its terminator and untrimmed.
    pub name: String,
    /// The brick holds a link to this peer now (`c_bt.c` 3566).
    pub connected: bool,
}

pub(crate) fn names_of(peers: &[Peer]) -> Vec<String> {
    peers.iter().map(|p| p.name.clone()).collect()
}

/// How many entries carry exactly `name`; the brick tells entries apart by nothing else.
pub(crate) fn count_of(names: &[String], name: &str) -> usize {
    names.iter().filter(|n| n.as_str() == name).count()
}

/// The brick's Bluetooth list over one channel's session: the count, then each index below it,
/// because the firmware does not bounds-check the index (`c_bt.c` 3561-3567).
///
/// Through the session, not the brick layer, so a failure here is not a failover.
pub(crate) async fn read_peers(
    sessions: &SessionManager,
    key: &BrickKey,
) -> Result<Vec<Peer>, SessionError> {
    let count = match sessions
        .send(key, &BrickCommand::BluetoothPeerCount, None)
        .await?
    {
        BrickResponse::BluetoothPeerCount { count } => count,
        other => {
            return Err(SessionError::Protocol(ProtocolError::new(format!(
                "Expected the Bluetooth peer count, got {other:?}."
            ))));
        }
    };
    let mut peers = Vec::with_capacity(usize::from(count));
    for index in 0..count {
        match sessions
            .send(key, &BrickCommand::BluetoothPeer { index }, None)
            .await?
        {
            BrickResponse::BluetoothPeer {
                name, connected, ..
            } => peers.push(Peer { name, connected }),
            other => {
                return Err(SessionError::Protocol(ProtocolError::new(format!(
                    "Expected Bluetooth peer {index}, got {other:?}."
                ))));
            }
        }
    }
    Ok(peers)
}

/// Whether a failed command was refused before it left: nothing reached the brick.
///
/// Only a failed link (`Transport`) may have carried the command; a reply that could not be read
/// (`Protocol`) means the brick rejected it.
pub(crate) fn never_sent(error: &SessionError) -> bool {
    !matches!(
        error,
        SessionError::Transport(_) | SessionError::Protocol(_)
    )
}

/// Every channel the list or a session holds for a brick.
pub(crate) fn channel_keys_of(bricks: &BrickManager, brick_id: &str) -> Vec<BrickKey> {
    let mut keys: Vec<BrickKey> = bricks
        .aggregator()
        .brick(brick_id)
        .map(|entry| entry.channels.into_iter().map(|c| c.brick_key).collect())
        .unwrap_or_default();
    for session in bricks.sessions().sessions() {
        if brick_id_of(&session.brick_key) == brick_id && !keys.contains(&session.brick_key) {
            keys.push(session.brick_key);
        }
    }
    keys
}

/// How strongly the brick's list prefers a channel: Bluetooth last, below what the providers'
/// priorities say, because only a channel the removal does not cut can read the list back and
/// confirm it. The same order holds among connected channels, so a brick connected over TCP and
/// Bluetooth is changed over TCP although its traffic goes over Bluetooth.
fn peer_list_rank(bricks: &BrickManager, key: &BrickKey) -> i32 {
    let transport = key.transport();
    let base = if transport == Transport::Bt { 0 } else { 1000 };
    base + bricks.aggregator().scheduler().priority_of(transport)
}

fn best_for_peer_list(bricks: &BrickManager, keys: Vec<BrickKey>) -> Option<BrickKey> {
    keys.into_iter().max_by(|a, b| {
        peer_list_rank(bricks, a)
            .cmp(&peer_list_rank(bricks, b))
            .then_with(|| b.cmp(a))
    })
}

/// The connected channel the brick's list is read and changed over.
pub(crate) fn connected_peer_list_channel(
    bricks: &BrickManager,
    brick_id: &str,
) -> Option<BrickKey> {
    let connected = bricks
        .sessions()
        .sessions()
        .into_iter()
        .filter(|s| {
            brick_id_of(&s.brick_key) == brick_id
                && s.connection_state == ConnectionState::Connected
        })
        .map(|s| s.brick_key)
        .collect();
    best_for_peer_list(bricks, connected)
}

/// The channel the list is read and changed over, and whether it was opened for that.
pub(crate) struct PeerListChannel {
    pub key: Option<BrickKey>,
    /// Why the channel tried could not be opened.
    pub failure: Option<String>,
    /// Opened here, so whoever asked closes it when done.
    pub opened: bool,
}

/// A connected channel if there is one, otherwise the best available one, opened for this alone
/// through the session manager — not through a sign-in, which would join every available channel.
///
/// Without one available, a paired Bluetooth channel the presence checks did not hear is tried as
/// well: the checks miss bricks right next to the computer, and a brick that is there should lose
/// this computer's entry too. A brick that is really off costs one failed connect, and the report
/// says why. A Bluetooth channel nobody has paired is a sighting, not a link, and is never opened.
pub(crate) async fn peer_list_channel(bricks: &BrickManager, brick_id: &str) -> PeerListChannel {
    if let Some(key) = connected_peer_list_channel(bricks, brick_id) {
        return PeerListChannel {
            key: Some(key),
            failure: None,
            opened: false,
        };
    }
    let none = PeerListChannel {
        key: None,
        failure: None,
        opened: false,
    };
    let Some(entry) = bricks.aggregator().brick(brick_id) else {
        return none;
    };
    let sessions = bricks.sessions();
    let available: Vec<BrickKey> = entry
        .channels
        .iter()
        .filter(|c| {
            c.state == ChannelState::Available && (c.transport != Transport::Bt || entry.paired)
        })
        .map(|c| c.brick_key.clone())
        .filter(|key| sessions.session(key).is_none())
        .collect();
    let unheard = entry.channel(Transport::Bt).and_then(|bt| {
        (entry.paired
            && bt.state == ChannelState::Lost
            && sessions.session(&bt.brick_key).is_none())
        .then(|| bt.brick_key.clone())
    });
    let Some(key) = best_for_peer_list(bricks, available).or(unheard) else {
        return none;
    };
    match sessions.connect(&key, Some(&entry.name.value)).await {
        Ok(()) => PeerListChannel {
            key: Some(key),
            failure: None,
            opened: true,
        },
        Err(error) => PeerListChannel {
            key: None,
            failure: Some(error.to_string()),
            opened: false,
        },
    }
}

/// Closes every Bluetooth session of a brick explicitly, so the session manager reopens none.
pub(crate) async fn close_bluetooth_sessions(bricks: &BrickManager, brick_id: &str) {
    let sessions = bricks.sessions();
    let keys: Vec<BrickKey> = sessions
        .sessions()
        .into_iter()
        .map(|s| s.brick_key)
        .filter(|key| brick_id_of(key) == brick_id && key.transport() == Transport::Bt)
        .collect();
    for key in keys {
        sessions.disconnect(&key, true).await;
    }
}

/// Removes one entry from the brick's list over `key`, and finds out whether it went.
///
/// Over USB or TCP the brick's Bluetooth sessions are closed first, explicitly: the removal cuts
/// the link of the peer it removes (`c_bt.c` 3609-3612), and the session manager would otherwise
/// reconnect it to a brick that has just dropped this computer. Over Bluetooth the removal is the
/// last command on its link, so a drop or a timeout is all that comes back and it counts as sent.
/// A normal reply means the firmware did not run it, or did: the list read back says which.
///
/// Sent once, with the normal timeout, through the session rather than the brick layer, so a
/// failure here is not a failover. The brick's VM waits on its Bluetooth stack while it removes; a
/// retry would only wait again.
///
/// `held` is how many entries carried the name in the list read before. The read-back is judged
/// by count, not by whether the name is still there: one fewer is confirmed, and any still held
/// under the name are reported as remaining.
pub(crate) async fn remove_peer(
    bricks: &BrickManager,
    brick_id: &str,
    key: &BrickKey,
    name: &str,
    held: usize,
) -> PeerRemoval {
    if key.transport() != Transport::Bt {
        close_bluetooth_sessions(bricks, brick_id).await;
    }
    let sessions = bricks.sessions();
    let command = BrickCommand::RemoveBluetoothPeer {
        name: name.to_owned(),
    };
    if let Err(error) = sessions.send(key, &command, None).await {
        // Refused before it left: it never ran. A failed link may have carried it first.
        let detail = error.to_string();
        return if matches!(error, SessionError::Transport(_)) {
            PeerRemoval::Sent {
                name: name.to_owned(),
                over: key.clone(),
                detail,
            }
        } else {
            PeerRemoval::Failed {
                name: name.to_owned(),
                over: key.clone(),
                detail,
            }
        };
    }
    let after = match read_peers(sessions, key).await {
        Ok(peers) => names_of(&peers),
        Err(error) => {
            return PeerRemoval::Sent {
                name: name.to_owned(),
                over: key.clone(),
                detail: error.to_string(),
            };
        }
    };
    let remaining = count_of(&after, name);
    if remaining >= held {
        return PeerRemoval::Failed {
            name: name.to_owned(),
            over: key.clone(),
            detail: "The list read back still holds the entry.".to_owned(),
        };
    }
    PeerRemoval::Confirmed {
        name: name.to_owned(),
        over: key.clone(),
        remaining: NonZeroU64::new(remaining as u64),
    }
}

/// Each channel's provider forgets the brick where it can. One provider at a time; a refusal is
/// recorded with the provider's reason and the next still runs.
pub(crate) async fn forget_pairings(
    bricks: &BrickManager,
    keys: &[BrickKey],
) -> (Vec<PairingRemoval>, Vec<ForgetResidue>) {
    let mut pairing = Vec::new();
    let mut residue = Vec::new();
    let scheduler = bricks.aggregator().scheduler();
    for key in keys {
        let Some(provider) = scheduler.provider(key.transport()) else {
            continue;
        };
        if !provider.capabilities().supports_forget {
            continue;
        }
        match provider.forget(key).await {
            Ok(left) => {
                residue.extend(left);
                pairing.push(PairingRemoval::Removed {
                    channel: key.clone(),
                });
            }
            Err(error) => pairing.push(PairingRemoval::Refused {
                channel: key.clone(),
                reason: error.message,
            }),
        }
    }
    (pairing, residue)
}

/// Forgets the brick's Bluetooth channel and keeps the brick: the pairing through the provider,
/// then the cockpit's memory of that channel alone. A scan in flight read the system's list before
/// the unpair; discovery drops what it lists for the channel.
pub(crate) async fn forget_bluetooth_channel(
    bricks: &BrickManager,
    brick_id: &str,
    bt_key: &BrickKey,
) -> (Vec<PairingRemoval>, Vec<ForgetResidue>) {
    close_bluetooth_sessions(bricks, brick_id).await;
    let forgotten = forget_pairings(bricks, std::slice::from_ref(bt_key)).await;
    bricks
        .aggregator()
        .scheduler()
        .forget(std::slice::from_ref(bt_key));
    bricks.aggregator().forget_channel(bt_key);
    forgotten
}

/// The brick's name as the list has it, or its id, for the log and the questions.
pub(crate) fn brick_label(bricks: &BrickManager, brick_id: &str) -> String {
    bricks
        .aggregator()
        .brick(brick_id)
        .map_or_else(|| brick_id.to_owned(), |entry| entry.name.value)
}

// ── The service ─────────────────────────────────────────────────────

type RunningForget = Shared<BoxFuture<'static, ForgetReport>>;

#[derive(Default)]
pub(crate) struct ForgetState {
    /// The forget running for each brick, so a second call joins it rather than running a second
    /// one, whose end would lift the hold while the first still works.
    forgets: HashMap<String, RunningForget>,
    /// Bricks whose list is being cleared, so a second clear is refused rather than interleaved.
    pub(crate) clearing: HashSet<String>,
}

impl ForgetState {
    pub(crate) fn forgetting(&self, brick_id: &str) -> bool {
        self.forgets.contains_key(brick_id)
    }
}

pub(crate) struct ForgetInner {
    pub(crate) bricks: BrickManager,
    pub(crate) consent: Arc<dyn ConsentPort>,
    pub(crate) computer: Arc<ThisComputer>,
    pub(crate) check: Option<OneSidedCheck>,
    state: Mutex<ForgetState>,
}

impl ForgetInner {
    pub(crate) fn lock(&self) -> MutexGuard<'_, ForgetState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks a person about `action` on the brick, for `requester`.
    pub(crate) async fn ask(
        &self,
        requester: &Requester,
        brick_id: &str,
        action: String,
        subject: ConsentSubject,
    ) -> ConsentAnswer {
        let brick_key = channel_keys_of(&self.bricks, brick_id).into_iter().next();
        self.consent
            .ask(ConsentRequest {
                requester: requester.clone(),
                brick_key,
                action,
                subject,
            })
            .await
    }
}

/// Forgetting a brick and clearing its Bluetooth list: the destructive brick operations, each run
/// only after a person said yes through the consent port. Cheap to clone; clones share the state.
#[derive(Clone)]
pub struct ForgetService {
    pub(crate) inner: Arc<ForgetInner>,
}

impl ForgetService {
    /// `check`, when the one-sided check runs, is told when a forget or a clear starts, so it
    /// neither checks nor repairs a brick whose pairing they are about to change.
    pub fn new(
        bricks: BrickManager,
        consent: Arc<dyn ConsentPort>,
        computer: Arc<ThisComputer>,
        check: Option<OneSidedCheck>,
    ) -> Self {
        Self {
            inner: Arc::new(ForgetInner {
                bricks,
                consent,
                computer,
                check,
                state: Mutex::new(ForgetState::default()),
            }),
        }
    }

    /// Whether the brick is being forgotten or its list cleared now.
    pub fn is_busy(&self, brick_id: &str) -> bool {
        let state = self.inner.lock();
        state.forgets.contains_key(brick_id) || state.clearing.contains(brick_id)
    }

    /// Makes this computer forget a brick on every channel, after asking a person for `requester`.
    ///
    /// Anything but a yes changes nothing. Every call is asked about, naming its own client; one
    /// that gets its yes while a forget of the brick runs joins it and gets the same report, rather
    /// than a second run whose end would lift the hold while the first still works. Runs to its
    /// end on a task of its own once the person said yes, so a caller that goes away does not
    /// leave the brick side removed and the pairing standing.
    pub async fn forget(
        &self,
        brick_id: &str,
        requester: &Requester,
    ) -> Result<ForgetReport, Refused> {
        let name = brick_label(&self.inner.bricks, brick_id);
        let answer = self
            .inner
            .ask(
                requester,
                brick_id,
                format!(
                    "Forget {name}? This computer and the brick both drop their pairing; pairing \
                     again needs someone at the brick."
                ),
                ConsentSubject::Forget {
                    brick_id: brick_id.to_owned(),
                },
            )
            .await;
        if let Some(refused) = Refused::from_answer(answer) {
            return Err(refused);
        }
        let running = {
            let mut state = self.inner.lock();
            state
                .forgets
                .entry(brick_id.to_owned())
                .or_insert_with(|| {
                    let inner = self.inner.clone();
                    let brick = brick_id.to_owned();
                    let task = tokio::spawn(async move {
                        let report = inner.run_forget(&brick).await;
                        inner.lock().forgets.remove(&brick);
                        report
                    });
                    // Ends only by finishing: the runtime cancels its tasks at shutdown alone.
                    async move { task.await.expect("a forget runs to its end") }
                        .boxed()
                        .shared()
                })
                .clone()
        };
        Ok(running.await)
    }
}

impl ForgetInner {
    async fn run_forget(&self, brick_id: &str) -> ForgetReport {
        let bricks = &self.bricks;
        let hold = bricks.hold_links(brick_id);
        // What a forget reads is not checked: it is about to change both halves.
        if let Some(check) = &self.check {
            check.suspend(brick_id);
        }
        // Read before anything is forgotten: the list is where the channels come from, and the
        // last step deletes it.
        let keys = channel_keys_of(bricks, brick_id);
        let (brick_side, peers) = self.remove_own_entry(brick_id).await;
        bricks.sign_out(brick_id).await;
        let (pairing, residue) = forget_pairings(bricks, &keys).await;
        // In one block, discovery before the list, which a scan rebuilds from it: an await between
        // them would let a scan land in the gap and rebuild the brick from what discovery tracks.
        bricks.aggregator().scheduler().forget(&keys);
        bricks.aggregator().forget(brick_id);
        if let Some(check) = &self.check {
            check.forgotten(brick_id);
        }
        drop(hold);
        // Not awaited: the report does not depend on it, and a scan can hang in the operating
        // system.
        let scheduler = bricks.aggregator().scheduler().clone();
        tokio::spawn(async move { scheduler.scan_once().await });
        ForgetReport {
            brick_id: brick_id.to_owned(),
            brick_side,
            peers,
            pairing,
            residue,
        }
    }

    /// Removes this computer's entry from the brick's Bluetooth list.
    ///
    /// The entry is found by an exact match on this computer's radio name, the name the brick
    /// stored it under and compares with `strcmp` (`c_bt.c` 2215). No name, no channel, no list or
    /// no match: nothing is sent, and the outcome says which.
    async fn remove_own_entry(&self, brick_id: &str) -> (BrickSideOutcome, Option<Vec<String>>) {
        let skipped = |reason, detail| BrickSideOutcome::Skipped { reason, detail };
        let Some(name) = self.computer.name().await else {
            return (skipped(BrickSideSkip::RadioNameUnknown, None), None);
        };
        let channel = peer_list_channel(&self.bricks, brick_id).await;
        let Some(key) = channel.key else {
            return (skipped(BrickSideSkip::NotReachable, channel.failure), None);
        };
        let peers = match read_peers(self.bricks.sessions(), &key).await {
            Ok(peers) => names_of(&peers),
            Err(error) => {
                return (
                    skipped(BrickSideSkip::ListUnreadable, Some(error.to_string())),
                    None,
                );
            }
        };
        let held = count_of(&peers, &name);
        if held == 0 {
            return (skipped(BrickSideSkip::NoMatch, None), Some(peers));
        }
        let removal = remove_peer(&self.bricks, brick_id, &key, &name, held).await;
        (BrickSideOutcome::Removal(removal), Some(peers))
    }
}
