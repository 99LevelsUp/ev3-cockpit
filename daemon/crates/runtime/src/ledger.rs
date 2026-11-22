//! The debt ledger: firmware file slots a cut transfer may have left taken.
//!
//! The firmware keeps every system-command transfer's slot, with its open file, in one global
//! table of 64 (`c_com.h` 1471–1482, 1541) that nothing clears on a disconnect or a timeout.
//! Deleting a file only unlinks it (`c_com.c` 2195–2228), so a download cut short leaves its
//! blocks taken until the brick restarts: measured at 496 KB free where a reboot gave 4600.
//! `CLOSE_FILEHANDLE` closes a slot and its file from any channel, after any reconnect (`c_com.c`
//! 2116–2150).
//!
//! So a transfer that could not release its slot (the link went before it could) leaves a debt
//! here, and the next transfer settles it before it starts: the slot closed, then a partial
//! upload's file deleted. A slot whose number was never learned (the reply to the first command
//! lost) can only be swept, 0..63; a sweep can close another host's live transfer, so it runs
//! only when a person agrees, and is not offered again once declined. The same holds for a slot
//! the brick may already have handed on: the link went with the reply to a command that frees it.
//!
//! Nothing is settled while another transfer of ours runs on the brick: its slot is one of those
//! a sweep would close. The ledger lives with the brick, not with a transfer: [`Ledgers`].
//!
//! # Stored format
//!
//! One JSON file for every brick, in the daemon's state folder ([`LedgerFile`]): an object keyed
//! by brick id as the brick layer names a brick ([`crate::guard::brick_id_of`]: the twelve
//! hardware digits in upper case without separators, or the whole channel key for a brick that
//! has none), each value the brick's debts in the order they are settled. A brick with no debts has no key. Each debt is
//! an object with a `kind`:
//!
//! - `{"kind":"slot","handle":7}`: slot 7 to close. With `"deletePath":"/home/…"` the partial
//!   file to delete after it. With `"uncertain":true` (written only when true) the brick may
//!   already have freed it, so it is closed only with a person's consent.
//! - `{"kind":"delete","path":"/home/…"}`: a partial file to delete, its slot already closed.
//! - `{"kind":"unknown"}`: a slot never learned, released only by a consented sweep of 0..63;
//!   with `"deletePath"` the partial file to delete after the sweep.
//!
//! The Node daemon's `ledger.json` has the same shape and keys its bricks the same way (its
//! `brickIdOf`), so its debts merge in key by key.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ev3_protocol::BrickCommand;
use ev3_protocol::commands::FILE_HANDLE_SLOTS;
use serde::{Deserialize, Serialize};

use crate::bricks::BrickError;
use crate::fs::{FsError, brick_answered, may_have_run};
use crate::ports::{ConsentAnswer, ConsentPort, ConsentRequest, ConsentSubject, Requester};
use crate::transfer::FileLink;

// ── Debts ───────────────────────────────────────────────────────────

/// One thing owed: a slot to close (and a file to delete), a file only, or a slot never learned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TransferDebt {
    /// A slot to close. `uncertain` when the brick may already have freed it and handed the
    /// number to the next transfer, another computer's too: closed only with consent.
    Slot {
        handle: u8,
        #[serde(
            rename = "deletePath",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        delete_path: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        uncertain: bool,
    },
    /// A partial file to delete; its slot is already closed.
    Delete { path: String },
    /// A slot never learned: only a consented sweep of every slot releases it.
    Unknown {
        #[serde(
            rename = "deletePath",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        delete_path: Option<String>,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl TransferDebt {
    /// A slot to close at once, deleting `delete_path` after it.
    pub fn slot(handle: u8, delete_path: Option<String>) -> Self {
        Self::Slot {
            handle,
            delete_path,
            uncertain: false,
        }
    }

    /// A slot the brick may already have handed on.
    pub fn uncertain_slot(handle: u8, delete_path: Option<String>) -> Self {
        Self::Slot {
            handle,
            delete_path,
            uncertain: true,
        }
    }

    fn asks(&self) -> bool {
        matches!(
            self,
            Self::Unknown { .. }
                | Self::Slot {
                    uncertain: true,
                    ..
                }
        )
    }
}

/// What a person is asked to release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseScope {
    /// Every slot, for a slot never learned.
    All,
    /// One slot whose number is known but which the brick may already have handed on.
    One,
}

