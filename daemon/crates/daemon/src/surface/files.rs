//! The file methods and transfer handles.
//!
//! Every local path a client names is confined before anything else about the request: before the
//! brick is resolved, before a byte is read from it or written to it.

use std::sync::{Arc, Weak};
use std::time::Duration;

use ev3_contract::{
    ContractError, ErrorCode, FileAppended, FileExists, FileFollowEnded, FileFollowEndedReason,
    FileFollowSubscription, FileSize, FilesFollowParams, FilesMoveParams, FilesReadParams,
    FilesReadResult, FilesRemoveParams, FilesRemovePathsParams, FilesWriteParams, FilesWriteResult,
    FsEntry, FsEntryKind, FsListing, Notification, PathParams, RemoveReport, TransferBeginParams,
    TransferBeginResult, TransferChunk, TransferHandleParams, TransferWriteParams,
};
use ev3_protocol::commands::READ_FROM_MAX_BYTES;
use ev3_runtime::bricks::CommandOptions;
use ev3_runtime::{
    BrickSender, CancelFlag, FilesystemService, FsError, ReadFrom, TransferOptions,
    read_from_budget,
};
use tokio_util::sync::CancellationToken;

use super::{Handle, Subscription, Surface, encoding, errors, new_id};
use crate::access::Operation;
use crate::log::Level;
use crate::rpc::RequestContext;

/// Small files are read inline up to this size.
pub const MAX_INLINE_READ_BYTES: usize = 64 * 1024;
/// Inline content written with a request, at most.
pub const MAX_INLINE_WRITE_BYTES: usize = 4 * 1024;
/// Chunks of file content in a transfer handle: 48 KiB, 64 KiB as base64.
pub const TRANSFER_CHUNK_BYTES: usize = 48 * 1024;
/// The largest upload buffer.
pub const MAX_TRANSFER_BYTES: u64 = 64 * 1024 * 1024;

/// A cancel flag that follows a token, for the runtime, while it lives.
pub(super) struct FollowedCancel {
    pub flag: CancelFlag,
    task: tokio::task::AbortHandle,
}

impl Drop for FollowedCancel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) fn cancel_flag(token: &CancellationToken) -> FollowedCancel {
    let flag = CancelFlag::new();
    let (follow, token) = (flag.clone(), token.clone());
    let task = tokio::spawn(async move {
        token.cancelled().await;
        follow.cancel();
    })
    .abort_handle();
    FollowedCancel { flag, task }
}

fn transfer_options(cancel: &FollowedCancel) -> TransferOptions {
    TransferOptions {
        cancel: Some(cancel.flag.clone()),
        ..TransferOptions::default()
    }
}

fn entry_of(entry: ev3_protocol::responses::FsEntry) -> FsEntry {
    FsEntry {
        name: entry.name,
        kind: match entry.kind {
            ev3_protocol::responses::FsEntryKind::File => FsEntryKind::File,
            ev3_protocol::responses::FsEntryKind::Directory => FsEntryKind::Directory,
            ev3_protocol::responses::FsEntryKind::Unknown => FsEntryKind::Unknown,
        },
        bytes: entry.bytes.map(u64::from),
        md5: entry.md5,
    }
}

fn no_handle(kind: &str) -> ContractError {
    ContractError::new(ErrorCode::InvalidRequest, format!("No such {kind} handle."))
}

impl Surface {
    pub async fn files_list(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<FsListing, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let entries = self
            .filesystem(cx, &brick_id)
            .files
            .list(&params.path)
            .await
            .map_err(|e| errors::from_fs(&e))?;
        Ok(FsListing {
            entries: entries.into_iter().map(entry_of).collect(),
        })
    }

    pub async fn files_exists(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<FileExists, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let exists = self
            .filesystem(cx, &brick_id)
            .files
            .exists(&params.path)
            .await
            .map_err(|e| errors::from_fs(&e))?;
        Ok(FileExists { exists })
    }

