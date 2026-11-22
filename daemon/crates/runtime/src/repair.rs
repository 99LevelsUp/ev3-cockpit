//! The one-sided pairing repair, once per connect.
//!
//! A pairing can break on one side: this computer still has the brick paired and the brick's list
//! lost this computer, or the brick still lists this computer and this computer forgot the brick.
//! A Bluetooth connect over such a pairing only fails, after holding the radio for 15 s, which on
//! hardware starved the repair's own pairing. So while a USB or TCP channel of a signed-in brick
//! is connected, the brick's list is read over it and compared, by this computer's exact
//! Bluetooth name, with this computer's pairing as discovery tracks it; the brick's Bluetooth joins
//! wait for that check ([`BluetoothGate`]). The half that is left is removed and the brick paired
//! again: the brick's own dialog is the consent, so nobody is asked first. What was found and done
//! is reported afterwards.
//!
//! Once per connect: a brick repaired since the person last connected it is only reported when it
//! looks one-sided again, because a brick that stores this computer under a name that is not
//! byte-exact looks one-sided after every repair. A brick whose pairing was cancelled on it, or
//! that was forgotten or had its list cleared, is suspended until it is connected again: the check
//! only says so in the log.
//!
//! A list read over Bluetooth is never checked: a removal over the Bluetooth link would cut the
//! link it goes over.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ev3_protocol::commands::is_blank_peer_name;
use ev3_transports::{BrickKey, PairingOutcome, PresenceState, Transport};
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

use crate::bricks::{BluetoothGate, BrickLog, BrickManager};
use crate::forget::{
    PairingRemoval, Peer, PeerRemoval, ThisComputer, brick_label, count_of,
    forget_bluetooth_channel, names_of, read_peers, remove_peer,
};
use crate::guard::brick_id_of;
use crate::session::ConnectionState;

// ── Reports ─────────────────────────────────────────────────────────

/// Which half of the pairing is left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OneSidedFound {
    /// This computer has the brick paired, and the brick's list lacks this computer's name.
    ComputerOnly,
    /// The brick lists this computer, and this computer does not have it paired.
    BrickOnly,
}

/// The half the repair removed: this computer's pairing, or this computer's entry on the brick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepairRemoval {
    Pairing(PairingRemoval),
    Entry(PeerRemoval),
}

impl RepairRemoval {
    fn took(&self) -> bool {
        match self {
            Self::Pairing(pairing) => pairing.removed(),
            Self::Entry(entry) => entry.confirmed(),
        }
    }
}

/// A pairing found broken on one side over USB or TCP, and what was done about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OneSidedRepair {
    pub brick_id: String,
    pub found: OneSidedFound,
    /// The half removed; `None` when `repeated`.
    pub removal: Option<RepairRemoval>,
    /// The brick's other named entries, which clearing the brick's Bluetooth list removes with the
    /// rest.
    pub others: Vec<String>,
    /// Found again after a repair since the brick was last connected: reported, and nothing done.
    pub repeated: bool,
    /// The brick is being paired again: the removal took, and the brick stayed signed in.
    pub pairing_again: bool,
}

impl OneSidedRepair {
    pub fn to_contract(&self) -> ev3_contract::OneSidedRepair {
        use ev3_contract::RepairRemoval as Out;
        let removal = self.removal.as_ref().map(|removal| match removal {
            RepairRemoval::Pairing(PairingRemoval::Removed { channel }) => Out::Removed {
                channel: channel.as_str().to_owned(),
            },
            RepairRemoval::Pairing(PairingRemoval::Refused { channel, reason }) => Out::Refused {
                channel: channel.as_str().to_owned(),
                reason: reason.clone(),
            },
            RepairRemoval::Entry(PeerRemoval::Confirmed {
                name,
                over,
                remaining,
            }) => Out::Confirmed {
                name: name.clone(),
                over: over.as_str().to_owned(),
                remaining: *remaining,
            },
            RepairRemoval::Entry(PeerRemoval::Sent { name, over, detail }) => Out::Sent {
                name: name.clone(),
                over: over.as_str().to_owned(),
                detail: detail.clone(),
            },
            RepairRemoval::Entry(PeerRemoval::Failed { name, over, detail }) => Out::Failed {
                name: name.clone(),
                over: over.as_str().to_owned(),
                detail: detail.clone(),
            },
        });
        ev3_contract::OneSidedRepair {
            brick_id: self.brick_id.clone(),
            found: match self.found {
                OneSidedFound::ComputerOnly => ev3_contract::OneSidedRepairFound::ComputerOnly,
                OneSidedFound::BrickOnly => ev3_contract::OneSidedRepairFound::BrickOnly,
            },
            others: self.others.clone(),
            removal,
            repeated: self.repeated.then_some(true),
        }
    }
}

