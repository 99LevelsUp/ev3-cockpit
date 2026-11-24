//! The brick's filesystem: listing, reading, writing, moving and removing.
//!
//! Two services over one brick. [`FilesystemService`] owns the single-command operations and the
//! two that have to be composed because the firmware has no primitive for them (a recursive
//! remove and a rename). Chunked reads and writes live in [`crate::transfer`], and what an
//! interrupted transfer still owes the brick in [`crate::ledger`]. [`BrickFilesystem`] binds all
//! three to one brick of a [`BrickManager`].
//!
//! Nothing here touches a path on this computer: contents go in and come out as bytes. Whoever
//! reads a local file to upload, or writes a download to one, checks that path first.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::responses::{FsEntry, parse_listing};
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_transports::BrickKey;

use crate::bricks::{BrickError, BrickManager, CommandOptions};
use crate::error::SessionError;
use crate::ledger::Ledgers;
use crate::ports::{ActivityPort, Requester, WriteActivity, WriteScope};
use crate::transfer::{BrickRoute, FileTransferService, ReadCursor};

/// The firmware copies a path into a 60-byte buffer with `snprintf` rather than rejecting an
/// over-long one, so it would act on a different path than the caller named.
pub const MAX_PATH_BYTES: usize = 60;

/// Continuations allowed for one listing before giving up.
///
/// A directory listing is bounded by the brick's storage, so this only fires if the brick never
/// reports completion: a loop guard, not a size limit.
const LIST_PAGE_LIMIT: usize = 256;

/// Bytes asked for per listing continuation.
///
/// Bounded by the firmware's 1024-byte buffer less the reply header, not by the host transport:
/// a reply is read, and reads are not subject to the USB write ceiling.
const LIST_CHUNK_BYTES: u16 = 1000;

// ── Errors ──────────────────────────────────────────────────────────

/// A filesystem operation or transfer that did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    /// Refused before anything was sent: the firmware would cut the path and act on another.
    PathTooLong { bytes: usize },
    /// Refused before anything was sent: the brick reads a path as a C string, so a control
    /// character (a NUL above all) would cut it and make the brick act on another path.
    PathHasControlCharacter,
    /// A command failed: refused before it left, lost with the link, or answered with an error
    /// by the brick (then a [`SessionError::Protocol`]).
    Command(BrickError),
    /// The exchange did not go as the protocol says: a reply of another kind, a file that ended
    /// early, a listing that never finished, a packet too small to carry anything.
    Protocol(String),
    /// The brick answered a make-directory without the directory existing afterwards.
    NotCreated { path: String },
    /// The brick refused to remove a directory that is not empty, or a path it cannot write.
    NotEmpty { path: String, source: BrickError },
    /// A move copied, then could not remove all of the original: both exist now.
    MoveIncomplete {
        from: String,
        to: String,
        /// What of the original stayed, when the brick said; empty when the removal failed.
        left_behind: Vec<String>,
        /// Why the removal failed, when it did.
        cause: Option<Box<FsError>>,
    },
    /// No step of a transfer completed within its stall window.
    Stalled {
        timeout: Duration,
        transferred: usize,
    },
    /// The caller cancelled the transfer; it stopped between two chunks.
    Cancelled,
    /// A read the caller bounded found a larger file; it stopped after the brick's first reply.
    TooLarge { bytes: usize, max: usize },
}

impl FsError {
    /// Whether the failure is a protocol one: the brick answered, or the request could not be
    /// made at all. Nothing of the link is in doubt.
    pub fn is_protocol(&self) -> bool {
        match self {
            Self::PathTooLong { .. } | Self::PathHasControlCharacter | Self::Protocol(_) => true,
            Self::Command(error) => brick_answered(error),
            _ => false,
        }
    }