    pub async fn files_size(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<FileSize, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let size = self
            .filesystem(cx, &brick_id)
            .files
            .size(&params.path)
            .await
            .map_err(|e| errors::from_fs(&e))?;
        Ok(FileSize {
            files: u64::from(size.files),
            kilobytes: u64::from(size.kilobytes),
        })
    }

    pub async fn files_read(
        &self,
        cx: &RequestContext,
        params: FilesReadParams,
    ) -> Result<FilesReadResult, ContractError> {
        let target = params
            .to_local_path
            .as_deref()
            .map(|path| self.local_path(path, "toLocalPath"))
            .transpose()?;
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let cancel = cancel_flag(&cx.cancel);
        // An inline read refuses a larger file as soon as the brick says its size, rather than
        // after the whole file crossed the link.
        let inline = target.is_none() && params.inline == Some(true);
        let options = TransferOptions {
            max_bytes: inline.then_some(MAX_INLINE_READ_BYTES),
            ..transfer_options(&cancel)
        };
        let data = self
            .filesystem(cx, &brick_id)
            .transfer
            .read_file(&params.path, &options)
            .await
            .map_err(|e| errors::from_fs(&e))?;
        let bytes = data.len() as u64;
        if let (Some(target), Some(named)) = (target, params.to_local_path.as_deref()) {
            self.write_local(named, &target, &data)?;
            return Ok(FilesReadResult {
                bytes,
                content: None,
                handle: None,
            });
        }
        if params.inline == Some(true) {
            if data.len() > MAX_INLINE_READ_BYTES {
                return Err(ContractError::new(
                    ErrorCode::InvalidRequest,
                    format!(
                        "The file has {} bytes; inline reads take at most \
                         {MAX_INLINE_READ_BYTES}. Read it to a local path or through a handle.",
                        data.len()
                    ),
                ));
            }
            return Ok(FilesReadResult {
                bytes,
                content: Some(encoding::encode(&data)),
                handle: None,
            });
        }
        let handle = new_id();
        self.lock().handles.insert(
            handle.clone(),
            Handle {
                connection: cx.client.id,
                data,
                offset: 0,
                upload: false,
            },
        );
        Ok(FilesReadResult {
            bytes,
            content: None,
            handle: Some(handle),
        })
    }