/// What the check tells its listeners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepairEvent {
    /// The repair's pairing started; the brick shows its pairing dialog shortly. Sent before the
    /// repair's own report.
    PairingStarted { brick_id: String },
    /// A one-sided pairing was found, and what was done about it.
    Repaired(OneSidedRepair),
    /// The repair's pairing ended.
    PairingDone {
        brick_id: String,
        outcome: PairingOutcome,
    },
}

// ── Configuration ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckConfig {
    /// When the brick's list is read again after a pairing the repair made that the list does not
    /// name yet, after the read before, one entry per read.
    ///
    /// The brick adds the entry when the link key arrives and copies in the name its name request
    /// has brought by then, which may be none yet (`c_bt.c` 2984, 3314); the name is filled in when
    /// the request completes (`c_bt.c` 3200-3229). Read 2.8 s after BlueZ reported the pairing, a
    /// brick did not show the computer's name; its display listed it later.
    pub own_pairing_rereads: Vec<Duration>,
}

impl Default for CheckConfig {
    fn default() -> Self {
        Self {
            own_pairing_rereads: vec![
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(10),
            ],
        }
    }
}

// ── State ───────────────────────────────────────────────────────────

/// A pairing the repair completed, until the brick's list has been judged after it. The pairing
/// is the cockpit's own write; a read right after it that lacks this computer is not enough to
/// undo it.
struct OwnPairing {
    /// How many unnamed entries the list held when the pairing began.
    unnamed_before: usize,
    rereads: usize,
    timer: Option<AbortHandle>,
}

#[derive(Default)]
struct CheckState {
    /// Bricks waiting for the check since a USB or TCP channel connected: their Bluetooth joins
    /// wait.
    pending: HashSet<String>,
    /// Bricks a check task runs for now.
    running: HashSet<String>,
    /// Bricks whose check was asked for again while one ran.
    again: HashSet<String>,
    /// Pending bricks whose check waits for a Bluetooth scan to answer.
    awaiting_scan: HashSet<String>,
    /// Bricks whose one-sided pairing is being repaired now: their Bluetooth joins wait.
    repairing: HashSet<String>,
    /// Bricks repaired since they were last connected.
    repaired: HashSet<String>,
    /// Bricks the check only logs about until they are connected again.
    suspended: HashSet<String>,
    /// Whether this computer had each signed-in brick paired at the last reconcile.
    paired_before: HashMap<String, bool>,
    own_pairings: HashMap<String, OwnPairing>,
}

struct CheckInner {
    bricks: Mutex<Option<BrickManager>>,
    computer: Arc<ThisComputer>,
    log: Option<Arc<dyn BrickLog>>,
    config: CheckConfig,
    events: broadcast::Sender<RepairEvent>,
    state: Mutex<CheckState>,
}

/// The one-sided check and its repair, and the [`BluetoothGate`] that holds a brick's Bluetooth
/// joins while it runs. Cheap to clone; clones share the state.
///
/// Built before the brick layer, which takes it as its gate (`BrickOptions::bluetooth_gate`), then
/// attached to it: until [`OneSidedCheck::attach`] it holds nothing and checks nothing.
#[derive(Clone)]
pub struct OneSidedCheck {
    inner: Arc<CheckInner>,
}

