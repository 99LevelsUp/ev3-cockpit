//! A fake brick behind one pinned link, for the transfer and ledger tests.
//!
//! It keeps a slot table and a file table the way the firmware does where transfers break: a slot
//! opens on the first command of a transfer, takes what each chunk carries, and is freed on end of
//! file or a close; a delete unlinks a file. Faults are set per command kind: a link cut on a
//! command (it fails as the link failing, and every later command is refused before it leaves
//! until `reconnect`), a reply lost after the brick ran the command, a reply held until the test
//! lets it go, and a slot the brick no longer knows.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use ev3_protocol::{BrickCommand, BrickResponse, ProtocolError};
use ev3_runtime::bricks::BrickError;
use ev3_runtime::error::SessionError;
use ev3_runtime::fs::{FsError, WriteReporter};
use ev3_runtime::ledger::TransferLedger;
use ev3_runtime::ports::{
    ActivityEvent, ActivityPort, ClientKind, ConsentAnswer, ConsentPort, ConsentRequest, Requester,
};
use ev3_runtime::transfer::{FileLink, FileTransferService, RouteSource};
use ev3_transports::{BrickKey, Transport, TransportError};
use tokio::sync::Semaphore;
use tokio::time::Instant;

pub const PATH: &str = "/home/root/lms2012/prjs/x.rbf";

pub fn usb_key() -> BrickKey {
    BrickKey::new(Transport::Usb, "00165300000A").unwrap()
}

pub fn requester() -> Requester {
    Requester {
        name: "VS Code".into(),
        kind: ClientKind::Vscode,
        connection: None,
    }
}

/// `n` bytes with no zero among them, so a dropped or padded byte shows.
pub fn body(n: usize) -> Vec<u8> {
    (0..n).map(|i| 1 + ((i * 7) % 250) as u8).collect()
}

pub fn link_lost() -> BrickError {
    BrickError::Session(SessionError::LinkLost {
        brick_key: usb_key(),
    })
}

pub fn cable_out() -> BrickError {
    BrickError::Session(SessionError::Transport(TransportError::transport_failed(
        "cable out",
    )))
}

pub fn reply_lost(kind: &str) -> BrickError {
    BrickError::Session(SessionError::Transport(TransportError::timeout(format!(
        "no reply to {kind} within its budget"
    ))))
}

pub fn unknown_handle() -> BrickError {
    BrickError::Session(SessionError::Protocol(ProtocolError::new(
        "EV3 system command error for 'fs:closeHandle': UNKNOWN_HANDLE",
    )))
}

enum Slot {
    Write {
        path: String,
        total: usize,
        data: Vec<u8>,
    },
    Read {
        content: Vec<u8>,
        offset: usize,
    },
}

type Rule = Box<dyn FnMut(&BrickCommand) -> bool + Send>;

pub struct BrickState {
    pub files: HashMap<String, Vec<u8>>,
    slots: HashMap<u8, Slot>,
    pub next_handle: u8,
    /// Every command that reached the link, refused ones too.
    pub commands: Vec<BrickCommand>,
    /// What the brick did, in order: `begin 3`, `chunk 3`, `read 3`, `close 3`, `delete /p`.
    pub log: Vec<String>,
    /// Payload bytes of each write step, and the bytes each read step asked for.
    pub written: Vec<usize>,
    pub wants: Vec<u16>,
    /// The link drops on the next command of this kind and stays down until `reconnect`.
    pub cut_on: Option<&'static str>,
    pub down: bool,
    /// The reply to a matching command is lost after the brick ran it.
    pub lose: Option<Rule>,
    /// A matching command is refused before it leaves.
    pub refuse: Option<Rule>,
    /// The next command of this kind waits for a permit from `release` before it is answered.
    pub hold: Option<&'static str>,
    /// Commands of this kind are never answered.
    pub silent: Option<&'static str>,
    /// Slots the brick answers "unknown handle" for.
    pub forgotten: HashSet<u8>,
}

pub struct FakeLink {
    key: BrickKey,
    max_packet_bytes: Option<usize>,
    state: Mutex<BrickState>,
    released: Semaphore,
}

impl FakeLink {
    pub fn new(max_packet_bytes: Option<usize>) -> Arc<Self> {
        Self::over(usb_key(), max_packet_bytes)
    }