impl ReleaseScope {
    /// The question, in the words the person reads.
    pub fn question(self) -> &'static str {
        match self {
            Self::All => {
                "A file transfer to the brick was cut off before the brick said which file it \
                 opened, so its space may stay taken until the brick restarts. Release it now? \
                 This closes every file the brick has open, including a transfer another \
                 computer may be running."
            }
            Self::One => {
                "A file transfer to the brick was cut off just as it finished, so the cockpit \
                 cannot tell whether the brick already let go of its file. Release it now? If \
                 another computer is sending a file to this brick right now, this may cut its \
                 transfer off."
            }
        }
    }
}

// ── The file ────────────────────────────────────────────────────────

/// A ledger file that exists and cannot be read as one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerFileError {
    pub path: PathBuf,
    pub message: String,
}

impl fmt::Display for LedgerFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "The transfer ledger {} cannot be read: {}",
            self.path.display(),
            self.message
        )
    }
}

impl std::error::Error for LedgerFileError {}

struct FileState {
    all: BTreeMap<String, Vec<TransferDebt>>,
    last_error: Option<String>,
}

/// Every brick's unpaid debts in one file, kept across daemons.
///
/// Each save writes a temporary file and renames it into place, so a crash never leaves half a
/// file; saves are made in order under one lock, so an older state never lands over a newer one.
pub struct LedgerFile {
    path: PathBuf,
    state: Mutex<FileState>,
}