impl OneSidedCheck {
    pub fn new(
        computer: Arc<ThisComputer>,
        log: Option<Arc<dyn BrickLog>>,
        config: CheckConfig,
    ) -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(CheckInner {
                bricks: Mutex::new(None),
                computer,
                log,
                config,
                events,
                state: Mutex::new(CheckState::default()),
            }),
        }
    }

    /// The gate to hand the brick layer.
    pub fn gate(&self) -> Arc<dyn BluetoothGate> {
        Arc::new(self.clone())
    }

    /// Starts checking over `bricks`, the brick layer this check is the gate of.
    pub fn attach(&self, bricks: &BrickManager) {
        *self
            .inner
            .bricks
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(bricks.clone());
    }

    /// Stops checking and lets go of the brick layer, which holds this check as its gate: until
    /// then each keeps the other alive.
    pub fn detach(&self) {
        let bricks = self
            .inner
            .bricks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let mut state = self.inner.lock();
        for own in state.own_pairings.values_mut() {
            if let Some(timer) = own.timer.take() {
                timer.abort();
            }
        }
        state.pending.clear();
        state.repairing.clear();
        drop(state);
        if let Some(bricks) = bricks {
            bricks.wake_bluetooth();
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RepairEvent> {
        self.inner.events.subscribe()
    }

    /// The person asked to connect the brick: the repair may run again, a suspended brick is
    /// checked again, and a USB or TCP channel already connected is checked now.
    ///
    /// Call it before `BrickManager::connect_again`: the check is marked here, so the Bluetooth
    /// joins the connect starts wait for it. Called after, they would not.
    pub fn connect_requested(&self, brick_id: &str) {
        {
            let mut state = self.inner.lock();
            state.suspended.remove(brick_id);
            state.repaired.remove(brick_id);
        }
        let Some(bricks) = self.inner.bricks() else {
            return;
        };
        if bricks.is_signed_in(brick_id)
            && !bricks.is_held(brick_id)
            && checkable_channel_connected(&bricks, brick_id)
        {
            self.inner.lock().pending.insert(brick_id.to_owned());
            self.inner.start(brick_id);
        }
    }

    /// The brick is about to be forgotten or its list cleared: nothing is checked or repaired for
    /// it until it is connected again, and a check it waits for no longer holds its Bluetooth.
    pub fn suspend(&self, brick_id: &str) {
        let woke = {
            let mut state = self.inner.lock();
            state.suspended.insert(brick_id.to_owned());
            state.awaiting_scan.remove(brick_id);
            drop_own_pairing(&mut state, brick_id);
            state.pending.remove(brick_id)
        };
        if woke {
            self.inner.wake();
        }
    }

    /// A pairing the cockpit made for a person succeeded: recorded like the repair's own, so a
    /// check that reads the brick's list before the brick has filled in this computer's name
    /// reads it again on the same schedule rather than calling the pairing one-sided.
    ///
    /// The list was not read before this pairing began, so any unnamed entry counts as possibly
    /// this computer's: a brick that already held one waits the reads out once and is then left
    /// as it is, with a line in the log, and nothing is removed.
    pub fn own_pairing_done(&self, brick_id: &str) {
        let mut state = self.inner.lock();
        if let Some(old) = state.own_pairings.insert(
            brick_id.to_owned(),
            OwnPairing {
                unnamed_before: 0,
                rereads: 0,
                timer: None,
            },
        ) && let Some(timer) = old.timer
        {
            timer.abort();
        }
    }

    /// The cockpit removed this computer's pairing with the brick itself: not a pairing removed
    /// outside the cockpit, so the list showing it unpaired starts no check. The list says so
    /// after the removal, when whatever removed it has already finished.
    pub(crate) fn pairing_removed(&self, brick_id: &str) {
        self.inner
            .lock()
            .paired_before
            .insert(brick_id.to_owned(), false);
    }

    /// The brick was forgotten: what the check remembered of its repairs goes with it.
    pub fn forgotten(&self, brick_id: &str) {
        let mut state = self.inner.lock();
        state.repaired.remove(brick_id);
        state.paired_before.remove(brick_id);
    }

    pub fn is_suspended(&self, brick_id: &str) -> bool {
        self.inner.lock().suspended.contains(brick_id)
    }
}

impl BluetoothGate for OneSidedCheck {
    fn holds(&self, brick_id: &str) -> bool {
        let state = self.inner.lock();
        state.pending.contains(brick_id) || state.repairing.contains(brick_id)
    }

    fn channel_state(&self, brick_id: &str, brick_key: &BrickKey, state: ConnectionState) {
        if brick_key.transport() == Transport::Bt {
            return;
        }
        let Some(bricks) = self.inner.bricks() else {
            return;
        };
        if !can_pair(&bricks) {
            return;
        }
        match state {
            ConnectionState::Connected
                if bricks.is_signed_in(brick_id) && !bricks.is_held(brick_id) =>
            {
                // Marked now, synchronously: the Bluetooth join this connect lets look again
                // must see it.
                self.inner.lock().pending.insert(brick_id.to_owned());
                self.inner.start(brick_id);
            }
            // Over Bluetooth alone the check does not run; the brick joins as before.
            ConnectionState::Disconnected if !checkable_channel_connected(&bricks, brick_id) => {
                let woke = {
                    let mut state = self.inner.lock();
                    state.awaiting_scan.remove(brick_id);
                    state.pending.remove(brick_id)
                };
                if woke {
                    bricks.wake_bluetooth();
                }
            }
            _ => {}
        }
    }

    fn reconciled(&self, brick_id: &str) {
        let Some(bricks) = self.inner.bricks() else {
            return;
        };
        let paired = bricks
            .aggregator()
            .brick(brick_id)
            .is_some_and(|entry| entry.paired);
        let scanned = bricks.aggregator().scheduler().has_scanned(Transport::Bt);
        let start = {
            let mut state = self.inner.lock();
            let before = state.paired_before.insert(brick_id.to_owned(), paired);
            // This computer stopped listing a signed-in brick as paired, outside the cockpit, while
            // USB or TCP is connected: checked again before anything pairs it. The brick still
            // lists this computer, so pairing beside that entry would leave it to the brick.
            let unpaired = before == Some(true)
                && !paired
                && !state.repairing.contains(brick_id)
                && !bricks.is_held(brick_id)
                && can_pair(&bricks)
                && checkable_channel_connected(&bricks, brick_id);
            if unpaired {
                state.pending.insert(brick_id.to_owned());
            }
            // A check that waited for a Bluetooth scan runs once one has answered: the list is
            // rebuilt after every scan, which reconciles.
            let scan_came = scanned && state.awaiting_scan.remove(brick_id);
            unpaired || scan_came
        };
        if start {
            self.inner.start(brick_id);
        }
    }
}

/// Whether a Bluetooth provider that pairs is there: without one there is nothing to repair with.
fn can_pair(bricks: &BrickManager) -> bool {
    bricks
        .aggregator()
        .scheduler()
        .provider(Transport::Bt)
        .is_some_and(|provider| provider.capabilities().supports_pairing)
}

/// Whether a USB or TCP channel of the brick is connected: the only ones its list is checked over.
fn checkable_channel_connected(bricks: &BrickManager, brick_id: &str) -> bool {
    checkable_channel(bricks, brick_id).is_some()
}

/// The connected USB or TCP channel with the highest priority.
fn checkable_channel(bricks: &BrickManager, brick_id: &str) -> Option<BrickKey> {
    let scheduler = bricks.aggregator().scheduler();
    bricks
        .sessions()
        .sessions()
        .into_iter()
        .filter(|s| {
            brick_id_of(&s.brick_key) == brick_id
                && s.connection_state == ConnectionState::Connected
                && s.brick_key.transport() != Transport::Bt
        })
        .map(|s| s.brick_key)
        .max_by_key(|key| scheduler.priority_of(key.transport()))
}

fn unnamed_of(peers: &[Peer]) -> usize {
    peers.iter().filter(|p| is_blank_peer_name(&p.name)).count()
}

fn drop_own_pairing(state: &mut CheckState, brick_id: &str) {
    if let Some(own) = state.own_pairings.remove(brick_id)
        && let Some(timer) = own.timer
    {
        timer.abort();
    }
}

/// The Bluetooth channel of a brick whose id is its hardware address, as a pairing addresses it.
fn bluetooth_key_of(brick_id: &str) -> Option<BrickKey> {
    if brick_id.len() != 12 || !brick_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let pairs: Vec<&str> = (0..6).map(|i| &brick_id[i * 2..i * 2 + 2]).collect();
    BrickKey::new(Transport::Bt, &pairs.join(":").to_ascii_uppercase()).ok()
}

fn describe(found: OneSidedFound) -> &'static str {
    match found {
        OneSidedFound::ComputerOnly => "paired on this computer only",
        OneSidedFound::BrickOnly => "paired on the brick only",
    }
}

