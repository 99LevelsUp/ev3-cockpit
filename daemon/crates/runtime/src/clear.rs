//! Clearing a brick's list of paired devices, after a person said yes.
//!
//! One operation, so the list the person is asked about is the list that gets cleared:
//!
//! 1. take the channel a forget would, opening one when none is connected;
//! 2. read the list and ask a person, naming every entry it will remove and the client that asked;
//!    anything but a yes sends nothing, and a channel this opened is closed;
//! 3. hold the brick's links, and remove each named entry until the list is empty or a pass
//!    removes nothing. Over USB or TCP the brick's Bluetooth sessions are closed first; over
//!    Bluetooth alone this computer's entry — the one the brick marks connected, or the one
//!    carrying this computer's Bluetooth name — goes last, because its removal cuts the link, and
//!    the brick is then signed out, as nothing else reaches it;
//! 4. when this computer's entry went and the brick was paired, forget its Bluetooth channel only:
//!    the pairing and the cockpit's memory of that channel. Its other channels stay as they are, a
//!    USB session too.
//!
//! Over Bluetooth alone the clear refuses, asking nothing, when nothing tells which entry holds
//! the link, or when that entry's name is held twice: any removal could cut the link first and
//! leave a pairing nothing can tell is one-sided.

use std::collections::HashSet;

use ev3_protocol::BrickCommand;
use ev3_protocol::commands::is_blank_peer_name;
use ev3_transports::{BrickKey, ForgetResidue, Transport};

use crate::error::SessionError;
use crate::forget::{
    ForgetInner, ForgetService, PairingRemoval, Peer, Refused, brick_label, channel_keys_of,
    close_bluetooth_sessions, count_of, forget_bluetooth_channel, names_of, never_sent,
    peer_list_channel, read_peers, residue_to_contract,
};
use crate::ports::{ConsentAnswer, ConsentSubject, Requester};
use crate::session::SessionManager;

// ── Report ──────────────────────────────────────────────────────────

/// How one entry of the brick's list ended, one per entry read, in the list's order. Entries are
/// told apart only by name, so of two entries named alike the first confirmed removal counts for
/// the first of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClearedEntry {
    /// The list read back after its removal held one entry of that name fewer.
    Confirmed { name: String },
    /// Sent, and nothing shows whether it took: the link it went over was lost — over Bluetooth,
    /// cut by this computer's own entry going (`c_bt.c` 3609-3612) — or the list could not be read
    /// back. `detail` is the error that ended it.
    Sent { name: String, detail: String },
    /// Still on the brick: the list read back still holds it, the brick rejected it, or it was
    /// never sent.
    Failed { name: String, detail: String },
    /// Its name is empty or blank, and a removal is addressed only by name; the firmware reads an
    /// empty one as "the first entry with a name" (`c_bt.c` 2205-2211), so none is sent.
    NotRemovable { name: String },
}

impl ClearedEntry {
    pub fn name(&self) -> &str {
        match self {
            Self::Confirmed { name }
            | Self::Sent { name, .. }
            | Self::Failed { name, .. }
            | Self::NotRemovable { name } => name,
        }
    }
}

/// Why nothing was removed from the brick's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearSkip {
    /// No channel to the brick was connected, and none could be opened.
    NotReachable,
    /// The brick's list could not be read.
    ListUnreadable,
    /// The list was empty, or held only entries without a name.
    NothingToRemove,
    /// Only Bluetooth reaches the brick, this computer's Bluetooth name is unknown, and the list
    /// does not mark exactly one entry connected: removing this computer's entry cuts the link, so
    /// it has to go last, and nothing tells which entry it is.
    RadioNameUnknown,
    /// Only Bluetooth reaches the brick, no entry carries this computer's Bluetooth name, and the
    /// list does not mark exactly one entry connected: a removal of another computer's entry could
    /// pass for this computer's and leave the pairing one-sided.
    LinkEntryUnknown,
    /// Only Bluetooth reaches the brick, and the name of this computer's entry is held more than
    /// once. The brick removes the first entry a name matches, which may be the one holding the
    /// link: the link is cut before the other copy is sent.
    DuplicateLinkEntry,
}

