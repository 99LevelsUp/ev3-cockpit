//! A fake brick for the program, deploy and shell tests.
//!
//! It runs programs the way the firmware does: a start into a running user slot is refused in
//! silence (the load writes nothing, the reply says size 0), a missing file loads as size 0 and
//! starts nothing, a stop ends the slot, the emergency stop ends it and stops every motor, and the
//! shell answers status 0. It keeps files for the deploy tests, with the MD5 its listing shows set
//! by the test. A command can be held on its way until the test lets it go, answered otherwise, or
//! have its reply lost after the brick ran it.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::responses::{FsEntry, FsEntryKind};
use ev3_protocol::{BrickCommand, BrickResponse, ProtocolError};
use ev3_runtime::bricks::BrickError;
use ev3_runtime::error::SessionError;
use ev3_runtime::fs::{CommandSender, FilesystemService, FsError, WriteReporter};
use ev3_runtime::ledger::TransferLedger;
use ev3_runtime::ports::{
    ActivityEvent, ActivityPort, ClientKind, ConsentAnswer, ConsentPort, ConsentRequest, Requester,
};
use ev3_runtime::programs::{
    EndSink, Following, ProgramError, ProgramFollow, ProgramLink, ProgramOptions, ProgramService,
    StateSink,
};
use ev3_runtime::transfer::{FileLink, FileTransferService, RouteSource};
use ev3_transports::{BrickKey, Transport, TransportError};
use tokio::sync::Semaphore;
use tokio::time::Instant;

pub const PRG: &str = "/home/root/lms2012/prjs/Demo/Demo.rbf";
pub const IMAGE: &[u8] = b"LEGO-rbf-image";
/// MD5 of [`IMAGE`], from `Get-FileHash -Algorithm MD5`.
pub const IMAGE_MD5: &str = "8da0232d67cc83f17eb712216d5af728";
/// MD5 of `from disk`, from `Get-FileHash -Algorithm MD5`.
pub const FROM_DISK_MD5: &str = "a7974a806f69abbefd10af6fedcef207";

pub fn usb_key() -> BrickKey {
    BrickKey::new(Transport::Usb, "00165300000A").unwrap()
}

pub fn person(name: &str) -> Requester {
    Requester {
        name: name.into(),
        kind: ClientKind::Vscode,
        connection: None,
    }
}

pub fn vscode() -> Requester {
    person("VS Code")
}

pub fn reply_lost(kind: &str) -> BrickError {
    BrickError::Session(SessionError::Transport(TransportError::timeout(format!(
        "no reply to {kind} within its budget"
    ))))
}

pub fn link_lost() -> BrickError {
    BrickError::Session(SessionError::LinkLost {
        brick_key: usb_key(),
    })
}

fn refused(kind: &str) -> BrickError {
    BrickError::Session(SessionError::Protocol(ProtocolError::new(format!(
        "EV3 system command error for '{kind}': UNKNOWN_HANDLE"
    ))))
}

type Answer = Box<dyn FnMut(&BrickCommand) -> Option<Result<BrickResponse, BrickError>> + Send>;
type Rule = Box<dyn FnMut(&BrickCommand) -> bool + Send>;

pub struct BrickState {
    pub files: HashMap<String, Vec<u8>>,
    /// The MD5 the listing shows per file; a file without one lists without it.
    pub md5s: HashMap<String, String>,
    pub running: bool,
    pub motors_stopped: u32,
    pub shell: Vec<String>,
    write_slots: HashMap<u8, (String, usize, Vec<u8>)>,
    next_handle: u8,
    /// Each command as it reaches the brick, by kind, and the test's own marks among them.
    pub log: Vec<String>,
    /// Commands of this kind wait, before they reach the brick, for a permit from `release`.
    hold: Vec<&'static str>,
    /// Commands that arrived at the hold, by kind.
    pub arrived: Vec<String>,
    /// Answers a command instead of the brick when it says so.
    answer: Option<Answer>,
    /// The reply to a matching command is lost after the brick ran it.
    lose: Option<Rule>,
    /// A matching command is refused before it leaves.
    refuse: Option<Rule>,
    /// The deadlines route waits were asked for.
    pub route_waits: Vec<Instant>,
}

