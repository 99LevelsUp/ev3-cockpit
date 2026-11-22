//! Chunked file transfers over one pinned link.
//!
//! The command layer stays one command, one reply; the multi-command protocols live here. A
//! transfer is a run of commands against one brick-side file slot, sized to one link's packets,
//! so it holds the channel it started on ([`BrickManager::pin`]) and fails when that channel is
//! lost rather than following traffic to another: chunks sized for one link would go over
//! another, addressing a slot over a link nobody measured it on.
//!
//! Chunk size follows the pinned link's packet. The stock firmware's buffers are 1024 bytes on
//! every channel (`c_com.c` sets both RX and TX unconditionally), which caps a
//! `CONTINUE_DOWNLOAD` payload at 1017, and that is the default. The host link can be tighter (a
//! HID write delivers 64 bytes however large a report it is handed), and over TCP or Bluetooth
//! the user may set a larger packet for a firmware that takes one, so 1024 is not a ceiling here:
//! only the protocol's 16-bit length is.
//!
//! What a transfer cannot release (its link went first) is owed in the brick's
//! [`TransferLedger`] and settled before the next transfer starts.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::commands::{
    FIRMWARE_BUFFER_BYTES, MAX_PROTOCOL_PACKET_BYTES, SYSTEM_ENVELOPE_BYTES, max_first_chunk_bytes,
};
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_transports::usb::HID_PACKET_BYTES;
use ev3_transports::{BrickKey, Transport};
use tokio::time::Instant;

use crate::bricks::{BrickError, BrickManager, PinnedLink};
use crate::error::SessionError;
use crate::fs::{FsError, WriteReporter, brick_answered, check_path, may_have_run, unexpected};
use crate::ledger::{TransferDebt, TransferLedger};
use crate::ports::WriteScope;

/// Default stall window. Generous: it should only ever fire on a real stall.
pub const DEFAULT_STALL_TIMEOUT: Duration = Duration::from_secs(10);

// ── Links ───────────────────────────────────────────────────────────

/// One channel a transfer holds for its whole length.
#[async_trait]
pub trait FileLink: Send + Sync {
    /// The channel, for write reports and for the person asked before a sweep.
    fn brick_key(&self) -> &BrickKey;

    /// The packet the transfer uses; `None` when the link does not say.
    fn max_packet_bytes(&self) -> Option<usize>;

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError>;
}

#[async_trait]
impl FileLink for PinnedLink {
    fn brick_key(&self) -> &BrickKey {
        PinnedLink::brick_key(self)
    }

    fn max_packet_bytes(&self) -> Option<usize> {
        PinnedLink::max_packet_bytes(self)
    }

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        PinnedLink::send(self, command, None).await
    }
}

/// Where each transfer takes its channel.
#[async_trait]
pub trait RouteSource: Send + Sync {
    /// The channel for one transfer, taken at its start; with a deadline, after waiting for a
    /// route until then when the brick has none now.
    async fn open(&self, deadline: Option<Instant>) -> Result<Box<dyn FileLink>, FsError>;

    /// Called before an upload starts again after a step on `channel` failed: finds out whether
    /// that channel is still there, so the next [`RouteSource::open`] does not take it again
    /// while it is dead.
    async fn after_failure(&self, _channel: &BrickKey) {}
}

/// One brick of a brick layer: each transfer pins its route.
pub struct BrickRoute {
    bricks: BrickManager,
    brick_id: String,
}

impl BrickRoute {
    pub fn new(bricks: BrickManager, brick_id: impl Into<String>) -> Self {
        Self {
            bricks,
            brick_id: brick_id.into(),
        }
    }
}

#[async_trait]
impl RouteSource for BrickRoute {
    async fn open(&self, deadline: Option<Instant>) -> Result<Box<dyn FileLink>, FsError> {
        if deadline.is_some() {
            self.bricks.wait_for_route(&self.brick_id, deadline).await?;
        }
        Ok(Box::new(self.bricks.pin(&self.brick_id)?))
    }