/// Why this computer's pairing with the brick was left alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearPairingSkip {
    /// This computer's Bluetooth name is unknown and no entry marked connected stood in for it.
    RadioNameUnknown,
    /// No entry on the brick carried this computer's exact Bluetooth name. Only a list read over
    /// USB or Wi-Fi ends here: there an entry marked connected may be another computer's link.
    NotOnBrick,
    /// This computer's entry was on the brick and was not removed.
    NotRemoved,
    /// This computer's entry went, and this computer did not have the brick paired.
    NotPaired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearSkipped {
    pub reason: ClearSkip,
    pub detail: Option<String>,
}

/// What clearing a brick's Bluetooth list did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearListReport {
    pub brick_id: String,
    /// The channel the list was read and changed over; `None` when none was reached.
    pub over: Option<BrickKey>,
    /// This computer's Bluetooth name, the key to its own entry; `None` when unknown.
    pub this_computer: Option<String>,
    /// Whether this computer had the brick paired over Bluetooth when the clear began.
    pub paired: bool,
    /// Set when nothing was removed, with why.
    pub skipped: Option<ClearSkipped>,
    /// The names on the brick's list as read before any removal, untrimmed; `None` when not read.
    pub peers: Option<Vec<String>>,
    /// One outcome per entry read, in the list's order.
    pub entries: Vec<ClearedEntry>,
    /// The names on the brick's list as last read back after the removals, less the one whose
    /// removal counts as sent; `None` when the clear stopped before removing anything.
    pub left: Option<Vec<String>>,
    /// This computer's pairing with the brick, when its entry went and the brick was paired.
    pub pairing: Vec<PairingRemoval>,
    /// Why the pairing was left alone; `None` when it was acted on.
    pub pairing_left: Option<ClearPairingSkip>,
    /// The cockpit's memory of the brick's Bluetooth channel was cleared with the pairing.
    pub channel_forgotten: bool,
    /// What the provider said it left behind, exactly as it returned it.
    pub residue: Vec<ForgetResidue>,
}

impl ClearListReport {
    pub fn to_contract(&self) -> ev3_contract::ClearListReport {
        use ev3_contract::ClearedEntry as Entry;
        ev3_contract::ClearListReport {
            brick_id: self.brick_id.clone(),
            entries: self
                .entries
                .iter()
                .map(|entry| match entry {
                    ClearedEntry::Confirmed { name } => Entry::Confirmed { name: name.clone() },
                    ClearedEntry::Sent { name, detail } => Entry::Sent {
                        name: name.clone(),
                        detail: detail.clone(),
                    },
                    ClearedEntry::Failed { name, detail } => Entry::Failed {
                        name: name.clone(),
                        detail: detail.clone(),
                    },
                    ClearedEntry::NotRemovable { name } => Entry::NotRemovable {
                        name: name.clone(),
                        reason: ev3_contract::ClearedEntryReason::BlankName,
                    },
                })
                .collect(),
            left: self.left.clone().unwrap_or_default(),
            memory: self
                .channel_forgotten
                .then_some(ev3_contract::MemoryOutcome::Cleared),
            over: self.over.as_ref().map(|key| key.as_str().to_owned()),
            paired: self.paired,
            pairing: self
                .pairing
                .iter()
                .map(PairingRemoval::to_contract)
                .collect(),
            pairing_left: self.pairing_left.map(|left| match left {
                ClearPairingSkip::RadioNameUnknown => {
                    ev3_contract::ClearPairingSkip::RadioNameUnknown
                }
                ClearPairingSkip::NotOnBrick => ev3_contract::ClearPairingSkip::NotOnBrick,
                ClearPairingSkip::NotRemoved => ev3_contract::ClearPairingSkip::NotRemoved,
                ClearPairingSkip::NotPaired => ev3_contract::ClearPairingSkip::NotPaired,
            }),
            peers: self.peers.clone().unwrap_or_default(),
            residue: residue_to_contract(&self.residue),
            skipped: self
                .skipped
                .as_ref()
                .map(|skipped| ev3_contract::ClearListReportSkipped {
                    detail: skipped.detail.clone(),
                    reason: match skipped.reason {
                        ClearSkip::NotReachable => ev3_contract::ClearSkip::NotReachable,
                        ClearSkip::ListUnreadable => ev3_contract::ClearSkip::ListUnreadable,
                        ClearSkip::NothingToRemove => ev3_contract::ClearSkip::NothingToRemove,
                        ClearSkip::RadioNameUnknown => ev3_contract::ClearSkip::RadioNameUnknown,
                        ClearSkip::LinkEntryUnknown => ev3_contract::ClearSkip::LinkEntryUnknown,
                        ClearSkip::DuplicateLinkEntry => {
                            ev3_contract::ClearSkip::DuplicateLinkEntry
                        }
                    },
                }),
            this_computer: self.this_computer.clone(),
        }
    }
}