    pub fn over(key: BrickKey, max_packet_bytes: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            key,
            max_packet_bytes,
            state: Mutex::new(BrickState {
                files: HashMap::new(),
                slots: HashMap::new(),
                next_handle: 3,
                commands: Vec::new(),
                log: Vec::new(),
                written: Vec::new(),
                wants: Vec::new(),
                cut_on: None,
                down: false,
                lose: None,
                refuse: None,
                hold: None,
                silent: None,
                forgotten: HashSet::new(),
            }),
            released: Semaphore::new(0),
        })
    }

    pub fn state(&self) -> MutexGuard<'_, BrickState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn cut_on(&self, kind: &'static str) {
        self.state().cut_on = Some(kind);
    }

    pub fn reconnect(&self) {
        self.state().down = false;
    }

    pub fn hold(&self, kind: &'static str) {
        self.state().hold = Some(kind);
    }

    pub fn release(&self) {
        self.released.add_permits(1);
    }

    pub fn forget(&self, handle: u8) {
        self.state().forgotten.insert(handle);
    }

    pub fn clear(&self) {
        let mut state = self.state();
        state.commands.clear();
        state.log.clear();
    }

    /// The commands sent, a close with its slot: `close 3`.
    pub fn kinds(&self) -> Vec<String> {
        self.state()
            .commands
            .iter()
            .map(|c| match c {
                BrickCommand::FsCloseHandle { handle } => format!("close {handle}"),
                other => other.kind().to_owned(),
            })
            .collect()
    }

    pub fn closes(&self) -> Vec<u8> {
        self.state()
            .commands
            .iter()
            .filter_map(|c| match c {
                BrickCommand::FsCloseHandle { handle } => Some(*handle),
                _ => None,
            })
            .collect()
    }

    pub fn deletes(&self) -> Vec<String> {
        self.state()
            .commands
            .iter()
            .filter_map(|c| match c {
                BrickCommand::FsDelete { path } => Some(path.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn open_slots(&self) -> usize {
        self.state().slots.len()
    }

    pub fn file(&self, path: &str) -> Option<Vec<u8>> {
        self.state().files.get(path).cloned()
    }

    /// Runs a command on the brick.
    fn run(state: &mut BrickState, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        match command {
            BrickCommand::FsBeginWrite {
                path,
                total_bytes,
                chunk,
            } => {
                let handle = state.next_handle;
                state.next_handle += 1;
                state.log.push(format!("begin {handle}"));
                state.written.push(chunk.len());
                state.slots.insert(
                    handle,
                    Slot::Write {
                        path: path.clone(),
                        total: *total_bytes as usize,
                        data: Vec::new(),
                    },
                );
                Ok(BrickResponse::FsBeginWrite {
                    handle,
                    end_of_file: Self::take(state, handle, chunk),
                })
            }
            BrickCommand::FsContinueWrite { handle, chunk } => {
                state.log.push(format!("chunk {handle}"));
                state.written.push(chunk.len());
                if !state.slots.contains_key(handle) {
                    return Err(unknown_handle());
                }
                Ok(BrickResponse::FsContinueWrite {
                    handle: *handle,
                    end_of_file: Self::take(state, *handle, chunk),
                })
            }
            BrickCommand::FsBeginRead { path, want_bytes } => {
                let Some(content) = state.files.get(path).cloned() else {
                    return Err(BrickError::Session(SessionError::Protocol(
                        ProtocolError::new(
                            "EV3 system command error for 'fs:beginRead': UNKNOWN_HANDLE",
                        ),
                    )));
                };
                let handle = state.next_handle;
                state.next_handle += 1;
                state.log.push(format!("read {handle}"));
                state.wants.push(*want_bytes);
                let end = content.len().min(usize::from(*want_bytes));
                let chunk = content[..end].to_vec();
                let total = content.len();
                let end_of_file = end >= total;
                if !end_of_file {
                    state.slots.insert(
                        handle,
                        Slot::Read {
                            content,
                            offset: end,
                        },
                    );
                }
                Ok(BrickResponse::FsBeginRead {
                    total_bytes: total as u32,
                    handle,
                    end_of_file,
                    chunk,
                })
            }
            BrickCommand::FsContinueRead { handle, want_bytes } => {
                state.log.push(format!("readmore {handle}"));
                state.wants.push(*want_bytes);
                let Some(Slot::Read { content, offset }) = state.slots.get_mut(handle) else {
                    return Err(unknown_handle());
                };
                let end = content.len().min(*offset + usize::from(*want_bytes));
                let chunk = content[*offset..end].to_vec();
                *offset = end;
                let end_of_file = end >= content.len();
                if end_of_file {
                    state.slots.remove(handle);
                }
                Ok(BrickResponse::FsContinueRead {
                    handle: *handle,
                    end_of_file,
                    chunk,
                })
            }
            BrickCommand::FsCloseHandle { handle } => {
                state.log.push(format!("close {handle}"));
                if state.forgotten.contains(handle) {
                    return Err(unknown_handle());
                }
                state.slots.remove(handle);
                Ok(BrickResponse::FsCloseHandle)
            }
            BrickCommand::FsDelete { path } => {
                state.log.push(format!("delete {path}"));
                Ok(BrickResponse::FsDelete {
                    deleted: state.files.remove(path).is_some(),
                })
            }
            other => panic!("not expected here: {}", other.kind()),
        }
    }

    /// Appends a chunk to a write slot; on its last byte the file is whole and the slot freed.
    fn take(state: &mut BrickState, handle: u8, chunk: &[u8]) -> bool {
        let Some(Slot::Write { path, total, data }) = state.slots.get_mut(&handle) else {
            return false;
        };
        data.extend_from_slice(chunk);
        if data.len() < *total {
            return false;
        }
        let (path, data) = (path.clone(), data.clone());
        state.files.insert(path, data);
        state.slots.remove(&handle);
        true
    }
}

#[async_trait]
impl FileLink for FakeLink {
    fn brick_key(&self) -> &BrickKey {
        &self.key
    }

    fn max_packet_bytes(&self) -> Option<usize> {
        self.max_packet_bytes
    }

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        let (held, silent) = {
            let mut state = self.state();
            state.commands.push(command.clone());
            if state.down {
                return Err(link_lost());
            }
            if state.refuse.as_mut().is_some_and(|rule| rule(command)) {
                return Err(link_lost());
            }
            if state.cut_on == Some(command.kind()) {
                state.cut_on = None;
                state.down = true;
                return Err(cable_out());
            }
            let held = state.hold == Some(command.kind());
            if held {
                state.hold = None;
            }
            (held, state.silent == Some(command.kind()))
        };
        if silent {
            return std::future::pending().await;
        }
        if held {
            self.released.acquire().await.unwrap().forget();
        }
        let mut state = self.state();
        let reply = Self::run(&mut state, command)?;
        if state.lose.as_mut().is_some_and(|rule| rule(command)) {
            return Err(reply_lost(command.kind()));
        }
        Ok(reply)
    }
}

/// Hands every transfer the same fake link.
pub struct FakeRoute(pub Arc<FakeLink>);

struct Shared(Arc<FakeLink>);

#[async_trait]
impl FileLink for Shared {
    fn brick_key(&self) -> &BrickKey {
        self.0.brick_key()
    }

    fn max_packet_bytes(&self) -> Option<usize> {
        self.0.max_packet_bytes()
    }

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        self.0.send(command).await
    }
}

#[async_trait]
impl RouteSource for FakeRoute {
    async fn open(&self, _deadline: Option<Instant>) -> Result<Box<dyn FileLink>, FsError> {
        Ok(Box::new(Shared(self.0.clone())))
    }
}

/// Answers questions as a script says, recording each; a gate holds every answer until the test
/// adds a permit.
pub struct Consent {
    script: Box<dyn Fn(usize) -> ConsentAnswer + Send + Sync>,
    pub asked: Mutex<Vec<ConsentRequest>>,
    gate: Option<Semaphore>,
}

impl Consent {
    pub fn answering(script: impl Fn(usize) -> ConsentAnswer + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            script: Box::new(script),
            asked: Mutex::new(Vec::new()),
            gate: None,
        })
    }

    pub fn always(answer: ConsentAnswer) -> Arc<Self> {
        Self::answering(move |_| answer)
    }

    pub fn gated(answer: ConsentAnswer) -> Arc<Self> {
        Arc::new(Self {
            script: Box::new(move |_| answer),
            asked: Mutex::new(Vec::new()),
            gate: Some(Semaphore::new(0)),
        })
    }

    pub fn open_gate(&self) {
        if let Some(gate) = &self.gate {
            gate.add_permits(1);
        }
    }

    pub fn count(&self) -> usize {
        self.asked.lock().unwrap().len()
    }

    pub fn actions(&self) -> Vec<String> {
        self.asked
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.action.clone())
            .collect()
    }
}

#[async_trait]
impl ConsentPort for Consent {
    async fn ask(&self, request: ConsentRequest) -> ConsentAnswer {
        let index = {
            let mut asked = self.asked.lock().unwrap();
            asked.push(request);
            asked.len() - 1
        };
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        (self.script)(index)
    }
}

/// Write reports, kept.
#[derive(Default)]
pub struct Reports(pub Mutex<Vec<ActivityEvent>>);

impl ActivityPort for Reports {
    fn report(&self, event: ActivityEvent) {
        self.0.lock().unwrap().push(event);
    }
}

pub fn writes(reports: Arc<Reports>) -> WriteReporter {
    WriteReporter {
        port: reports,
        requester: requester(),
    }
}

/// A transfer service over `link`, its ledger asking `consent`, with nothing stored.
pub fn service_over(
    link: &Arc<FakeLink>,
    consent: Arc<Consent>,
) -> (Arc<TransferLedger>, FileTransferService) {
    let ledger = Arc::new(TransferLedger::new("00165300000A", consent, None));
    let service = FileTransferService::new(
        Arc::new(FakeRoute(link.clone())),
        ledger.clone(),
        writes(Arc::new(Reports::default())),
    );
    (ledger, service)
}