    /// The brick layer keeps a brick's only channel routed after a failed command until its check
    /// answers, so a restart taken at once pins the dead channel again, fails at once, and turns
    /// the abandoned slot's settlement into a question to a person each time round. So the
    /// channel is checked first: a dead one leaves the route and the next open waits for it.
    async fn after_failure(&self, channel: &BrickKey) {
        if self.bricks.route_of(&self.brick_id).as_ref() == Some(channel) {
            self.bricks.sessions().probe_now(channel).await;
        }
    }
}

/// Between two attempts of one upload: lets the brick layer hear what the check of the failed
/// channel found before the route is read again, and keeps a route that fails at once from
/// spinning.
const RESTART_PAUSE: Duration = Duration::from_millis(20);

/// The packet a transfer over `link` uses.
///
/// What the link says first: a USB link over libusb carries 1024 bytes. When it says nothing,
/// USB is taken at what a HID write delivers (chunking small is slow, chunking large is silent
/// truncation: the brick advances its file pointer by the length declared), and every other
/// transport at the firmware's buffer.
pub fn packet_bytes_of(link: &dyn FileLink) -> usize {
    link.max_packet_bytes()
        .unwrap_or(match link.brick_key().transport() {
            Transport::Usb => HID_PACKET_BYTES,
            Transport::Bt | Transport::Tcp | Transport::Mock => FIRMWARE_BUFFER_BYTES,
        })
}

/// Chunk sizes for one packet size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkSizes {
    pub max_packet_bytes: usize,
    /// Room for a `CONTINUE_DOWNLOAD` payload: the packet less its header and the handle.
    pub max_chunk_bytes: usize,
    /// Room for a read reply's payload. `BEGIN_UPLOAD`'s reply header is the largest (echo,
    /// status, a 4-byte size and the handle on top of the envelope), so every read is sized
    /// against it and every later reply fits too.
    pub max_read_bytes: usize,
}

/// The chunks one packet carries; only the protocol's 16-bit length bounds the packet.
pub fn sizes_for(packet_bytes: usize) -> Result<LinkSizes, FsError> {
    let max_packet_bytes = packet_bytes.min(MAX_PROTOCOL_PACKET_BYTES);
    let header = SYSTEM_ENVELOPE_BYTES + 1;
    let read_header = SYSTEM_ENVELOPE_BYTES + 1 + 4 + 1;
    if max_packet_bytes <= read_header {
        return Err(FsError::Protocol(format!(
            "A {max_packet_bytes}-byte packet leaves no room for a read payload."
        )));
    }
    Ok(LinkSizes {
        max_packet_bytes,
        max_chunk_bytes: max_packet_bytes - header,
        max_read_bytes: max_packet_bytes - read_header,
    })
}

// ── Options ─────────────────────────────────────────────────────────

/// Progress of a transfer in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferProgress {
    pub transferred: usize,
    pub total: usize,
}

/// Cancels a transfer from outside; it stops within one chunk and releases its slot. Cheap to
/// clone; clones share the flag.
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// How one transfer runs.
#[derive(Clone, Default)]
pub struct TransferOptions {
    /// Told at least once per chunk.
    pub on_progress: Option<Arc<dyn Fn(TransferProgress) + Send + Sync>>,
    pub cancel: Option<CancelFlag>,
    /// Fail when no step completes within this; [`DEFAULT_STALL_TIMEOUT`] when `None`. A stall
    /// detector, not a budget for the whole transfer: a 1 MB file over Bluetooth takes about 90
    /// seconds by the link's own bandwidth.
    pub stall_timeout: Option<Duration>,
    /// The operation's deadline. Until then an upload whose route or a reply is lost waits for
    /// the route and starts again from its first chunk; a chunk whose reply was lost is never
    /// sent again on its own. It bounds the waiting and the restarts, not a transfer that is
    /// moving. `None`: a lost route or reply fails the transfer.
    pub deadline: Option<Instant>,
    /// A read refuses a file larger than this as soon as the brick says its size, before the
    /// rest of it crosses the link. `None`: any size.
    pub max_bytes: Option<usize>,
}