// ── The operation ───────────────────────────────────────────────────

/// Keeps a brick in the clearing set while a clear runs, and takes it out however the clear ends.
struct Clearing<'a> {
    inner: &'a ForgetInner,
    brick_id: String,
}

impl Drop for Clearing<'_> {
    fn drop(&mut self) {
        self.inner.lock().clearing.remove(&self.brick_id);
    }
}

/// Over Bluetooth alone, the entries that go after every other: this computer's Bluetooth name,
/// then the entries marked connected, which go last of all — the link is held under a marked one,
/// so one carrying only the name sent after it would never be sent.
struct LastOverBluetooth {
    named: HashSet<String>,
    linked: HashSet<String>,
}

struct Removed {
    entries: Vec<ClearedEntry>,
    /// The link the list went over is gone: cut by a removal, or lost before one left.
    link_cut: bool,
    left: Vec<Peer>,
}

impl ForgetService {
    /// Removes every entry from a brick's own Bluetooth list, whatever its name, after asking a
    /// person for `requester` with every name it will remove.
    ///
    /// A clear that stops before it would remove anything (nothing reachable, nothing to remove,
    /// an entry nothing tells apart over Bluetooth alone) asks nothing and reports why. Anything
    /// but a yes sends nothing. Refused while the brick is being forgotten or its list cleared.
    pub async fn clear_bluetooth_list(
        &self,
        brick_id: &str,
        requester: &Requester,
    ) -> Result<ClearListReport, Refused> {
        let inner = &*self.inner;
        {
            let mut state = inner.lock();
            if state.clearing.contains(brick_id) || state.forgetting(brick_id) {
                return Err(Refused::Busy {
                    brick_id: brick_id.to_owned(),
                });
            }
            state.clearing.insert(brick_id.to_owned());
        }
        let _clearing = Clearing {
            inner,
            brick_id: brick_id.to_owned(),
        };
        inner.run_clear(brick_id, requester).await
    }
}