    pub async fn files_write(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: FilesWriteParams,
    ) -> Result<FilesWriteResult, ContractError> {
        let source = params
            .from_local_path
            .as_deref()
            .map(|path| self.local_path(path, "fromLocalPath"))
            .transpose()?;
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        self.allowed(Operation::Write, Some(&params.path))?;
        let data = if let (Some(source), Some(named)) = (source, params.from_local_path.as_deref())
        {
            self.read_local(named, &source)?
        } else if let Some(content) = &params.content {
            let data = encoding::decode(content, "content")?;
            if data.len() > MAX_INLINE_WRITE_BYTES {
                return Err(ContractError::new(
                    ErrorCode::InvalidRequest,
                    format!(
                        "Inline content takes at most {MAX_INLINE_WRITE_BYTES} bytes; send a \
                         local path or a handle."
                    ),
                ));
            }
            data
        } else if let Some(handle) = &params.handle {
            let mut state = self.lock();
            match state.handles.get(handle) {
                Some(h) if h.upload && h.connection == cx.client.id => {}
                _ => return Err(no_handle("upload")),
            }
            let mut h = state.handles.remove(handle).expect("checked above");
            h.data.truncate(h.offset);
            h.data
        } else {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                "files/write needs fromLocalPath, content or handle.",
            ));
        };
        let bytes = data.len() as u64;
        let fs = self.filesystem(cx, &brick_id);
        let path = params.path.clone();
        self.leased(cx, &brick_id, move |token| async move {
            let cancel = cancel_flag(&token);
            fs.transfer
                .write_file(&path, &data, &transfer_options(&cancel))
                .await
                .map_err(|e| errors::from_fs(&e))
        })
        .await?;
        Ok(FilesWriteResult { bytes })
    }

    pub async fn files_make_directory(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<(), ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        self.allowed(Operation::Write, Some(&params.path))?;
        let fs = self.filesystem(cx, &brick_id);
        let path = params.path;
        self.leased(cx, &brick_id, move |_| async move {
            fs.files
                .make_directory(&path)
                .await
                .map_err(|e| errors::from_fs(&e))
        })
        .await
    }

    pub async fn files_remove(
        &self,
        cx: &RequestContext,
        params: FilesRemoveParams,
    ) -> Result<RemoveReport, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        self.allowed(Operation::Delete, Some(&params.path))?;
        let fs = self.filesystem(cx, &brick_id);
        let (path, recursive) = (params.path, params.recursive == Some(true));
        self.leased(cx, &brick_id, move |_| async move {
            if recursive {
                fs.files
                    .remove_tree(&path)
                    .await
                    .map(|report| RemoveReport {
                        left_behind: report.left_behind,
                    })
                    .map_err(|e| errors::from_fs(&e))
            } else {
                fs.files
                    .remove(&path)
                    .await
                    .map(|()| RemoveReport {
                        left_behind: Vec::new(),
                    })
                    .map_err(|e| errors::from_fs(&e))
            }
        })
        .await
    }

    pub async fn files_remove_paths(
        &self,
        cx: &RequestContext,
        params: FilesRemovePathsParams,
    ) -> Result<RemoveReport, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        for path in &params.paths {
            self.allowed(Operation::Delete, Some(path))?;
        }
        let fs = self.filesystem(cx, &brick_id);
        let (paths, recursive) = (params.paths, params.recursive == Some(true));
        self.leased(cx, &brick_id, move |_| async move {
            fs.files
                .remove_paths(&paths, recursive)
                .await
                .map(|report| RemoveReport {
                    left_behind: report.left_behind,
                })
                .map_err(|e| errors::from_fs(&e))
        })
        .await
    }

    pub async fn files_move(
        &self,
        cx: &RequestContext,
        params: FilesMoveParams,
    ) -> Result<(), ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        self.allowed(Operation::Delete, Some(&params.from))?;
        self.allowed(Operation::Write, Some(&params.to))?;
        let fs = self.filesystem(cx, &brick_id);
        let (from, to) = (params.from, params.to);
        self.leased(cx, &brick_id, move |_| async move {
            fs.files
                .move_path(&from, &to)
                .await
                .map_err(|e| errors::from_fs(&e))
        })
        .await
    }

    // ── Transfer handles ────────────────────────────────────────────

    pub fn transfer_begin(
        &self,
        cx: &RequestContext,
        params: TransferBeginParams,
    ) -> Result<TransferBeginResult, ContractError> {
        if params.size > MAX_TRANSFER_BYTES {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                "transfer/begin needs a size up to 64 MiB.",
            ));
        }
        let handle = new_id();
        self.lock().handles.insert(
            handle.clone(),
            Handle {
                connection: cx.client.id,
                data: vec![0; params.size as usize],
                offset: 0,
                upload: true,
            },
        );
        Ok(TransferBeginResult {
            handle,
            chunk_bytes: std::num::NonZeroU64::new(TRANSFER_CHUNK_BYTES as u64)
                .expect("a chunk is not empty"),
        })
    }

    pub fn transfer_write(
        &self,
        cx: &RequestContext,
        params: TransferWriteParams,
    ) -> Result<(), ContractError> {
        let chunk = encoding::decode(&params.data, "data")?;
        let mut state = self.lock();
        let handle = match state.handles.get_mut(&params.handle) {
            Some(h) if h.upload && h.connection == cx.client.id => h,
            _ => return Err(no_handle("upload")),
        };
        if handle.offset + chunk.len() > handle.data.len() {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                "More data than the size begun.",
            ));
        }
        handle.data[handle.offset..handle.offset + chunk.len()].copy_from_slice(&chunk);
        handle.offset += chunk.len();
        Ok(())
    }

    pub fn transfer_read(
        &self,
        cx: &RequestContext,
        params: TransferHandleParams,
    ) -> Result<TransferChunk, ContractError> {
        let mut state = self.lock();
        let handle = match state.handles.get_mut(&params.handle) {
            Some(h) if !h.upload && h.connection == cx.client.id => h,
            _ => return Err(no_handle("download")),
        };
        let end = (handle.offset + TRANSFER_CHUNK_BYTES).min(handle.data.len());
        let data = encoding::encode(&handle.data[handle.offset..end]);
        handle.offset = end;
        let done = handle.offset >= handle.data.len();
        if done {
            state.handles.remove(&params.handle);
        }
        Ok(TransferChunk { data, done })
    }

    pub fn transfer_close(&self, cx: &RequestContext, params: TransferHandleParams) {
        let mut state = self.lock();
        if state
            .handles
            .get(&params.handle)
            .is_some_and(|h| h.connection == cx.client.id)
        {
            state.handles.remove(&params.handle);
        }
    }

    // ── Following a file ────────────────────────────────────────────

    fn follows_on(state: &super::State, brick_id: &str) -> usize {
        state
            .subscriptions
            .values()
            .flat_map(|subscriptions| subscriptions.values())
            .filter(|s| matches!(s, Subscription::Follow { brick_id: b, .. } if b == brick_id))
            .count()
    }

    /// Follows a file as it grows: each poll is one read from the offset reached
    /// ([`ev3_runtime::FilesystemService::read_from`]), so only new bytes cross the link, nothing
    /// stays open on the brick between two polls, and nothing is owed when the link goes.
    pub async fn files_follow(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: FilesFollowParams,
    ) -> Result<FileFollowSubscription, ContractError> {
        // The whole path, not only its folder: every poll names it, and a path the brick would cut
        // would fail every poll.
        ev3_runtime::fs::check_path(&params.path).map_err(|e| errors::from_fs(&e))?;
        let from = params.from_offset.unwrap_or(0);
        let offset = u32::try_from(from)
            .ok()
            .filter(|offset| i32::try_from(*offset).is_ok())
            .ok_or_else(|| {
                ContractError::new(
                    ErrorCode::InvalidRequest,
                    format!("fromOffset {from} is past what the brick can skip to."),
                )
            })?;
        let (folder, name) = match params.path.rsplit_once('/') {
            Some((folder, name)) if !name.is_empty() => {
                (if folder.is_empty() { "/" } else { folder }, name)
            }
            _ => {
                return Err(ContractError::new(
                    ErrorCode::InvalidRequest,
                    format!("{} does not name a file in a folder.", params.path),
                ));
            }
        };
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        room_for_follow(&self.lock(), &brick_id)?;
        // The folder's listing tells a file from a folder, which a read from an offset cannot,
        // and gives its exact size.
        let not_found = || {
            ContractError::new(
                ErrorCode::FileNotFound,
                format!("No file {} on the brick yet.", params.path),
            )
        };
        let entries = match self.filesystem(cx, &brick_id).files.list(folder).await {
            Ok(entries) => entries,
            // The brick refused the folder: it is not there.
            Err(error) if error.is_protocol() => return Err(not_found()),
            Err(error) => return Err(errors::from_fs(&error)),
        };
        let size = match entries.iter().find(|entry| entry.name == name) {
            None => return Err(not_found()),
            Some(entry) if entry.kind != ev3_protocol::responses::FsEntryKind::File => {
                return Err(ContractError::new(
                    ErrorCode::InvalidRequest,
                    format!("{} is not a file.", params.path),
                ));
            }
            Some(entry) => entry.bytes.map_or(0, u64::from),
        };

        let id = new_id();
        let task = tokio::spawn(follow(
            Arc::downgrade(self),
            Followed {
                client: cx.client.clone(),
                subscription_id: id.clone(),
                brick_id: brick_id.clone(),
                path: params.path.clone(),
            },
            offset,
        ))
        .abort_handle();
        {
            let mut state = self.lock();
            // Counted again with the insert: two follows asked for at once may not both pass.
            if let Err(error) = room_for_follow(&state, &brick_id) {
                task.abort();
                return Err(error);
            }
            state.subscriptions.entry(cx.client.id).or_default().insert(
                id.clone(),
                Subscription::Follow {
                    task,
                    brick_id: brick_id.clone(),
                },
            );
        }
        self.shared.log.write(
            Level::Info,
            Some(&cx.client.info.name),
            &format!("Following {} on {brick_id} from {from}", params.path),
        );
        Ok(FileFollowSubscription {
            subscription_id: id,
            offset: from,
            size,
        })
    }

    /// A follow ended on its own: it is no longer the client's, and the client hears why.
    fn follow_ended(
        &self,
        followed: &Followed,
        reason: FileFollowEndedReason,
        message: Option<String>,
    ) {
        let removed = self
            .lock()
            .subscriptions
            .get_mut(&followed.client.id)
            .and_then(|subscriptions| subscriptions.remove(&followed.subscription_id))
            .is_some();
        if !removed {
            return;
        }
        self.shared.log.write(
            Level::Info,
            Some(&followed.client.info.name),
            &format!(
                "Stopped following {} on {}: {reason}{}",
                followed.path,
                followed.brick_id,
                message
                    .as_deref()
                    .map(|m| format!(" ({m})"))
                    .unwrap_or_default()
            ),
        );
        let notification = Notification::FilesFollowEnded(FileFollowEnded {
            subscription_id: followed.subscription_id.clone(),
            reason,
            message,
        });
        if let Ok(params) = notification.params() {
            followed.client.peer.notify(notification.method(), params);
        }
    }
}