impl TransferOptions {
    fn stall(&self) -> Duration {
        self.stall_timeout.unwrap_or(DEFAULT_STALL_TIMEOUT)
    }

    fn cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(CancelFlag::is_cancelled)
    }

    fn progress(&self, transferred: usize, total: usize) {
        if let Some(report) = &self.on_progress {
            report(TransferProgress { transferred, total });
        }
    }
}

/// Whether an upload that failed with `error` starts again: the route or a reply was lost and
/// its deadline is not spent. Not when the brick answered, nor when the caller cancelled.
fn may_start_again(error: &FsError, options: &TransferOptions) -> bool {
    let Some(deadline) = options.deadline else {
        return false;
    };
    if Instant::now() >= deadline || options.cancelled() {
        return false;
    }
    match error {
        FsError::Stalled { .. } => true,
        FsError::Command(BrickError::ChannelChanged { .. }) => true,
        FsError::Command(BrickError::Session(error)) => matches!(
            error,
            SessionError::Transport(_)
                | SessionError::LinkLost { .. }
                | SessionError::Degraded { .. }
                | SessionError::Disconnected { .. }
        ),
        _ => false,
    }
}

/// One step of a transfer, raced against the stall window.
async fn step(
    link: &dyn FileLink,
    command: &BrickCommand,
    stall: Duration,
    transferred: usize,
) -> Result<BrickResponse, FsError> {
    match tokio::time::timeout(stall, link.send(command)).await {
        Ok(reply) => Ok(reply?),
        Err(_) => Err(FsError::Stalled {
            timeout: stall,
            transferred,
        }),
    }
}

// ── The open slot ───────────────────────────────────────────────────

/// Where a transfer stands with its brick-side slot.
enum Stage {
    /// The first command is on its way: the brick may open a slot whose number never arrives.
    Opening { delete_path: Option<String> },
    /// The slot is open; `last_in_flight` while the step that frees it is on its way.
    Open {
        handle: u8,
        delete_path: Option<String>,
        last_in_flight: bool,
    },
    /// The close is on its way: it may run and free the number for someone else.
    Closing {
        handle: u8,
        delete_path: Option<String>,
    },
    /// The slot is closed and the partial file's delete is on its way.
    Deleting { path: String },
    /// Nothing left to release, or what was is owed already.
    Done,
}

/// Owes whatever the slot still holds when a transfer is dropped halfway: dropping the future is
/// how a caller cancels, and a dropped future cannot send a close.
struct SlotGuard<'a> {
    ledger: &'a TransferLedger,
    stage: Stage,
}

impl SlotGuard<'_> {
    fn done(&mut self) {
        self.stage = Stage::Done;
    }
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        let debt = match std::mem::replace(&mut self.stage, Stage::Done) {
            Stage::Opening { delete_path } => TransferDebt::Unknown { delete_path },
            Stage::Open {
                handle,
                delete_path,
                last_in_flight,
            } => TransferDebt::Slot {
                handle,
                delete_path,
                uncertain: last_in_flight,
            },
            Stage::Closing {
                handle,
                delete_path,
            } => TransferDebt::uncertain_slot(handle, delete_path),
            Stage::Deleting { path } => TransferDebt::Delete { path },
            Stage::Done => return,
        };
        self.ledger.owe(debt);
    }
}

// ── The service ─────────────────────────────────────────────────────

/// Chunked reads and writes of one brick, each over one channel held for its length.
///
/// Holds no state between calls; concurrent transfers on one brick are serialised by the
/// session's queue, and the brick's slot table is what would run out.
pub struct FileTransferService {
    route: Arc<dyn RouteSource>,
    ledger: Arc<TransferLedger>,
    writes: WriteReporter,
}

impl FileTransferService {
    /// Writes are reported through `writes`, and a sweep is asked of the person behind
    /// `writes.requester`.
    pub fn new(
        route: Arc<dyn RouteSource>,
        ledger: Arc<TransferLedger>,
        writes: WriteReporter,
    ) -> Self {
        Self {
            route,
            ledger,
            writes,
        }
    }

