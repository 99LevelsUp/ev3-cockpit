//! Files put on a brick and a program started there, as one operation: the work a client would
//! otherwise do in several calls, holding the brick between them.
//!
//! In this order: nothing may run on the brick (a start into a running slot is refused by the
//! firmware in silence), then each file goes up — one whose MD5 on the brick already matches is
//! left, checked here so the answer cannot go stale between calls — then the program starts and
//! its start is confirmed. The operation ends where it reports how the start went, so whatever
//! holds the brick for it (the daemon's write lease) lets go there.
//!
//! A stop or emergency stop on the brick, from anyone, before the start ends the operation with
//! [`ProgramError::Stopped`] naming who stopped, and nothing starts: a stop pressed during an
//! upload is never followed by a start. The caller's own cancel ends it with
//! [`ProgramError::Cancelled`] and stops nobody's program.
//!
//! Nothing here reads a path on this computer: whoever reads a local file checks that path first
//! and hands over its bytes, before the operation starts.

use std::future::Future;
use std::time::Duration;

use ev3_contract::StartOutcome;
use ev3_protocol::responses::FsEntryKind;
use tokio::time::Instant;

use crate::fs::{FilesystemService, FsError, MAX_PATH_BYTES};
use crate::ports::Requester;
use crate::programs::{ProgramError, ProgramService, StartOptions};
use crate::transfer::{CancelFlag, FileTransferService, TransferOptions};

/// Inline content larger than this is refused: a larger file is named by its local path.
pub const MAX_INLINE_BYTES: usize = 4096;

/// The operation's deadline when its caller names none. It bounds the waiting for a lost route
/// and the restarts of an upload, not an upload that is moving: a 1 MB file over Bluetooth takes
/// about 90 seconds.
pub const DEPLOY_AND_RUN_BUDGET: Duration = Duration::from_secs(120);

/// One file to put on the brick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployFile {
    /// Where it goes on the brick.
    pub path: String,
    pub content: Vec<u8>,
    /// The content was given inline in the request, where at most [`MAX_INLINE_BYTES`] may be.
    pub inline: bool,
    /// Leave the brick's copy when its MD5 matches, checked within this operation.
    pub skip_if_same: bool,
}

/// One deployment.
#[derive(Debug, Clone, Default)]
pub struct DeployRequest {
    pub files: Vec<DeployFile>,
    /// The program to start once the files are on the brick.
    pub program: String,
    /// Until when a lost route is waited out and an upload started again;
    /// [`DEPLOY_AND_RUN_BUDGET`] from the start otherwise.
    pub deadline: Option<Instant>,
    /// The caller's own cancel: checked between the steps, between an upload's chunks, and right
    /// before the start goes out.
    pub cancel: Option<CancelFlag>,
}

/// How a deployment ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployReport {
    /// How the start ended: the operation is over here, at the start it verified or could not.
    pub outcome: StartOutcome,
    /// The files put on the brick, in order.
    pub uploaded: Vec<String>,
    /// The files left because the brick's copy matched.
    pub skipped: Vec<String>,
}

/// One brick's services for a deployment. `programs` must be the brick's one program service,
/// the one every client's stop goes through; `files` and `transfer` report their writes in the
/// requester's name.
pub struct DeployServices<'a> {
    pub programs: &'a ProgramService,
    pub files: &'a FilesystemService,
    pub transfer: &'a FileTransferService,
}