impl ForgetInner {
    async fn run_clear(
        &self,
        brick_id: &str,
        requester: &Requester,
    ) -> Result<ClearListReport, Refused> {
        let bricks = &self.bricks;
        // Before the list is read: nothing checks or repairs the brick while its list changes.
        if let Some(check) = &self.check {
            check.suspend(brick_id);
        }
        let this_computer = self.computer.name().await;
        // Read before anything changes: whether this computer has the brick paired decides what
        // happens to the pairing.
        let was_paired = bricks
            .aggregator()
            .brick(brick_id)
            .is_some_and(|entry| entry.paired);
        let bt_key = channel_keys_of(bricks, brick_id)
            .into_iter()
            .find(|key| key.transport() == Transport::Bt);
        let base = ClearListReport {
            brick_id: brick_id.to_owned(),
            over: None,
            this_computer: this_computer.clone(),
            paired: was_paired,
            skipped: None,
            peers: None,
            entries: Vec::new(),
            left: None,
            pairing: Vec::new(),
            pairing_left: None,
            channel_forgotten: false,
            residue: Vec::new(),
        };
        let skipped = |reason: ClearSkip, detail: Option<String>| ClearListReport {
            skipped: Some(ClearSkipped { reason, detail }),
            pairing_left: Some(if reason == ClearSkip::RadioNameUnknown {
                ClearPairingSkip::RadioNameUnknown
            } else {
                ClearPairingSkip::NotRemoved
            }),
            ..base.clone()
        };

        let channel = peer_list_channel(bricks, brick_id).await;
        let Some(key) = channel.key.clone() else {
            return Ok(skipped(ClearSkip::NotReachable, channel.failure));
        };
        let over_bt = key.transport() == Transport::Bt;
        // A brick signed in meanwhile keeps it: it is a channel the sign-in would have joined.
        let (opened, opened_key) = (channel.opened, &key);
        let close_opened = move || async move {
            if opened && !bricks.is_signed_in(brick_id) {
                bricks.sessions().disconnect(opened_key, true).await;
            }
        };

        let list = match read_peers(bricks.sessions(), &key).await {
            Ok(list) => list,
            Err(error) => {
                close_opened().await;
                return Ok(ClearListReport {
                    over: Some(key.clone()),
                    ..skipped(ClearSkip::ListUnreadable, Some(error.to_string()))
                });
            }
        };
        let peers = names_of(&list);
        let read = |report: ClearListReport| ClearListReport {
            over: Some(key.clone()),
            peers: Some(peers.clone()),
            ..report
        };
        let names: Vec<String> = peers
            .iter()
            .filter(|name| !is_blank_peer_name(name))
            .cloned()
            .collect();
        if names.is_empty() {
            close_opened().await;
            return Ok(ClearListReport {
                entries: peers
                    .iter()
                    .map(|name| ClearedEntry::NotRemovable { name: name.clone() })
                    .collect(),
                ..read(skipped(ClearSkip::NothingToRemove, None))
            });
        }
        // Over Bluetooth alone, the entry the brick holds this link under reads connected
        // (`c_bt.c` 3566) — under whatever name this computer had when it paired, an earlier one
        // too. Its removal is the one that cuts the link, so the entries marked connected go last.
        // Over USB or Wi-Fi the mark may be another computer's link, so it says nothing there.
        let linked: Vec<String> = if over_bt {
            list.iter()
                .filter(|p| p.connected && !is_blank_peer_name(&p.name))
                .map(|p| p.name.clone())
                .collect()
        } else {
            Vec::new()
        };
        // This computer's entry decides the pairing, so it is the one entry that must not be
        // mistaken: the entries carrying the radio name; without any, the one entry marked
        // connected; with two marked, neither — either may be another computer's link, and its
        // removal would unpair this computer while its entry stays.
        let named: Vec<String> = this_computer
            .iter()
            .filter(|name| names.contains(name))
            .cloned()
            .collect();
        let ours: HashSet<String> = if !named.is_empty() {
            named.iter().cloned().collect()
        } else if linked.len() == 1 {
            linked.iter().cloned().collect()
        } else {
            HashSet::new()
        };
        if over_bt && ours.is_empty() {
            close_opened().await;
            let reason = if this_computer.is_some() {
                ClearSkip::LinkEntryUnknown
            } else {
                ClearSkip::RadioNameUnknown
            };
            return Ok(read(skipped(reason, None)));
        }
        // The brick removes the first entry a name matches (`c_bt.c` 2215). Over Bluetooth alone,
        // with a name that goes last held twice, that may be the copy holding this link.
        let duplicate = this_computer
            .iter()
            .chain(linked.iter())
            .any(|name| count_of(&names, name) > 1);
        if over_bt && duplicate {
            close_opened().await;
            return Ok(read(skipped(ClearSkip::DuplicateLinkEntry, None)));
        }

        let includes_this_computer = !ours.is_empty();
        let answer = self
            .ask(
                requester,
                brick_id,
                clear_question(
                    &brick_label(bricks, brick_id),
                    &names,
                    includes_this_computer,
                    this_computer.as_deref(),
                ),
                ConsentSubject::ClearBluetoothList {
                    brick_id: brick_id.to_owned(),
                    entries: names.clone(),
                    includes_this_computer,
                    this_computer: this_computer.clone(),
                },
            )
            .await;
        if answer != ConsentAnswer::Granted {
            close_opened().await;
            return Err(if answer == ConsentAnswer::Declined {
                Refused::Declined
            } else {
                Refused::Unanswered
            });
        }

        let hold = bricks.hold_links(brick_id);
        // The removal of this computer's entry cuts its Bluetooth link; closed first, so nothing
        // reconnects it to a brick that has just dropped this computer.
        if !over_bt {
            close_bluetooth_sessions(bricks, brick_id).await;
        }
        let last = over_bt.then(|| LastOverBluetooth {
            named: this_computer.iter().cloned().collect(),
            linked: linked.iter().cloned().collect(),
        });
        let removed = remove_entries(bricks.sessions(), &key, &list, last.as_ref()).await;
        let left = names_of(&removed.left);
        if over_bt && removed.link_cut {
            // The link the list went over is gone, and nothing else reached the brick.
            if bricks.is_signed_in(brick_id) {
                bricks.sign_out(brick_id).await;
            } else {
                bricks.sessions().disconnect(&key, true).await;
            }
        }

        // Gone only when no entry under this computer's name is left: with the name held twice and
        // one copy kept, the brick still knows this computer.
        let this_computer_went =
            includes_this_computer && ours.iter().all(|name| !left.contains(name));
        let pairing_left = if !includes_this_computer {
            Some(if this_computer.is_some() {
                ClearPairingSkip::NotOnBrick
            } else {
                ClearPairingSkip::RadioNameUnknown
            })
        } else if !this_computer_went {
            Some(ClearPairingSkip::NotRemoved)
        } else if bt_key.is_none() || !was_paired {
            Some(ClearPairingSkip::NotPaired)
        } else {
            None
        };
        let (pairing, residue, channel_forgotten) = match (&bt_key, pairing_left) {
            (Some(bt_key), None) => {
                let (pairing, residue) = forget_bluetooth_channel(bricks, brick_id, bt_key).await;
                if let Some(check) = &self.check {
                    check.pairing_removed(brick_id);
                }
                (pairing, residue, true)
            }
            _ => (Vec::new(), Vec::new(), false),
        };
        close_opened().await;
        drop(hold);
        Ok(ClearListReport {
            entries: removed.entries,
            left: Some(left),
            pairing,
            pairing_left,
            channel_forgotten,
            residue,
            ..read(base.clone())
        })
    }
}