    /// Whether the command that failed may have reached the brick and run, with only its reply
    /// lost. Only a failure that proves where the command stopped says no: an answer from the
    /// brick, or a refusal before it left.
    pub fn may_have_run(&self) -> bool {
        match self {
            Self::Command(error) => may_have_run(error),
            Self::Stalled { .. } => true,
            _ => false,
        }
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PathTooLong { bytes } => write!(
                f,
                "Path is {bytes} bytes; the brick truncates silently at {}. Refusing rather than \
                 acting on a different path than you named.",
                MAX_PATH_BYTES - 1
            ),
            Self::PathHasControlCharacter => f.write_str(
                "The path contains a control character; the brick would cut it there and act on \
                 a different path than you named, so it is refused.",
            ),
            Self::Command(error) => error.fmt(f),
            Self::Protocol(message) => f.write_str(message),
            Self::NotCreated { path } => write!(f, "The brick did not create {path}."),
            Self::NotEmpty { path, .. } => write!(
                f,
                "Cannot remove {path}: it is a directory that is not empty, or it is not \
                 writable. Remove it with everything in it to delete a directory with contents."
            ),
            Self::MoveIncomplete {
                from,
                to,
                left_behind,
                cause,
            } => {
                if left_behind.is_empty() {
                    write!(
                        f,
                        "Copied {from} to {to} but could not remove the original, so both now \
                         exist. The protocol has no atomic rename; remove the source manually."
                    )?;
                } else {
                    write!(
                        f,
                        "Copied {from} to {to} but the brick kept {} of the original, so both \
                         now exist. The protocol has no atomic rename; remove the source \
                         manually.",
                        left_behind.join(", ")
                    )?;
                }
                if let Some(cause) = cause {
                    write!(f, " ({cause})")?;
                }
                Ok(())
            }
            Self::Stalled {
                timeout,
                transferred,
            } => write!(
                f,
                "Transfer stalled: no chunk completed within {} ms after {transferred} bytes.",
                timeout.as_millis()
            ),
            Self::Cancelled => f.write_str("Transfer cancelled."),
            Self::TooLarge { bytes, max } => write!(
                f,
                "The file has {bytes} bytes; this read takes at most {max}. Read it to a local \
                 path or through a handle."
            ),
        }
    }
}

impl std::error::Error for FsError {}

impl From<BrickError> for FsError {
    fn from(error: BrickError) -> Self {
        Self::Command(error)
    }
}

/// A failure the brick itself answered: the command reached it.
pub fn brick_answered(error: &BrickError) -> bool {
    matches!(error, BrickError::Session(SessionError::Protocol(_)))
}

/// A failure that proves the command never left this side: a refusal by the brick layer or the
/// session before it was sent, or no route to send it over.
pub fn never_left(error: &BrickError) -> bool {
    match error {
        BrickError::NotAvailable { .. }
        | BrickError::NotSignedIn { .. }
        | BrickError::Held { .. }
        | BrickError::ConnectionAbandoned { .. }
        | BrickError::NoRoute { .. }
        | BrickError::ChannelChanged { .. } => true,
        BrickError::Session(error) => matches!(
            error,
            SessionError::NotConnected { .. }
                | SessionError::AlreadyConnected { .. }
                | SessionError::NoProvider { .. }
                | SessionError::ConnectionAbandoned { .. }
                | SessionError::LinkLost { .. }
                | SessionError::Disconnected { .. }
                | SessionError::Degraded { .. }
        ),
    }
}

/// A failure that does not prove the command stayed on this side: it may have reached the brick
/// and run, with only its reply lost.
pub fn may_have_run(error: &BrickError) -> bool {
    !never_left(error) && !brick_answered(error)
}

/// Refuses a path the firmware would cut, before anything reaches the wire.
pub fn check_path(path: &str) -> Result<(), FsError> {
    if path.chars().any(char::is_control) {
        return Err(FsError::PathHasControlCharacter);
    }
    let bytes = path.len();
    if bytes >= MAX_PATH_BYTES {
        return Err(FsError::PathTooLong { bytes });
    }
    Ok(())
}

/// The variant name of a reply, for an error that says which pair of tables disagreed.
pub(crate) fn kind_of(reply: &BrickResponse) -> String {
    let debug = format!("{reply:?}");
    debug
        .split(|c: char| !c.is_alphanumeric())
        .next()
        .unwrap_or_default()
        .to_owned()
}