/// Puts the files on the brick and starts the program; see the module.
///
/// The stop mark is taken here, when the deployment is asked: from then on a stop from anyone
/// ends it before its start. Dropping the future cancels it; an upload cut short is owed in the
/// brick's ledger as any other.
pub fn deploy_and_run<'a>(
    services: DeployServices<'a>,
    requester: &'a Requester,
    request: DeployRequest,
) -> impl Future<Output = Result<DeployReport, ProgramError>> + Send + 'a {
    let since = services.programs.stop_mark();
    async move {
        let DeployServices {
            programs,
            files,
            transfer,
        } = services;
        // Every file is checked before anything reaches the brick.
        for file in &request.files {
            check(file)?;
        }
        let deadline = request
            .deadline
            .unwrap_or_else(|| Instant::now() + DEPLOY_AND_RUN_BUDGET);
        let cancel = request.cancel.clone();
        let cancelled = || programs.check_cancelled(since, cancel.as_ref(), true);

        if programs.is_running().await? {
            return Err(ProgramError::Running { deploying: true });
        }
        let options = TransferOptions {
            cancel: cancel.clone(),
            deadline: Some(deadline),
            ..TransferOptions::default()
        };
        let mut uploaded = Vec::new();
        let mut skipped = Vec::new();
        for file in &request.files {
            cancelled()?;
            if file.skip_if_same
                && let Some(md5) = md5_hex(&file.content)
                && same_on_brick(files, &file.path, file.content.len(), &md5)
                    .await
                    .map_err(ProgramError::Files)?
            {
                skipped.push(file.path.clone());
                continue;
            }
            cancelled()?;
            match transfer
                .write_file(&file.path, &file.content, &options)
                .await
            {
                Ok(()) => uploaded.push(file.path.clone()),
                Err(FsError::Cancelled) => return Err(ProgramError::Cancelled),
                Err(error) => return Err(ProgramError::Files(error)),
            }
        }
        // The start itself refuses to go out after a stop since `since`, with nothing awaited
        // between its last check and its send.
        let start = StartOptions {
            replace: false,
            since: Some(since),
            deadline: Some(deadline),
            cancel,
        };
        let outcome = programs.start(&request.program, requester, start).await?;
        Ok(DeployReport {
            outcome,
            uploaded,
            skipped,
        })
    }
}

fn check(file: &DeployFile) -> Result<(), ProgramError> {
    if file.inline && file.content.len() > MAX_INLINE_BYTES {
        return Err(ProgramError::Invalid(format!(
            "{}: inline content is {} bytes; at most {MAX_INLINE_BYTES} may be given inline, a \
             larger file by its local path.",
            file.path,
            file.content.len()
        )));
    }
    if file.path.len() >= MAX_PATH_BYTES {
        return Err(ProgramError::Invalid(format!(
            "{}: the brick truncates a path at {} bytes.",
            file.path,
            MAX_PATH_BYTES - 1
        )));
    }
    Ok(())
}

/// Whether the brick holds `path` with this content already, by the MD5 and size its listing
/// gives: `md5` is the content's digest in hex, `bytes` its length.
///
/// A folder the brick will not list holds nothing to match; a failure of the link is the
/// caller's.
pub async fn same_on_brick(
    files: &FilesystemService,
    path: &str,
    bytes: usize,
    md5: &str,
) -> Result<bool, FsError> {
    let (folder, name) = match path.rfind('/') {
        Some(slash) if slash > 0 => (&path[..slash], &path[slash + 1..]),
        Some(_) => ("/", &path[1..]),
        None => ("/", path),
    };
    let entries = match files.list(folder).await {
        Ok(entries) => entries,
        Err(error) if error.is_protocol() => return Ok(false),
        Err(error) => return Err(error),
    };
    let Some(entry) = entries
        .iter()
        .find(|entry| entry.name == name && entry.kind == FsEntryKind::File)
    else {
        return Ok(false);
    };
    let Some(theirs) = &entry.md5 else {
        return Ok(false);
    };
    if entry
        .bytes
        .is_some_and(|size| usize::try_from(size).ok() != Some(bytes))
    {
        return Ok(false);
    }
    Ok(theirs.eq_ignore_ascii_case(md5))
}

/// The content's MD5 in lowercase hex, as the brick's listing reports it. `None` would mean it
/// cannot be computed, and then the file is uploaded: an upload too many costs time, a wrong skip
/// would start a stale program.
fn md5_hex(content: &[u8]) -> Option<String> {
    use md5::{Digest, Md5};
    Some(
        Md5::digest(content)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