impl LedgerFile {
    /// Reads the file at `path`; a file that does not exist is an empty ledger.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, LedgerFileError> {
        let path = path.into();
        let all = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| LedgerFileError {
                path: path.clone(),
                message: e.to_string(),
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => {
                return Err(LedgerFileError {
                    path,
                    message: e.to_string(),
                });
            }
        };
        Ok(Self {
            path,
            state: Mutex::new(FileState {
                all,
                last_error: None,
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> MutexGuard<'_, FileState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The debts a brick has in the file.
    pub fn load(&self, brick_id: &str) -> Vec<TransferDebt> {
        self.lock().all.get(brick_id).cloned().unwrap_or_default()
    }

    /// Replaces a brick's debts and writes the file. A failed write keeps the debts in memory
    /// and is told by [`LedgerFile::last_error`]; the next save writes everything again.
    pub fn save(&self, brick_id: &str, debts: &[TransferDebt]) {
        let mut state = self.lock();
        if debts.is_empty() {
            state.all.remove(brick_id);
        } else {
            state.all.insert(brick_id.to_owned(), debts.to_vec());
        }
        state.last_error = write_atomically(&self.path, &state.all).err();
    }

    /// Why the last save did not reach the disk; `None` when it did.
    pub fn last_error(&self) -> Option<String> {
        self.lock().last_error.clone()
    }
}

fn write_atomically(path: &Path, all: &BTreeMap<String, Vec<TransferDebt>>) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(all).map_err(|e| e.to_string())?;
    text.push('\n');
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp = PathBuf::from(temp);
    write_private(&temp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// Writes a file only its owner can read: it names the files on a person's bricks.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

// ── One brick's ledger ──────────────────────────────────────────────

#[derive(Default)]
struct LedgerState {
    debts: Vec<TransferDebt>,
    /// Transfers of ours running on the brick now.
    active: usize,
}

/// What one brick is owed, and paying it before a transfer starts.
pub struct TransferLedger {
    brick_id: String,
    consent: Arc<dyn ConsentPort>,
    store: Option<Arc<LedgerFile>>,
    state: Mutex<LedgerState>,
    /// Admission: one transfer is let in at a time, and a settlement runs inside it, so no
    /// transfer starts under a settlement and none is settled under a transfer. Fair, so a
    /// transfer that came first is let in first.
    admission: tokio::sync::Mutex<()>,
}

/// A transfer counted in: while one stands, nothing is settled. Counted out when dropped.
pub struct ActiveTransfer<'a> {
    ledger: &'a TransferLedger,
}

impl Drop for ActiveTransfer<'_> {
    fn drop(&mut self) {
        let mut state = self.ledger.lock();
        state.active = state.active.saturating_sub(1);
    }
}

impl TransferLedger {
    /// The ledger of one brick, taking over the debts `store` holds for it. Without a store the
    /// debts last as long as the process.
    pub fn new(
        brick_id: impl Into<String>,
        consent: Arc<dyn ConsentPort>,
        store: Option<Arc<LedgerFile>>,
    ) -> Self {
        let brick_id = brick_id.into();
        let debts = store
            .as_ref()
            .map(|s| s.load(&brick_id))
            .unwrap_or_default();
        Self {
            brick_id,
            consent,
            store,
            state: Mutex::new(LedgerState { debts, active: 0 }),
            admission: tokio::sync::Mutex::new(()),
        }
    }

    pub fn brick_id(&self) -> &str {
        &self.brick_id
    }

    fn lock(&self) -> MutexGuard<'_, LedgerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// How many debts wait.
    pub fn pending(&self) -> usize {
        self.lock().debts.len()
    }

    /// What is owed now.
    pub fn snapshot(&self) -> Vec<TransferDebt> {
        self.lock().debts.clone()
    }

    /// Changes the debts and saves them, under the lock, so saves land in the order of changes.
    fn change(&self, f: impl FnOnce(&mut Vec<TransferDebt>)) {
        let mut state = self.lock();
        f(&mut state.debts);
        if let Some(store) = &self.store {
            store.save(&self.brick_id, &state.debts);
        }
    }

    /// Replaces the first debt equal to `from` with `to`, or removes it.
    fn replace(&self, from: &TransferDebt, to: Option<TransferDebt>) {
        self.change(|debts| {
            if let Some(at) = debts.iter().position(|d| d == from) {
                match to {
                    Some(to) => debts[at] = to,
                    None => {
                        debts.remove(at);
                    }
                }
            }
        });
    }

    pub fn owe(&self, debt: TransferDebt) {
        self.change(|debts| debts.push(debt));
    }

    /// A write to `path` completed: no debt may delete what is now a whole file. A debt to
    /// delete the path goes, and a slot owed keeps its slot but no longer deletes.
    pub fn written(&self, path: &str) {
        self.change(|debts| {
            debts.retain(|d| !matches!(d, TransferDebt::Delete { path: p } if p == path));
            for debt in debts.iter_mut() {
                match debt {
                    TransferDebt::Slot { delete_path, .. }
                    | TransferDebt::Unknown { delete_path }
                        if delete_path.as_deref() == Some(path) =>
                    {
                        *delete_path = None;
                    }
                    _ => {}
                }
            }
        });
    }

    /// Called before a transfer: settles the debts when no other transfer of ours runs, then
    /// counts this one in. Fails, starting nothing, when settling found the link gone. A sweep is
    /// asked of the person behind `requester`.
    pub async fn begin(
        &self,
        link: &dyn FileLink,
        requester: &Requester,
    ) -> Result<ActiveTransfer<'_>, FsError> {
        let _admitted = self.admission.lock().await;
        let settle = {
            let state = self.lock();
            state.active == 0 && !state.debts.is_empty()
        };
        if settle {
            self.settle(link, requester).await?;
        }
        self.lock().active += 1;
        Ok(ActiveTransfer { ledger: self })
    }

    /// Pays what it can; stops at the first sign the link is gone and keeps the rest.
    ///
    /// Each debt stays in the ledger until it is paid, and a close on its way is recorded as one
    /// that may have run, so a settlement dropped halfway leaves nothing unrecorded and never
    /// closes a slot unasked that the brick may since have handed on.
    async fn settle(&self, link: &dyn FileLink, requester: &Requester) -> Result<(), FsError> {
        let debts = self.snapshot();
        let mut link_error: Option<BrickError> = None;
        let mut asking: Vec<TransferDebt> = Vec::new();

        for debt in debts {
            if link_error.is_some() {
                break;
            }
            if debt.asks() {
                asking.push(debt);
                continue;
            }
            let path = match &debt {
                TransferDebt::Slot {
                    handle,
                    delete_path,
                    ..
                } => {
                    let in_flight = TransferDebt::uncertain_slot(*handle, delete_path.clone());
                    self.replace(&debt, Some(in_flight.clone()));
                    match close(link, *handle).await {
                        Ok(()) => {
                            let rest = delete_path
                                .clone()
                                .map(|path| TransferDebt::Delete { path });
                            self.replace(&in_flight, rest);
                        }
                        Err(error) => {
                            // A close that may have run freed the slot for someone else: asked
                            // about from now on.
                            let kept = if may_have_run(&error) {
                                in_flight.clone()
                            } else {
                                debt.clone()
                            };
                            self.replace(&in_flight, Some(kept));
                            link_error = Some(error);
                            continue;
                        }
                    }
                    delete_path.clone()
                }
                TransferDebt::Delete { path } => Some(path.clone()),
                TransferDebt::Unknown { .. } => None,
            };
            if let Some(path) = path {
                let owed = TransferDebt::Delete { path: path.clone() };
                match remove(link, &path).await {
                    Ok(()) => self.replace(&owed, None),
                    Err(error) => link_error = Some(error),
                }
            }
        }

        // A slot never learned needs every slot closed, one question for them all; otherwise
        // each uncertain slot is its own question, so a yes releases that slot alone.
        let mut groups: Vec<(ReleaseScope, Vec<TransferDebt>, Vec<u8>)> = Vec::new();
        if asking
            .iter()
            .any(|d| matches!(d, TransferDebt::Unknown { .. }))
        {
            groups.push((ReleaseScope::All, asking, (0..FILE_HANDLE_SLOTS).collect()));
        } else {
            for debt in asking {
                let TransferDebt::Slot { handle, .. } = debt else {
                    continue;
                };
                match groups
                    .iter_mut()
                    .find(|(_, _, handles)| handles[0] == handle)
                {
                    Some((_, debts, _)) => debts.push(debt),
                    None => groups.push((ReleaseScope::One, vec![debt], vec![handle])),
                }
            }
        }

        for (scope, debts, handles) in groups {
            if link_error.is_some() {
                break;
            }
            let answer = self
                .consent
                .ask(ConsentRequest {
                    requester: requester.clone(),
                    brick_key: Some(link.brick_key().clone()),
                    action: scope.question().to_owned(),
                    subject: ConsentSubject::ReleaseSlots {
                        brick_id: self.brick_id().to_owned(),
                    },
                })
                .await;
            match answer {
                ConsentAnswer::Granted => {
                    if let Err(error) = release(link, &debts, &handles).await {
                        link_error = Some(error);
                    } else {
                        for debt in &debts {
                            self.replace(debt, None);
                        }
                    }
                }
                // Declined: dropped, and not offered again; a reboot frees the slot too.
                ConsentAnswer::Declined => {
                    for debt in &debts {
                        self.replace(debt, None);
                    }
                }
                // Not an answer: kept, to be asked again.
                ConsentAnswer::Unanswered => {}
            }
        }

        match link_error {
            Some(error) => Err(FsError::Command(error)),
            None => Ok(()),
        }
    }
}

/// Closes a slot; "unknown handle" is the brick saying it is already free.
async fn close(link: &dyn FileLink, handle: u8) -> Result<(), BrickError> {
    match link.send(&BrickCommand::FsCloseHandle { handle }).await {
        Err(error) if !brick_answered(&error) => Err(error),
        _ => Ok(()),
    }
}

/// Deletes a file; any answer from the brick settles it.
async fn remove(link: &dyn FileLink, path: &str) -> Result<(), BrickError> {
    let command = BrickCommand::FsDelete {
        path: path.to_owned(),
    };
    match link.send(&command).await {
        Err(error) if !brick_answered(&error) => Err(error),
        _ => Ok(()),
    }
}

/// Closes the slots a person agreed to release, then deletes the partial files they held.
async fn release(
    link: &dyn FileLink,
    debts: &[TransferDebt],
    handles: &[u8],
) -> Result<(), BrickError> {
    for handle in handles {
        close(link, *handle).await?;
    }
    for debt in debts {
        if let TransferDebt::Slot {
            delete_path: Some(path),
            ..
        }
        | TransferDebt::Unknown {
            delete_path: Some(path),
        } = debt
        {
            remove(link, path).await?;
        }
    }
    Ok(())
}

// ── Every brick's ledger ────────────────────────────────────────────

/// The ledgers of a brick layer, one per brick: they outlive the transfers built per call.
pub struct Ledgers {
    consent: Arc<dyn ConsentPort>,
    store: Option<Arc<LedgerFile>>,
    by_brick: Mutex<HashMap<String, Arc<TransferLedger>>>,
}

impl Ledgers {
    /// Ledgers that ask `consent` before a sweep and keep their debts in `store`, so a daemon
    /// that ends with debts unpaid leaves them to the next one.
    pub fn new(consent: Arc<dyn ConsentPort>, store: Option<Arc<LedgerFile>>) -> Self {
        Self {
            consent,
            store,
            by_brick: Mutex::new(HashMap::new()),
        }
    }

    /// The ledger of one brick, by the id the brick layer names it with.
    pub fn ledger_for(&self, brick_id: &str) -> Arc<TransferLedger> {
        let mut by_brick = self.by_brick.lock().unwrap_or_else(PoisonError::into_inner);
        by_brick
            .entry(brick_id.to_owned())
            .or_insert_with(|| {
                Arc::new(TransferLedger::new(
                    brick_id,
                    self.consent.clone(),
                    self.store.clone(),
                ))
            })
            .clone()
    }
}
