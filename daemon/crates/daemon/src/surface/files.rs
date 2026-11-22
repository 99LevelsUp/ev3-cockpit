//! The file methods and transfer handles.
//!
//! Every local path a client names is confined before anything else about the request: before the
//! brick is resolved, before a byte is read from it or written to it.

use std::sync::Arc;

use ev3_contract::{
    ContractError, ErrorCode, FileExists, FileSize, FilesMoveParams, FilesReadParams,
    FilesReadResult, FilesRemoveParams, FilesRemovePathsParams, FilesWriteParams, FilesWriteResult,
    FsEntry, FsEntryKind, FsListing, PathParams, RemoveReport, TransferBeginParams,
    TransferBeginResult, TransferChunk, TransferHandleParams, TransferWriteParams,
};
use ev3_runtime::{CancelFlag, TransferOptions};
use tokio_util::sync::CancellationToken;

use super::{Handle, Surface, encoding, errors, new_id};
use crate::access::Operation;
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
}