/// Follows each brick may have, for every client together: each poll is a command the brick
/// runs, between everything else it is asked.
pub const MAX_FOLLOWS_PER_BRICK: usize = 2;
/// The first poll, and the pause after one that found new bytes.
const FOLLOW_GROWING: Duration = Duration::from_millis(250);
/// The longest pause of a file that does not grow: each poll that finds nothing doubles it.
const FOLLOW_IDLE: Duration = Duration::from_secs(2);
/// The pause after a poll that failed: the link is away, or the brick did not answer.
const FOLLOW_TROUBLE: Duration = Duration::from_secs(3);
/// Refused polls in a row that end a follow as failed.
const FOLLOW_REFUSALS: u32 = 3;

/// Refuses a follow when the brick has its follows already.
fn room_for_follow(state: &super::State, brick_id: &str) -> Result<(), ContractError> {
    if Surface::follows_on(state, brick_id) >= MAX_FOLLOWS_PER_BRICK {
        return Err(too_many_follows());
    }
    Ok(())
}

fn too_many_follows() -> ContractError {
    ContractError::new(
        ErrorCode::InvalidRequest,
        format!("The brick has {MAX_FOLLOWS_PER_BRICK} follows already; cancel one first."),
    )
}

/// What one follow hands over, and to whom.
struct Followed {
    client: Arc<crate::state::ClientEntry>,
    subscription_id: String,
    brick_id: String,
    path: String,
}