impl CheckInner {
    fn lock(&self) -> MutexGuard<'_, CheckState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn bricks(&self) -> Option<BrickManager> {
        self.bricks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn warn(&self, message: &str) {
        if let Some(log) = &self.log {
            log.warn(message);
        }
    }

    fn emit(&self, event: RepairEvent) {
        // No listener is not an error.
        let _ = self.events.send(event);
    }

    /// Lets the Bluetooth joins held for a brick look again; spurious wakes cost nothing.
    fn wake(&self) {
        if let Some(bricks) = self.bricks() {
            bricks.wake_bluetooth();
        }
    }

    /// Releases a brick's pending check and lets its Bluetooth go.
    fn release(&self, brick_id: &str) {
        {
            let mut state = self.lock();
            state.pending.remove(brick_id);
            state.awaiting_scan.remove(brick_id);
        }
        self.wake();
    }

    /// Runs the check for a pending brick on a task of its own, one at a time per brick; asked
    /// again while one runs, it runs once more after it.
    fn start(self: &Arc<Self>, brick_id: &str) {
        {
            let mut state = self.lock();
            if !state.running.insert(brick_id.to_owned()) {
                state.again.insert(brick_id.to_owned());
                return;
            }
        }
        let inner = self.clone();
        let brick = brick_id.to_owned();
        tokio::spawn(async move {
            loop {
                inner.check(&brick).await;
                let mut state = inner.lock();
                if !(state.again.remove(&brick) && state.pending.contains(&brick)) {
                    state.running.remove(&brick);
                    return;
                }
            }
        });
    }