pub struct FakeBrick {
    key: BrickKey,
    state: Mutex<BrickState>,
    released: Semaphore,
}

impl FakeBrick {
    /// A brick holding the demo program.
    pub fn new() -> Arc<Self> {
        let brick = Arc::new(Self {
            key: usb_key(),
            state: Mutex::new(BrickState {
                files: HashMap::new(),
                md5s: HashMap::new(),
                running: false,
                motors_stopped: 0,
                shell: Vec::new(),
                write_slots: HashMap::new(),
                next_handle: 1,
                log: Vec::new(),
                hold: Vec::new(),
                arrived: Vec::new(),
                answer: None,
                lose: None,
                refuse: None,
                route_waits: Vec::new(),
            }),
            released: Semaphore::new(0),
        });
        brick.state().files.insert(PRG.into(), IMAGE.to_vec());
        brick
    }

    pub fn state(&self) -> MutexGuard<'_, BrickState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The next command of `kind` waits before it reaches the brick.
    pub fn hold(&self, kind: &'static str) {
        self.state().hold.push(kind);
    }

    pub fn release(&self) {
        self.released.add_permits(1);
    }

    pub fn answer_with(
        &self,
        answer: impl FnMut(&BrickCommand) -> Option<Result<BrickResponse, BrickError>> + Send + 'static,
    ) {
        self.state().answer = Some(Box::new(answer));
    }

    pub fn lose(&self, rule: impl FnMut(&BrickCommand) -> bool + Send + 'static) {
        self.state().lose = Some(Box::new(rule));
    }

    pub fn refuse(&self, rule: impl FnMut(&BrickCommand) -> bool + Send + 'static) {
        self.state().refuse = Some(Box::new(rule));
    }

    pub fn mark(&self, what: &str) {
        self.state().log.push(what.into());
    }

    pub fn log(&self) -> Vec<String> {
        self.state().log.clone()
    }

    pub fn count(&self, kind: &str) -> usize {
        self.state().log.iter().filter(|k| *k == kind).count()
    }

    pub fn file(&self, path: &str) -> Option<Vec<u8>> {
        self.state().files.get(path).cloned()
    }

    /// The program ends by itself, as a program on a brick does.
    pub fn end_program(&self) {
        self.state().running = false;
    }