/// The poll loop of one follow, until it ends or is aborted. Waits before its first poll, so
/// the client has the follow's answer before its first `files/appended`.
async fn follow(surface: Weak<Surface>, followed: Followed, mut offset: u32) {
    let mut pause = FOLLOW_GROWING;
    // Polls the brick refused in a row: what it refuses three times it will refuse for good.
    let mut refused = 0;
    loop {
        tokio::time::sleep(pause).await;
        let Some(surface) = surface.upgrade() else {
            return;
        };
        if !surface.runtime.bricks.is_signed_in(&followed.brick_id) {
            surface.follow_ended(&followed, FileFollowEndedReason::SignedOut, None);
            return;
        }
        let files = FilesystemService::new(
            Arc::new(BrickSender::new(
                surface.runtime.bricks.clone(),
                followed.brick_id.as_str(),
                CommandOptions {
                    timeout: Some(read_from_budget(offset)),
                    deadline: None,
                },
            )),
            None,
        );
        let read = files
            .read_from(&followed.path, offset, READ_FROM_MAX_BYTES)
            .await;
        if !matches!(read, Err(ref e) if e.is_protocol()) {
            refused = 0;
        }
        match after_poll(read, offset, pause) {
            Poll::Ended(reason) => {
                surface.follow_ended(&followed, reason, None);
                return;
            }
            Poll::Refused(message) => {
                refused += 1;
                if refused >= FOLLOW_REFUSALS {
                    surface.follow_ended(&followed, FileFollowEndedReason::Failed, Some(message));
                    return;
                }
                pause = FOLLOW_TROUBLE;
                continue;
            }
            Poll::Appended { data, next } => {
                let notification = Notification::FilesAppended(FileAppended {
                    subscription_id: followed.subscription_id.clone(),
                    offset: u64::from(offset),
                    data: encoding::encode(&data),
                });
                if let Ok(params) = notification.params() {
                    followed.client.peer.notify(notification.method(), params);
                }
                offset += data.len() as u32;
                pause = next;
            }
            Poll::Wait(next) => pause = next,
        }
    }
}