    async fn check(self: &Arc<Self>, brick_id: &str) {
        let Some(bricks) = self.bricks() else {
            return;
        };
        if !self.lock().pending.contains(brick_id) {
            return;
        }
        if !bricks.is_signed_in(brick_id) || bricks.is_held(brick_id) || !can_pair(&bricks) {
            self.release(brick_id);
            return;
        }
        // Until a Bluetooth scan has answered, what discovery tracks says nothing about whether
        // this computer has the brick paired.
        if !bricks.aggregator().scheduler().has_scanned(Transport::Bt) {
            self.lock().awaiting_scan.insert(brick_id.to_owned());
            return;
        }
        let Some(over) = checkable_channel(&bricks, brick_id) else {
            self.release(brick_id);
            return;
        };
        let peers = match read_peers(bricks.sessions(), &over).await {
            Ok(peers) => peers,
            Err(error) => {
                // Nothing to check against: Bluetooth goes on rather than wait for a read that
                // may never come.
                self.warn(&format!(
                    "Reading the list of paired computers of {} failed: {error}",
                    brick_label(&bricks, brick_id)
                ));
                self.release(brick_id);
                return;
            }
        };
        // Released meanwhile: the channel went, or a forget or a clear began.
        if !self.lock().pending.contains(brick_id) {
            self.wake();
            return;
        }
        let Some(name) = self.computer.name().await else {
            self.release(brick_id);
            return;
        };
        let tracked = bricks
            .aggregator()
            .scheduler()
            .tracked()
            .into_iter()
            .find(|item| {
                item.transport == Transport::Bt && brick_id_of(&item.brick_key) == brick_id
            });
        // Paired as this computer lists it now: a pairing removed elsewhere leaves the item marked
        // paired until the scans that miss it expire it.
        let computer_paired = tracked.as_ref().is_some_and(|item| {
            item.paired == Some(true) && item.presence_state == PresenceState::Available
        });
        let on_brick = peers.iter().any(|p| p.name == name);
        if computer_paired && !on_brick && self.await_own_pairing(&bricks, brick_id, &peers) {
            return;
        }
        {
            let mut state = self.lock();
            drop_own_pairing(&mut state, brick_id);
            state.pending.remove(brick_id);
        }
        if computer_paired == on_brick {
            self.wake();
            return;
        }

        let found = if computer_paired {
            OneSidedFound::ComputerOnly
        } else {
            OneSidedFound::BrickOnly
        };
        let others: Vec<String> = peers
            .iter()
            .map(|p| p.name.clone())
            .filter(|n| *n != name && !is_blank_peer_name(n))
            .collect();
        let label = brick_label(&bricks, brick_id);
        let (suspended, repaired) = {
            let state = self.lock();
            (
                state.suspended.contains(brick_id),
                state.repaired.contains(brick_id),
            )
        };
        if suspended {
            self.warn(&format!(
                "The pairing with {label} looks one-sided ({}); connecting it again repairs it.",
                describe(found)
            ));
            self.wake();
            return;
        }
        if repaired {
            self.warn(&format!(
                "The pairing with {label} still looks one-sided ({}) after a repair; left alone.",
                describe(found)
            ));
            self.emit(RepairEvent::Repaired(OneSidedRepair {
                brick_id: brick_id.to_owned(),
                found,
                removal: None,
                others,
                repeated: true,
                pairing_again: false,
            }));
            self.wake();
            return;
        }
        let bt_key = tracked
            .map(|item| item.brick_key)
            .or_else(|| {
                bricks
                    .aggregator()
                    .brick(brick_id)
                    .and_then(|entry| entry.channel(Transport::Bt).map(|c| c.brick_key.clone()))
            })
            .or_else(|| bluetooth_key_of(brick_id));
        self.repair(
            &bricks, brick_id, found, &name, &over, &peers, bt_key, others,
        )
        .await;
    }