    pub fn ledger(&self) -> &Arc<TransferLedger> {
        &self.ledger
    }

    /// Writes `content` to `path` on the brick.
    ///
    /// `BEGIN_DOWNLOAD` carries the first chunk itself, so a file that fits in one packet
    /// completes in one command; the rest goes through `CONTINUE_DOWNLOAD` until the brick
    /// reports end of file.
    ///
    /// With a deadline, an upload that loses its route or a reply starts again until then: its
    /// slot abandoned and owed, the route waited for, the debt settled, and the file written from
    /// its first chunk on whichever channel carries traffic then.
    pub async fn write_file(
        &self,
        path: &str,
        content: &[u8],
        options: &TransferOptions,
    ) -> Result<(), FsError> {
        check_path(path)?;
        let mut scope: Option<WriteScope> = None;
        loop {
            let mut channel = None;
            match self
                .write_attempt(path, content, options, &mut scope, &mut channel)
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) if may_start_again(&error, options) => {
                    if let Some(channel) = channel {
                        self.route.after_failure(&channel).await;
                    }
                    tokio::time::sleep(RESTART_PAUSE).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn write_attempt(
        &self,
        path: &str,
        content: &[u8],
        options: &TransferOptions,
        scope: &mut Option<WriteScope>,
        channel: &mut Option<BrickKey>,
    ) -> Result<(), FsError> {
        let link = self.route.open(options.deadline).await?;
        *channel = Some(link.brick_key().clone());
        if scope.is_none() {
            *scope = Some(
                self.writes
                    .begin(link.brick_key().clone(), format!("Writing {path}")),
            );
        }
        // What an earlier transfer could not release is released first; counted out when this
        // attempt ends, before the next one's settlement.
        let _active = self
            .ledger
            .begin(link.as_ref(), &self.writes.requester)
            .await?;
        self.write(link.as_ref(), path, content, options).await?;
        // A whole file now: nothing owed may delete it.
        self.ledger.written(path);
        Ok(())
    }

    async fn write(
        &self,
        link: &dyn FileLink,
        path: &str,
        content: &[u8],
        options: &TransferOptions,
    ) -> Result<(), FsError> {
        let stall = options.stall();
        let sizes = sizes_for(packet_bytes_of(link))?;
        let total = content.len();
        let total_bytes = u32::try_from(total).map_err(|_| {
            FsError::Protocol(format!(
                "A file of {total} bytes is larger than the protocol can declare."
            ))
        })?;
        let room = max_first_chunk_bytes(path, sizes.max_packet_bytes);
        let Ok(room) = usize::try_from(room) else {
            return Err(FsError::Protocol(format!(
                "No room for payload after a {}-character path in BEGIN_DOWNLOAD.",
                path.len()
            )));
        };
        let first = room.min(total);

        let mut slot = SlotGuard {
            ledger: &self.ledger,
            stage: Stage::Opening {
                delete_path: Some(path.to_owned()),
            },
        };
        let command = BrickCommand::FsBeginWrite {
            path: path.to_owned(),
            total_bytes,
            chunk: content[..first].to_vec(),
        };
        let begin = match step(link, &command, stall, 0).await {
            Ok(reply) => reply,
            Err(error) => {
                // Refused before it left, or answered: the brick opened nothing. Otherwise the
                // guard owes a slot never learned.
                if !error.may_have_run() {
                    slot.done();
                }
                return Err(error);
            }
        };
        let BrickResponse::FsBeginWrite {
            handle,
            end_of_file,
        } = begin
        else {
            slot.done();
            return Err(unexpected(&command, &begin));
        };
        let mut sent = first;
        let mut eof = end_of_file;
        slot.stage = Stage::Open {
            handle,
            delete_path: Some(path.to_owned()),
            last_in_flight: false,
        };
        if eof {
            slot.done();
        }

        let mut last_in_flight = false;
        let result: Result<(), FsError> = async {
            options.progress(sent, total);
            while sent < total && !eof {
                if options.cancelled() {
                    return Err(FsError::Cancelled);
                }
                let size = sizes.max_chunk_bytes.min(total - sent);
                last_in_flight = sent + size >= total;
                slot.stage = Stage::Open {
                    handle,
                    delete_path: Some(path.to_owned()),
                    last_in_flight,
                };
                let command = BrickCommand::FsContinueWrite {
                    handle,
                    chunk: content[sent..sent + size].to_vec(),
                };
                let reply = step(link, &command, stall, sent).await?;
                last_in_flight = false;
                let BrickResponse::FsContinueWrite { end_of_file, .. } = reply else {
                    slot.stage = Stage::Open {
                        handle,
                        delete_path: Some(path.to_owned()),
                        last_in_flight: false,
                    };
                    return Err(unexpected(&command, &reply));
                };
                sent += size;
                eof = end_of_file;
                // On end of file the firmware has closed and freed the slot.
                slot.stage = if eof {
                    Stage::Done
                } else {
                    Stage::Open {
                        handle,
                        delete_path: Some(path.to_owned()),
                        last_in_flight: false,
                    }
                };
                options.progress(sent, total);
            }
            Ok(())
        }
        .await;

        if let Err(error) = result {
            // The firmware frees a slot only on end of file or its own error path, so an
            // abandoned transfer would hold one, and the file's space, until the brick restarts.
            // The partial file goes too: it is not the file anyone sent.
            if !eof {
                let uncertain = last_in_flight && error.may_have_run();
                self.abandon(link, &mut slot, handle, Some(path), uncertain)
                    .await;
            } else {
                self.ledger.written(path);
            }
            return Err(error);
        }

        if sent < total {
            return Err(FsError::Protocol(format!(
                "Brick reported end of file after {sent} of {total} bytes."
            )));
        }
        // On end of file the slot is free already; closing again would address a slot that no
        // longer exists.
        if !eof {
            self.release(link, &mut slot, handle).await;
        }
        Ok(())
    }

    /// Reads `path` from the brick in full. The brick reports the total in its first reply.
    pub async fn read_file(
        &self,
        path: &str,
        options: &TransferOptions,
    ) -> Result<Vec<u8>, FsError> {
        check_path(path)?;
        let link = self.route.open(options.deadline).await?;
        let _active = self
            .ledger
            .begin(link.as_ref(), &self.writes.requester)
            .await?;
        self.read(link.as_ref(), path, options).await
    }

    async fn read(
        &self,
        link: &dyn FileLink,
        path: &str,
        options: &TransferOptions,
    ) -> Result<Vec<u8>, FsError> {
        let stall = options.stall();
        let sizes = sizes_for(packet_bytes_of(link))?;
        let want = u16::try_from(sizes.max_read_bytes).unwrap_or(u16::MAX);

        let mut slot = SlotGuard {
            ledger: &self.ledger,
            stage: Stage::Opening { delete_path: None },
        };
        let command = BrickCommand::FsBeginRead {
            path: path.to_owned(),
            want_bytes: want,
        };
        let begin = match step(link, &command, stall, 0).await {
            Ok(reply) => reply,
            Err(error) => {
                if !error.may_have_run() {
                    slot.done();
                }
                return Err(error);
            }
        };
        let BrickResponse::FsBeginRead {
            total_bytes,
            handle,
            end_of_file,
            chunk,
        } = begin
        else {
            slot.done();
            return Err(unexpected(&command, &begin));
        };
        let total = total_bytes as usize;
        let mut content = Vec::with_capacity(total);
        content.extend_from_slice(&chunk);
        let mut eof = end_of_file;
        slot.stage = if eof {
            Stage::Done
        } else {
            Stage::Open {
                handle,
                delete_path: None,
                last_in_flight: false,
            }
        };

        let mut last_in_flight = false;
        let result: Result<(), FsError> = async {
            if let Some(max) = options.max_bytes
                && total > max
            {
                return Err(FsError::TooLarge { bytes: total, max });
            }
            options.progress(content.len(), total);
            while content.len() < total && !eof {
                if options.cancelled() {
                    return Err(FsError::Cancelled);
                }
                let wanted = usize::from(want).min(total - content.len());
                last_in_flight = content.len() + wanted >= total;
                slot.stage = Stage::Open {
                    handle,
                    delete_path: None,
                    last_in_flight,
                };
                let command = BrickCommand::FsContinueRead {
                    handle,
                    want_bytes: u16::try_from(wanted).unwrap_or(want),
                };
                let reply = step(link, &command, stall, content.len()).await?;
                last_in_flight = false;
                slot.stage = Stage::Open {
                    handle,
                    delete_path: None,
                    last_in_flight: false,
                };
                let BrickResponse::FsContinueRead {
                    end_of_file, chunk, ..
                } = reply
                else {
                    return Err(unexpected(&command, &reply));
                };
                if chunk.is_empty() && !end_of_file {
                    return Err(FsError::Protocol(format!(
                        "Brick returned an empty chunk after {} of {total} bytes without \
                         reporting end of file.",
                        content.len()
                    )));
                }
                content.extend_from_slice(&chunk);
                eof = end_of_file;
                if eof {
                    slot.done();
                }
                options.progress(content.len(), total);
            }
            Ok(())
        }
        .await;

        if let Err(error) = result {
            if !eof {
                let uncertain = last_in_flight && error.may_have_run();
                self.abandon(link, &mut slot, handle, None, uncertain).await;
            }
            return Err(error);
        }
        if content.len() < total {
            return Err(FsError::Protocol(format!(
                "Brick reported end of file after {} of {total} bytes.",
                content.len()
            )));
        }
        if !eof {
            self.release(link, &mut slot, handle).await;
        }
        content.truncate(total);
        Ok(content)
    }

    /// Releases a failed transfer's slot and, for an upload, deletes its partial file. What the
    /// link took with it is owed, to be settled before the next transfer; nothing here masks the
    /// transfer's own error.
    ///
    /// `uncertain`: the step that frees the slot (the last chunk) may have run with its reply
    /// lost. Then the brick may have handed the number on, so nothing is closed or deleted now:
    /// it is owed for a person to release.
    async fn abandon(
        &self,
        link: &dyn FileLink,
        slot: &mut SlotGuard<'_>,
        handle: u8,
        delete_path: Option<&str>,
        uncertain: bool,
    ) {
        let delete_path = delete_path.map(str::to_owned);
        if uncertain {
            slot.done();
            self.ledger
                .owe(TransferDebt::uncertain_slot(handle, delete_path));
            return;
        }
        slot.stage = Stage::Closing {
            handle,
            delete_path: delete_path.clone(),
        };
        if let Err(error) = link.send(&BrickCommand::FsCloseHandle { handle }).await
            && !brick_answered(&error)
        {
            // A close that may have run frees the slot for someone else: uncertain from then on.
            slot.done();
            self.ledger.owe(TransferDebt::Slot {
                handle,
                delete_path,
                uncertain: may_have_run(&error),
            });
            return;
        }
        let Some(path) = delete_path else {
            slot.done();
            return;
        };
        slot.stage = Stage::Deleting { path: path.clone() };
        let command = BrickCommand::FsDelete { path: path.clone() };
        if let Err(error) = link.send(&command).await
            && !brick_answered(&error)
        {
            slot.done();
            self.ledger.owe(TransferDebt::Delete { path });
            return;
        }
        slot.done();
    }

    /// Closes a slot whose transfer moved every byte but saw no end of file. The file is whole,
    /// so only the slot is owed when the link takes the close with it; any answer from the brick
    /// means the slot is free (`c_com.c` 2116–2150).
    async fn release(&self, link: &dyn FileLink, slot: &mut SlotGuard<'_>, handle: u8) {
        slot.stage = Stage::Closing {
            handle,
            delete_path: None,
        };
        let result = link.send(&BrickCommand::FsCloseHandle { handle }).await;
        slot.done();
        if let Err(error) = result
            && !brick_answered(&error)
        {
            self.ledger.owe(TransferDebt::Slot {
                handle,
                delete_path: None,
                uncertain: may_have_run(&error),
            });
        }
    }
}