/// The question a clear puts to a person: every entry it will remove, and whether this computer is
/// among them.
fn clear_question(
    brick: &str,
    names: &[String],
    includes_this_computer: bool,
    this_computer: Option<&str>,
) -> String {
    let count = names.len();
    let entries = if count == 1 { "entry" } else { "entries" };
    let listed = names
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let this = if includes_this_computer {
        format!(
            " This computer ({}) is among them, so its Bluetooth pairing with the brick ends too.",
            this_computer.unwrap_or("its entry is the one the brick marks connected")
        )
    } else {
        String::new()
    };
    format!("Remove {count} {entries} from {brick}'s list of paired devices: {listed}?{this}")
}

/// Removes every named entry of `list` from the brick's list over `key`, each confirmed by reading
/// the list back.
///
/// What it removes is the names the person was shown, so an entry that appears meanwhile is not
/// removed unseen. A pass sends each name still to go once and reads the list back after each; a
/// name held twice goes once per pass. It stops when every name has gone, when a pass removes
/// nothing, so an entry the brick keeps cannot loop, or after as many passes as the list had
/// entries. `last`, over Bluetooth alone, holds the names that go only after every other.
///
/// A link that failed on a removal, or a list that cannot be read back after one, ends it: that
/// removal counts as sent, and the entries not yet removed as not sent. A removal refused before it
/// left ends it too, with that removal not sent: nothing more can go over that link. `left` is the
/// list as last read back, less the one entry whose removal counts as sent.
async fn remove_entries(
    sessions: &SessionManager,
    key: &BrickKey,
    list: &[Peer],
    last: Option<&LastOverBluetooth>,
) -> Removed {
    let peers = names_of(list);
    // In the list's order, as each name first appears.
    let mut to_go: Vec<(String, usize)> = Vec::new();
    for name in peers.iter().filter(|name| !is_blank_peer_name(name)) {
        match to_go.iter_mut().find(|(n, _)| n == name) {
            Some((_, count)) => *count += 1,
            None => to_go.push((name.clone(), 1)),
        }
    }
    let mut removed: Vec<(String, usize)> = Vec::new();
    let mut last_failure: Vec<(String, String)> = Vec::new();
    let mut current: Vec<Peer> = list.to_vec();
    let mut sent: Option<(String, String)> = None;
    let mut lost: Option<String> = None;

    let phases = if last.is_some() { 3 } else { 1 };
    'phases: for phase in 0..phases {
        for _pass in 0..peers.len() {
            if sent.is_some() || lost.is_some() {
                break 'phases;
            }
            let names: Vec<String> = to_go
                .iter()
                .filter(|(name, left)| *left > 0 && in_phase(last, phase, name))
                .map(|(name, _)| name.clone())
                .collect();
            if names.is_empty() {
                break;
            }
            let mut progress = false;
            for name in names {
                let before = count_of(&names_of(&current), &name);
                let command = BrickCommand::RemoveBluetoothPeer { name: name.clone() };
                if let Err(error) = sessions.send(key, &command, None).await {
                    if never_sent(&error) {
                        lost = Some(error.to_string());
                        break;
                    }
                    if matches!(error, SessionError::Transport(_)) {
                        sent = Some((name, error.to_string()));
                        break;
                    }
                    set_failure(&mut last_failure, &name, error.to_string());
                    continue;
                }
                match read_peers(sessions, key).await {
                    Ok(peers) => current = peers,
                    Err(error) => {
                        sent = Some((name, error.to_string()));
                        break;
                    }
                }
                if count_of(&names_of(&current), &name) < before {
                    add_count(&mut removed, &name);
                    if let Some((_, left)) = to_go.iter_mut().find(|(n, _)| *n == name) {
                        *left = left.saturating_sub(1);
                    }
                    progress = true;
                } else {
                    set_failure(
                        &mut last_failure,
                        &name,
                        "The list read back still holds it.".to_owned(),
                    );
                }
            }
            if !progress {
                break;
            }
        }
    }

    let mut sent_shown = false;
    let entries = peers
        .iter()
        .map(|name| {
            if is_blank_peer_name(name) {
                return ClearedEntry::NotRemovable { name: name.clone() };
            }
            if let Some((_, confirmed)) = removed.iter_mut().find(|(n, c)| n == name && *c > 0) {
                *confirmed -= 1;
                return ClearedEntry::Confirmed { name: name.clone() };
            }
            if let Some((sent_name, detail)) = &sent
                && !sent_shown
                && sent_name == name
            {
                sent_shown = true;
                return ClearedEntry::Sent {
                    name: name.clone(),
                    detail: detail.clone(),
                };
            }
            let detail = last_failure
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, detail)| detail.clone())
                .unwrap_or_else(|| match (&sent, &lost) {
                    (Some((_, detail)), _) | (None, Some(detail)) => format!("Not sent: {detail}"),
                    (None, None) => "Not sent.".to_owned(),
                });
            ClearedEntry::Failed {
                name: name.clone(),
                detail,
            }
        })
        .collect();
    let mut left = current;
    if let Some((sent_name, _)) = &sent
        && let Some(at) = left.iter().position(|p| &p.name == sent_name)
    {
        left.remove(at);
    }
    Removed {
        entries,
        // A lost link is gone as surely as one the removal cut.
        link_cut: sent.is_some() || lost.is_some(),
        left,
    }
}

/// Whether `name` goes in `phase`: with no names to keep for last, every name in the one phase;
/// over Bluetooth alone, every other name first, then this computer's name, then the entries
/// marked connected.
fn in_phase(last: Option<&LastOverBluetooth>, phase: usize, name: &str) -> bool {
    let Some(last) = last else {
        return true;
    };
    let named = last.named.contains(name);
    let linked = last.linked.contains(name);
    match phase {
        0 => !named && !linked,
        1 => named && !linked,
        _ => linked,
    }
}

fn set_failure(failures: &mut Vec<(String, String)>, name: &str, detail: String) {
    match failures.iter_mut().find(|(n, _)| n == name) {
        Some((_, old)) => *old = detail,
        None => failures.push((name.to_owned(), detail)),
    }
}

fn add_count(counts: &mut Vec<(String, usize)>, name: &str) {
    match counts.iter_mut().find(|(n, _)| n == name) {
        Some((_, count)) => *count += 1,
        None => counts.push((name.to_owned(), 1)),
    }
}