    /// Whether the check waits for the brick's list to catch up with a pairing the repair just
    /// completed: this computer's side is paired, this computer's name is not on the list, and the
    /// list holds more unnamed entries than when the pairing began, so one of them is most likely
    /// this computer still without its name. The list is read again on a bounded schedule; when the
    /// name has not come by the last read, the pairing is left as it is with a line in the log, and
    /// nothing is removed. Without a new unnamed entry the brick does not hold this computer, and
    /// the repair runs as before.
    fn await_own_pairing(
        self: &Arc<Self>,
        bricks: &BrickManager,
        brick_id: &str,
        peers: &[Peer],
    ) -> bool {
        let unnamed = unnamed_of(peers);
        let mut state = self.lock();
        let Some(own) = state.own_pairings.get_mut(brick_id) else {
            return false;
        };
        if unnamed <= own.unnamed_before {
            return false;
        }
        let Some(delay) = self.config.own_pairing_rereads.get(own.rereads).copied() else {
            drop_own_pairing(&mut state, brick_id);
            state.pending.remove(brick_id);
            drop(state);
            self.warn(&format!(
                "{} lists an entry without a name since this computer paired it, and no entry \
                 under this computer's name; the pairing is left as it is.",
                brick_label(bricks, brick_id)
            ));
            self.wake();
            return true;
        };
        own.rereads += 1;
        let read = own.rereads;
        let inner = self.clone();
        let brick = brick_id.to_owned();
        // Still pending: the read below is checked like the one before it.
        let timer = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let current = inner
                .lock()
                .own_pairings
                .get(&brick)
                .is_some_and(|own| own.rereads == read);
            if current {
                inner.start(&brick);
            }
        })
        .abort_handle();
        if let Some(old) = own.timer.replace(timer) {
            old.abort();
        }
        true
    }

    /// Removes the half of a one-sided pairing that is left, keeping the brick's other channels,
    /// then pairs again: the brick's dialog is the consent. Nothing pairs when the removal did not
    /// take, or when the brick was signed out, or a forget or a clear began, meanwhile.
    #[allow(clippy::too_many_arguments)]
    async fn repair(
        self: &Arc<Self>,
        bricks: &BrickManager,
        brick_id: &str,
        found: OneSidedFound,
        name: &str,
        over: &BrickKey,
        peers: &[Peer],
        bt_key: Option<BrickKey>,
        others: Vec<String>,
    ) {
        {
            let mut state = self.lock();
            state.repairing.insert(brick_id.to_owned());
            state.repaired.insert(brick_id.to_owned());
        }
        let removal = match (found, &bt_key) {
            (OneSidedFound::ComputerOnly, Some(bt_key)) => {
                let (pairing, _) = forget_bluetooth_channel(bricks, brick_id, bt_key).await;
                // The repair's own unpair: the list showing it is no reason to check again.
                self.lock().paired_before.insert(brick_id.to_owned(), false);
                RepairRemoval::Pairing(pairing.into_iter().next().unwrap_or_else(|| {
                    PairingRemoval::Refused {
                        channel: bt_key.clone(),
                        reason: "No provider can unpair it.".to_owned(),
                    }
                }))
            }
            _ => {
                let held = count_of(&names_of(peers), name);
                RepairRemoval::Entry(remove_peer(bricks, brick_id, over, name, held).await)
            }
        };
        let pair_over = bt_key.filter(|_| {
            removal.took()
                && bricks.is_signed_in(brick_id)
                && !bricks.is_held(brick_id)
                && !self.lock().suspended.contains(brick_id)
        });
        if let Some(bt_key) = &pair_over {
            self.emit(RepairEvent::PairingStarted {
                brick_id: brick_id.to_owned(),
            });
            let inner = self.clone();
            let brick = brick_id.to_owned();
            let key = bt_key.clone();
            let unnamed_before = unnamed_of(peers);
            tokio::spawn(async move { inner.pair_again(&brick, &key, unnamed_before).await });
        }
        self.emit(RepairEvent::Repaired(OneSidedRepair {
            brick_id: brick_id.to_owned(),
            found,
            removal: Some(removal),
            others,
            repeated: false,
            pairing_again: pair_over.is_some(),
        }));
        self.lock().repairing.remove(brick_id);
        // A Bluetooth join held for the repair looks again: one whose pairing the repair removed
        // gives up, and the pairing that follows makes the channel a candidate again.
        self.wake();
    }

    /// Pairs the brick again after a repair. A pairing that fails or is cancelled on the brick
    /// suspends it until it is connected again; one that succeeds is recorded at once, unless a
    /// forget or a clear began meanwhile.
    async fn pair_again(
        self: &Arc<Self>,
        brick_id: &str,
        bt_key: &BrickKey,
        unnamed_before: usize,
    ) {
        let Some(bricks) = self.bricks() else {
            return;
        };
        let provider = bricks.aggregator().scheduler().provider(Transport::Bt);
        let mut outcome = match provider {
            Some(provider) => provider
                .pair(bt_key)
                .await
                .unwrap_or_else(|error| PairingOutcome {
                    ok: false,
                    reason: Some(error.message),
                    status: None,
                }),
            None => PairingOutcome {
                ok: false,
                reason: Some("No Bluetooth provider can pair.".to_owned()),
                status: None,
            },
        };
        if outcome.ok && (bricks.is_held(brick_id) || self.lock().suspended.contains(brick_id)) {
            outcome = PairingOutcome {
                ok: false,
                reason: Some("The pairing was cancelled.".to_owned()),
                status: outcome.status,
            };
        } else if outcome.ok {
            self.lock().own_pairings.insert(
                brick_id.to_owned(),
                OwnPairing {
                    unnamed_before,
                    rereads: 0,
                    timer: None,
                },
            );
            bricks.aggregator().mark_paired(bt_key);
        } else {
            self.lock().suspended.insert(brick_id.to_owned());
        }
        self.emit(RepairEvent::PairingDone {
            brick_id: brick_id.to_owned(),
            outcome,
        });
    }
}