/// What a follow does after one poll.
#[derive(Debug, PartialEq, Eq)]
enum Poll {
    /// Hand over the bytes the file grew by, then wait `next`.
    Appended {
        data: Vec<u8>,
        next: Duration,
    },
    /// Nothing new, or the link failed the poll: wait `next` and ask again.
    Wait(Duration),
    /// The brick refused the read, or it was refused before it left: a few times in a row end the
    /// follow, so a client does not wait on one that can never deliver.
    Refused(String),
    Ended(FileFollowEndedReason),
}

/// The step after a poll at `offset` that waited `pause` before it: often while the file grows,
/// less and less often while it does not, and at once while more waits on the brick than one
/// poll brings.
fn after_poll(read: Result<ReadFrom, FsError>, offset: u32, pause: Duration) -> Poll {
    match read {
        Ok(read) if !read.exists => Poll::Ended(FileFollowEndedReason::Removed),
        Ok(read) if read.size < offset => Poll::Ended(FileFollowEndedReason::Replaced),
        Ok(read) if !read.chunk.is_empty() => {
            let reached = u64::from(offset) + read.chunk.len() as u64;
            let next = if u64::from(read.size) > reached {
                Duration::ZERO
            } else {
                FOLLOW_GROWING
            };
            Poll::Appended {
                data: read.chunk,
                next,
            }
        }
        Ok(_) => Poll::Wait((pause * 2).clamp(FOLLOW_GROWING, FOLLOW_IDLE)),
        Err(error) if error.is_protocol() => Poll::Refused(error.to_string()),
        Err(_) => Poll::Wait(FOLLOW_TROUBLE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(exists: bool, size: u32, chunk: &[u8]) -> Result<ReadFrom, FsError> {
        Ok(ReadFrom {
            exists,
            size,
            chunk: chunk.to_vec(),
        })
    }

    #[test]
    fn hands_over_new_bytes_and_asks_again_at_once_while_more_waits() {
        assert_eq!(
            after_poll(read(true, 5000, b"abc"), 10, FOLLOW_IDLE),
            Poll::Appended {
                data: b"abc".to_vec(),
                next: Duration::ZERO
            }
        );
        assert_eq!(
            after_poll(read(true, 13, b"abc"), 10, FOLLOW_IDLE),
            Poll::Appended {
                data: b"abc".to_vec(),
                next: FOLLOW_GROWING
            }
        );
    }

    #[test]
    fn asks_less_often_while_the_file_does_not_grow_and_again_often_once_it_does() {
        let mut pause = FOLLOW_GROWING;
        let mut pauses = Vec::new();
        for _ in 0..5 {
            let Poll::Wait(next) = after_poll(read(true, 10, b""), 10, pause) else {
                panic!("nothing new is a wait");
            };
            pauses.push(next);
            pause = next;
        }
        assert_eq!(
            pauses,
            [500, 1000, 2000, 2000, 2000].map(Duration::from_millis)
        );
        assert!(matches!(
            after_poll(read(true, 11, b"x"), 10, pause),
            Poll::Appended { next, .. } if next == FOLLOW_GROWING
        ));
    }

    #[test]
    fn ends_when_the_file_goes_or_is_replaced_by_a_shorter_one_and_waits_out_a_failed_poll() {
        assert_eq!(
            after_poll(read(false, 0, b""), 10, FOLLOW_GROWING),
            Poll::Ended(FileFollowEndedReason::Removed)
        );
        assert_eq!(
            after_poll(read(true, 4, b""), 10, FOLLOW_GROWING),
            Poll::Ended(FileFollowEndedReason::Replaced)
        );
        // At the offset exactly: the same file, nothing new.
        assert_eq!(
            after_poll(read(true, 10, b""), 10, FOLLOW_GROWING),
            Poll::Wait(Duration::from_millis(500))
        );
        assert_eq!(
            after_poll(Err(FsError::Cancelled), 10, FOLLOW_GROWING),
            Poll::Wait(FOLLOW_TROUBLE)
        );
    }

    #[test]
    fn a_read_the_brick_refuses_is_told_apart_from_a_lost_link() {
        // A path the brick would cut fails every poll the same way: not a link to wait for.
        let refused = after_poll(Err(FsError::PathTooLong { bytes: 61 }), 10, FOLLOW_GROWING);
        assert!(
            matches!(refused, Poll::Refused(ref m) if m.contains("61 bytes")),
            "{refused:?}"
        );
        let stalled = FsError::Stalled {
            timeout: Duration::from_secs(3),
            transferred: 0,
        };
        assert_eq!(
            after_poll(Err(stalled), 10, FOLLOW_GROWING),
            Poll::Wait(FOLLOW_TROUBLE)
        );
    }

    fn follow_of(brick: &str) -> Subscription {
        Subscription::Follow {
            task: tokio::spawn(std::future::pending::<()>()).abort_handle(),
            brick_id: brick.to_owned(),
        }
    }

    #[tokio::test]
    async fn a_brick_takes_two_follows_of_every_client_together_and_one_cancelled_frees_a_place() {
        let mut state = super::super::State::default();
        state
            .subscriptions
            .entry(1)
            .or_default()
            .insert("a".into(), follow_of("AAA"));
        assert!(room_for_follow(&state, "AAA").is_ok());
        state
            .subscriptions
            .entry(2)
            .or_default()
            .insert("b".into(), follow_of("AAA"));
        // Another brick's follow, and another kind of subscription, take no place of AAA's.
        state
            .subscriptions
            .entry(2)
            .or_default()
            .insert("c".into(), follow_of("BBB"));
        state.subscriptions.entry(1).or_default().insert(
            "d".into(),
            Subscription::Chain {
                brick_id: "AAA".into(),
            },
        );
        let refused = room_for_follow(&state, "AAA").expect_err("a third");
        assert_eq!(refused.data.code, ErrorCode::InvalidRequest);
        assert!(refused.message.contains("2 follows"), "{}", refused.message);
        assert!(room_for_follow(&state, "BBB").is_ok());
        state.subscriptions.get_mut(&2).unwrap().remove("b");
        assert!(room_for_follow(&state, "AAA").is_ok());
    }
}