    /// Waits, a few milliseconds at a time, until `what` holds; fails after a second.
    pub async fn until(&self, what: impl Fn(&BrickState) -> bool) {
        for _ in 0..200 {
            if what(&self.state()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the brick never got there: {:?}", self.log());
    }

    fn run(state: &mut BrickState, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        match command {
            BrickCommand::ProgramRun { path } => {
                // The load on a busy slot writes nothing; a missing file loads as size 0.
                if state.running {
                    return Ok(BrickResponse::ProgramRun { image_bytes: 0 });
                }
                let image_bytes = state.files.get(path).map_or(0, |image| image.len() as i32);
                if image_bytes > 0 {
                    state.running = true;
                }
                Ok(BrickResponse::ProgramRun { image_bytes })
            }
            BrickCommand::ProgramStatus => Ok(BrickResponse::ProgramStatus {
                running: state.running,
                status: if state.running { 0x10 } else { 0x40 },
            }),
            BrickCommand::ProgramStop => {
                state.running = false;
                Ok(BrickResponse::ProgramStop)
            }
            BrickCommand::ProgramEmergencyStop => {
                state.running = false;
                state.motors_stopped += 1;
                Ok(BrickResponse::ProgramEmergencyStop)
            }
            BrickCommand::SystemRun { command } => {
                state.shell.push(command.clone());
                Ok(BrickResponse::SystemRun { status: 0 })
            }
            BrickCommand::FsList { path } => {
                let prefix = format!("{}/", path.trim_end_matches('/'));
                let entries: Vec<FsEntry> = state
                    .files
                    .iter()
                    .filter_map(|(file, content)| {
                        let name = file.strip_prefix(&prefix)?;
                        (!name.contains('/')).then(|| FsEntry {
                            name: name.into(),
                            kind: FsEntryKind::File,
                            bytes: Some(content.len() as u32),
                            md5: state.md5s.get(file).cloned(),
                        })
                    })
                    .collect();
                if entries.is_empty() {
                    return Err(refused("fs:list"));
                }
                Ok(BrickResponse::FsList {
                    listing: ev3_protocol::responses::format_listing(&entries),
                    complete: true,
                    handle: None,
                })
            }
            BrickCommand::FsBeginWrite {
                path,
                total_bytes,
                chunk,
            } => {
                let handle = state.next_handle;
                state.next_handle += 1;
                state
                    .write_slots
                    .insert(handle, (path.clone(), *total_bytes as usize, Vec::new()));
                let end_of_file = Self::take(state, handle, chunk);
                Ok(BrickResponse::FsBeginWrite {
                    handle,
                    end_of_file,
                })
            }
            BrickCommand::FsContinueWrite { handle, chunk } => {
                if !state.write_slots.contains_key(handle) {
                    return Err(refused("fs:continueWrite"));
                }
                let end_of_file = Self::take(state, *handle, chunk);
                Ok(BrickResponse::FsContinueWrite {
                    handle: *handle,
                    end_of_file,
                })
            }
            BrickCommand::FsCloseHandle { handle } => {
                state.write_slots.remove(handle);
                Ok(BrickResponse::FsCloseHandle)
            }
            BrickCommand::FsDelete { path } => Ok(BrickResponse::FsDelete {
                deleted: state.files.remove(path).is_some(),
            }),
            other => panic!("not expected here: {}", other.kind()),
        }
    }

    fn take(state: &mut BrickState, handle: u8, chunk: &[u8]) -> bool {
        let Some((path, total, data)) = state.write_slots.get_mut(&handle) else {
            return false;
        };
        data.extend_from_slice(chunk);
        if data.len() < *total {
            return false;
        }
        let (path, data) = (path.clone(), data.clone());
        state.files.insert(path, data);
        state.write_slots.remove(&handle);
        true
    }

    async fn exchange(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        let held = {
            let mut state = self.state();
            if state.refuse.as_mut().is_some_and(|rule| rule(command)) {
                return Err(link_lost());
            }
            state.arrived.push(command.kind().into());
            match state.hold.iter().position(|kind| *kind == command.kind()) {
                Some(index) => {
                    state.hold.remove(index);
                    true
                }
                None => false,
            }
        };
        if held {
            self.released.acquire().await.unwrap().forget();
        }
        let mut state = self.state();
        state.log.push(command.kind().into());
        let answered = state.answer.as_mut().and_then(|answer| answer(command));
        let reply = match answered {
            Some(reply) => reply?,
            None => Self::run(&mut state, command)?,
        };
        if state.lose.as_mut().is_some_and(|rule| rule(command)) {
            return Err(reply_lost(command.kind()));
        }
        Ok(reply)
    }
}

#[async_trait]
impl ProgramLink for FakeBrick {
    async fn send(
        &self,
        command: &BrickCommand,
        _route_deadline: Option<Instant>,
    ) -> Result<BrickResponse, BrickError> {
        self.exchange(command).await
    }

    async fn wait_for_route(&self, deadline: Instant) -> Result<(), BrickError> {
        self.state().route_waits.push(deadline);
        Ok(())
    }

    fn channel(&self) -> Option<BrickKey> {
        Some(self.key.clone())
    }
}

#[async_trait]
impl CommandSender for FakeBrick {
    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        self.exchange(command).await
    }

    fn channel(&self) -> Option<BrickKey> {
        Some(self.key.clone())
    }
}

struct Link(Arc<FakeBrick>);

#[async_trait]
impl FileLink for Link {
    fn brick_key(&self) -> &BrickKey {
        &self.0.key
    }

    fn max_packet_bytes(&self) -> Option<usize> {
        Some(1024)
    }

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        self.0.exchange(command).await
    }
}

struct Route(Arc<FakeBrick>);