pub(crate) fn unexpected(command: &BrickCommand, reply: &BrickResponse) -> FsError {
    FsError::Protocol(format!(
        "Sent {} but got a {} reply.",
        command.kind(),
        kind_of(reply)
    ))
}

// ── Reaching the brick ──────────────────────────────────────────────

/// How the filesystem service reaches a brick: one command, one reply.
#[async_trait]
pub trait CommandSender: Send + Sync {
    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError>;

    /// The channel commands go over now, for the write reports; `None` with no route.
    fn channel(&self) -> Option<BrickKey>;
}

/// One brick of a brick layer, over its best channel at each command.
pub struct BrickSender {
    bricks: BrickManager,
    brick_id: String,
    options: CommandOptions,
}

impl BrickSender {
    pub fn new(bricks: BrickManager, brick_id: impl Into<String>, options: CommandOptions) -> Self {
        Self {
            bricks,
            brick_id: brick_id.into(),
            options,
        }
    }
}

#[async_trait]
impl CommandSender for BrickSender {
    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        self.bricks
            .send(&self.brick_id, command, self.options)
            .await
    }

    fn channel(&self) -> Option<BrickKey> {
        self.bricks.route_of(&self.brick_id)
    }
}

/// Who writes reports go to, and who they are done for.
#[derive(Clone)]
pub struct WriteReporter {
    pub port: Arc<dyn ActivityPort>,
    pub requester: Requester,
}

impl WriteReporter {
    pub fn begin(&self, brick_key: BrickKey, what: String) -> WriteScope {
        WriteScope::begin(
            self.port.clone(),
            WriteActivity {
                brick_key,
                requester: self.requester.clone(),
                what,
            },
        )
    }
}

// ── The service ─────────────────────────────────────────────────────

/// Space a path occupies, as the firmware reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileSize {
    /// Kilobytes, rounded up: a 3-byte file is 1. For an exact size read the listing, whose
    /// entries carry a byte count the brick computed per file.
    pub kilobytes: u32,
    /// Files the total covers. Zero for a plain file: the firmware only counts while walking a
    /// directory.
    pub files: u32,
}

/// The brick's storage totals, in kilobytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageUsage {
    pub total_kb: u32,
    pub free_kb: u32,
}

/// What a remove could not delete.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoveReport {
    /// The paths still on the brick: each one the brick refused to delete, or could not be
    /// addressed. A directory that stays only because something in it stayed is not listed.
    pub left_behind: Vec<String>,
}

/// Every single-command operation the protocol offers on files, and the two composed ones.
pub struct FilesystemService {
    sender: Arc<dyn CommandSender>,
    writes: Option<WriteReporter>,
    cursor: Arc<ReadCursor>,
}

impl FilesystemService {
    /// Writes are reported through `writes` when given. Listings hold a cursor of their own;
    /// [`FilesystemService::with_read_cursor`] shares the brick's with its reads.
    pub fn new(sender: Arc<dyn CommandSender>, writes: Option<WriteReporter>) -> Self {
        Self {
            sender,
            writes,
            cursor: Arc::new(ReadCursor::new()),
        }
    }

    /// Listings hold `cursor`, the one the brick's reads hold too.
    #[must_use]
    pub fn with_read_cursor(mut self, cursor: Arc<ReadCursor>) -> Self {
        self.cursor = cursor;
        self
    }

    fn write_scope(&self, what: impl FnOnce() -> String) -> Option<WriteScope> {
        let writes = self.writes.as_ref()?;
        let channel = self.sender.channel()?;
        Some(writes.begin(channel, what()))
    }

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, FsError> {
        Ok(self.sender.send(command).await?)
    }

    // ── Reading ─────────────────────────────────────────────────────

    /// Lists a directory, following the brick's continuation while the listing does not fit one
    /// packet.
    ///
    /// `.` and `..` are dropped: they are real entries in the brick's reply, but a caller walking
    /// a tree with them recurses forever.
    ///
    /// Holds the brick's read cursor from its first page to its last, a one-page listing too:
    /// its `LIST_FILES` alone would take the cursor from a read in progress.
    pub async fn list(&self, path: &str) -> Result<Vec<FsEntry>, FsError> {
        check_path(path)?;
        let _cursor = self.cursor.hold().await;
        let command = BrickCommand::FsList {
            path: path.to_owned(),
        };
        let reply = self.send(&command).await?;
        let BrickResponse::FsList {
            listing: first,
            mut complete,
            mut handle,
        } = reply
        else {
            return Err(unexpected(&command, &reply));
        };
        // The pages are joined before anything is read: the brick cuts a page anywhere, and
        // carries the rest of a cut name into the next page.
        let mut listing = first;

        // The firmware's own header calls CONTINUE_LIST_FILES unimplemented, but the
        // implementation in c_com.c has it, so page while the brick says there is more.
        let mut pages = 0;
        while !complete && pages < LIST_PAGE_LIMIT {
            let Some(current) = handle else { break };
            pages += 1;
            let command = BrickCommand::FsListContinue {
                handle: current,
                want_bytes: LIST_CHUNK_BYTES,
            };
            let reply = self.send(&command).await?;
            let BrickResponse::FsListContinue {
                listing: next,
                complete: done,
                handle: next_handle,
            } = reply
            else {
                return Err(unexpected(&command, &reply));
            };
            if next.is_empty() {
                break;
            }
            listing.extend(next);
            complete = done;
            handle = Some(next_handle);
        }
        if !complete && pages >= LIST_PAGE_LIMIT {
            return Err(FsError::Protocol(format!(
                "Listing of {path} did not finish within {LIST_PAGE_LIMIT} continuations."
            )));
        }
        let mut entries = parse_listing(&listing);
        entries.retain(|entry| entry.name != "." && entry.name != "..");
        Ok(entries)
    }

    /// Whether the path resolves on the brick, file or directory: from the reply, not from the
    /// call succeeding.
    pub async fn exists(&self, path: &str) -> Result<bool, FsError> {
        check_path(path)?;
        let command = BrickCommand::FsExists {
            path: path.to_owned(),
        };
        match self.send(&command).await? {
            BrickResponse::FsExists { exists } => Ok(exists),
            reply => Err(unexpected(&command, &reply)),
        }
    }

    /// Space a path occupies, without listing its parent; for a directory, its whole tree.
    pub async fn size(&self, path: &str) -> Result<FileSize, FsError> {
        check_path(path)?;
        let command = BrickCommand::FsSize {
            path: path.to_owned(),
        };
        match self.send(&command).await? {
            BrickResponse::FsSize { kilobytes, files } => Ok(FileSize { kilobytes, files }),
            reply => Err(unexpected(&command, &reply)),
        }
    }

    /// The brick's storage totals.
    pub async fn storage(&self) -> Result<StorageUsage, FsError> {
        let command = BrickCommand::FsFreeSpace;
        match self.send(&command).await? {
            BrickResponse::FsFreeSpace { total_kb, free_kb } => {
                Ok(StorageUsage { total_kb, free_kb })
            }
            reply => Err(unexpected(&command, &reply)),
        }
    }

    // ── Structure ───────────────────────────────────────────────────

    /// Creates a directory. Succeeds when it already exists, as the firmware does.
    pub async fn make_directory(&self, path: &str) -> Result<(), FsError> {
        check_path(path)?;
        let _scope = self.write_scope(|| format!("Creating {path}"));
        let command = BrickCommand::FsMakeDirectory {
            path: path.to_owned(),
        };
        match self.send(&command).await? {
            BrickResponse::FsMakeDirectory { exists: true } => Ok(()),
            BrickResponse::FsMakeDirectory { exists: false } => Err(FsError::NotCreated {
                path: path.to_owned(),
            }),
            reply => Err(unexpected(&command, &reply)),
        }
    }