#[async_trait]
impl RouteSource for Route {
    async fn open(&self, _deadline: Option<Instant>) -> Result<Box<dyn FileLink>, FsError> {
        Ok(Box::new(Link(self.0.clone())))
    }
}

/// Answers every question with yes.
pub struct Yes;

#[async_trait]
impl ConsentPort for Yes {
    async fn ask(&self, _request: ConsentRequest) -> ConsentAnswer {
        ConsentAnswer::Granted
    }
}

/// Write reports, kept.
#[derive(Default)]
pub struct Reports(pub Mutex<Vec<ActivityEvent>>);

impl Reports {
    /// `started what` / `ended what`, in order.
    pub fn seen(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|event| match event {
                ActivityEvent::WriteStarted(activity) => {
                    format!("started {} for {}", activity.what, activity.requester.name)
                }
                ActivityEvent::WriteEnded(activity) => {
                    format!("ended {} for {}", activity.what, activity.requester.name)
                }
            })
            .collect()
    }
}

impl ActivityPort for Reports {
    fn report(&self, event: ActivityEvent) {
        self.0.lock().unwrap().push(event);
    }
}

pub fn quick() -> ProgramOptions {
    ProgramOptions {
        confirm_timeout: Duration::from_millis(300),
        confirm_step: Duration::from_millis(10),
    }
}

/// A brick's services over the fake brick: programs following through `follow`, files and
/// transfers for the deploy.
pub struct World {
    pub brick: Arc<FakeBrick>,
    pub programs: ProgramService,
    pub files: FilesystemService,
    pub transfer: FileTransferService,
    pub reports: Arc<Reports>,
}

pub fn world_with(follow: Option<Arc<dyn ProgramFollow>>) -> World {
    let brick = FakeBrick::new();
    let reports = Arc::new(Reports::default());
    let programs = ProgramService::new(brick.clone(), quick(), follow, Some(reports.clone()));
    let writes = WriteReporter {
        port: reports.clone(),
        requester: vscode(),
    };
    let files = FilesystemService::new(brick.clone(), Some(writes.clone()));
    let ledger = Arc::new(TransferLedger::new("00165300000A", Arc::new(Yes), None));
    let transfer = FileTransferService::new(Arc::new(Route(brick.clone())), ledger, writes);
    World {
        brick,
        programs,
        files,
        transfer,
        reports,
    }
}

pub fn world() -> World {
    world_with(None)
}

/// A stand-in for following the program row: counts follows and lets a test say the state.
#[derive(Default)]
pub struct FakeFollow {
    sinks: Mutex<Option<(u64, StateSink, EndSink)>>,
    pub follows: Mutex<u32>,
    pub disposes: Arc<Mutex<u32>>,
    /// Refuse every follow while set.
    pub failing: Mutex<bool>,
}

impl FakeFollow {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn counts(&self) -> (u32, u32) {
        (
            *self.follows.lock().unwrap(),
            *self.disposes.lock().unwrap(),
        )
    }

    /// The row says a state, sampled `at`.
    pub fn say(&self, running: bool, at: u64) {
        let sink = self
            .sinks
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, s, _)| s.clone());
        if let Some(sink) = sink {
            sink(running, at);
        }
    }

    /// The brick's session ended, and the claim with it.
    pub fn end_session(&self) {
        let ended = self.sinks.lock().unwrap().take();
        if let Some((_, _, end)) = ended {
            end();
        }
    }
}

impl ProgramFollow for FakeFollow {
    fn follow(&self, on_state: StateSink, on_ended: EndSink) -> Result<Following, ProgramError> {
        if *self.failing.lock().unwrap() {
            return Err(ProgramError::Subscription(
                "the brick is not connected".into(),
            ));
        }
        let id = {
            let mut follows = self.follows.lock().unwrap();
            *follows += 1;
            u64::from(*follows)
        };
        *self.sinks.lock().unwrap() = Some((id, on_state, on_ended));
        let disposes = self.disposes.clone();
        Ok(Following::new(move || {
            *disposes.lock().unwrap() += 1;
        }))
    }
}

/// Milliseconds since the Unix epoch, the unit row samples carry.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