    /// Removes a file, or an empty directory.
    ///
    /// A populated directory fails: the firmware's delete is POSIX `remove()`, which refuses
    /// one. Use [`FilesystemService::remove_tree`] deliberately instead; the brick has no trash.
    pub async fn remove(&self, path: &str) -> Result<(), FsError> {
        check_path(path)?;
        let _scope = self.write_scope(|| format!("Deleting {path}"));
        let command = BrickCommand::FsDelete {
            path: path.to_owned(),
        };
        match self.sender.send(&command).await {
            Ok(BrickResponse::FsDelete { .. }) => Ok(()),
            Ok(reply) => Err(unexpected(&command, &reply)),
            // The firmware reports ENOTEMPTY as NO_PERMISSION, which reads like an access
            // problem and sends the caller looking in the wrong place.
            Err(error) if brick_answered(&error) && error.to_string().contains("NO_PERMISSION") => {
                Err(FsError::NotEmpty {
                    path: path.to_owned(),
                    source: error,
                })
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Removes a path and everything beneath it, and says what it could not. No confirmation,
    /// no undo on the brick.
    ///
    /// Walked here and deleted from the bottom up, one entry at a time: the firmware's own
    /// remove is one level deep (`cMemoryDeleteSubFolders`, `c_memory.c` 931–968), so a
    /// subdirectory with anything in it would stay, and the directory with it, without a word.
    pub async fn remove_tree(&self, path: &str) -> Result<RemoveReport, FsError> {
        check_path(path)?;
        let _scope = self.write_scope(|| format!("Deleting {path}"));
        self.remove_tree_unreported(path).await
    }

    async fn remove_tree_unreported(&self, path: &str) -> Result<RemoveReport, FsError> {
        let mut report = RemoveReport::default();
        self.remove_walk(trim_slash(path), &mut report.left_behind)
            .await?;
        Ok(report)
    }

    /// Removes several paths in one operation, each with everything beneath it when
    /// `recursive`; otherwise a directory that is not empty stays and is reported.
    pub async fn remove_paths(
        &self,
        paths: &[String],
        recursive: bool,
    ) -> Result<RemoveReport, FsError> {
        for path in paths {
            check_path(path)?;
        }
        let _scope = self.write_scope(|| format!("Deleting {}", paths.join(", ")));
        let mut report = RemoveReport::default();
        for path in paths {
            if recursive {
                self.remove_walk(trim_slash(path), &mut report.left_behind)
                    .await?;
            } else if !self.delete_one(path).await? {
                report.left_behind.push(path.clone());
            }
        }
        Ok(report)
    }

    /// Deletes what is under `path`, then `path`; adds what stays to `left_behind`. Whether
    /// `path` went.
    fn remove_walk<'a>(
        &'a self,
        path: &'a str,
        left_behind: &'a mut Vec<String>,
    ) -> futures_util::future::BoxFuture<'a, Result<bool, FsError>> {
        Box::pin(async move {
            let entries = match self.list(path).await {
                Ok(entries) => entries,
                // The brick will not list a file: the path is removed as one.
                Err(error) if error.is_protocol() => Vec::new(),
                Err(error) => return Err(error),
            };
            let mut emptied = true;
            for entry in entries {
                let child = format!("{path}/{}", entry.name);
                if child.len() >= MAX_PATH_BYTES {
                    // Out of the brick's reach by name: it stays, and so does everything above.
                    left_behind.push(child);
                    emptied = false;
                    continue;
                }
                let directory = entry.kind == ev3_protocol::responses::FsEntryKind::Directory;
                let gone = if directory {
                    self.remove_walk(&child, left_behind).await?
                } else {
                    self.delete_one(&child).await?
                };
                if !gone {
                    if !directory {
                        left_behind.push(child);
                    }
                    emptied = false;
                }
            }
            // A directory that keeps something cannot go; what it keeps is already reported.
            if !emptied {
                return Ok(false);
            }
            if self.delete_one(path).await? {
                return Ok(true);
            }
            left_behind.push(path.to_owned());
            Ok(false)
        })
    }

    /// Deletes one file or empty directory. False when it is still there: the brick refused
    /// (an error answer, or `deleted: false`) and it still exists.
    async fn delete_one(&self, path: &str) -> Result<bool, FsError> {
        let command = BrickCommand::FsDelete {
            path: path.to_owned(),
        };
        match self.sender.send(&command).await {
            Ok(BrickResponse::FsDelete { deleted: true }) => return Ok(true),
            Ok(BrickResponse::FsDelete { deleted: false }) => {}
            Ok(reply) => return Err(unexpected(&command, &reply)),
            Err(error) if brick_answered(&error) => {}
            Err(error) => return Err(error.into()),
        }
        // A refused delete of something already gone is not something left behind.
        Ok(!self.exists(path).await?)
    }

    /// Copies a file or directory tree on the brick.
    ///
    /// The copy runs brick-side, so its cost does not scale with the link.
    ///
    /// Not available over USB HID: the command carries both paths, and two stock project paths
    /// exceed the 64 bytes a HID write delivers. TCP and Bluetooth carry it inside their
    /// 1024-byte packets. The link rejects the oversized packet rather than truncating it.
    pub async fn copy(&self, from: &str, to: &str) -> Result<(), FsError> {
        check_path(from)?;
        check_path(to)?;
        let _scope = self.write_scope(|| format!("Copying {from} to {to}"));
        self.copy_unreported(from, to).await
    }

    async fn copy_unreported(&self, from: &str, to: &str) -> Result<(), FsError> {
        let command = BrickCommand::FsCopy {
            from: from.to_owned(),
            to: to.to_owned(),
        };
        match self.send(&command).await? {
            BrickResponse::FsCopy => Ok(()),
            reply => Err(unexpected(&command, &reply)),
        }
    }

    /// Renames or relocates a path.
    ///
    /// Not atomic, and it cannot be: the protocol has no rename (`opFILE/MOVE` runs `cp -r` and
    /// leaves the source), so this copies and then removes. A failure between the two leaves
    /// both copies, and the error says so.
    pub async fn move_path(&self, from: &str, to: &str) -> Result<(), FsError> {
        check_path(from)?;
        check_path(to)?;
        let _scope = self.write_scope(|| format!("Moving {from} to {to}"));
        self.copy_unreported(from, to).await?;
        let incomplete =
            |left_behind: Vec<String>, cause: Option<FsError>| FsError::MoveIncomplete {
                from: from.to_owned(),
                to: to.to_owned(),
                left_behind,
                cause: cause.map(Box::new),
            };
        match self.remove_tree_unreported(from).await {
            Ok(report) if report.left_behind.is_empty() => Ok(()),
            Ok(report) => Err(incomplete(report.left_behind, None)),
            Err(error) => Err(incomplete(Vec::new(), Some(error))),
        }
    }
}

fn trim_slash(path: &str) -> &str {
    if path.len() > 1 {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() { "/" } else { trimmed }
    } else {
        path
    }
}

// ── One brick ───────────────────────────────────────────────────────

/// The filesystem of one brick of a brick layer: the single commands over its best channel at
/// each command, transfers over one channel held for each, and the brick's debt ledger.
pub struct BrickFilesystem {
    pub files: FilesystemService,
    pub transfer: FileTransferService,
}

impl BrickFilesystem {
    /// Everything done here is done for `writes.requester`: writes are reported in that name,
    /// and a sweep of a stuck slot asks the person behind it.
    pub fn new(
        bricks: &BrickManager,
        brick_id: &str,
        ledgers: &Ledgers,
        writes: WriteReporter,
        options: CommandOptions,
    ) -> Self {
        let sender = Arc::new(BrickSender::new(bricks.clone(), brick_id, options));
        let ledger = ledgers.ledger_for(brick_id);
        Self {
            files: FilesystemService::new(sender, Some(writes.clone()))
                .with_read_cursor(ledger.read_cursor()),
            transfer: FileTransferService::new(
                Arc::new(BrickRoute::new(bricks.clone(), brick_id)),
                ledger,
                writes,
            ),
        }
    }
}
