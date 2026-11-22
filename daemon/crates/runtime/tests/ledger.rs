//! An interrupted transfer must not leave the brick's space taken until a reboot.
//!
//! The firmware keeps a download's slot, with its open file, in one global table that nothing
//! clears on a disconnect; deleting the file only unlinks it, so its blocks stay taken.
//! `CLOSE_FILEHANDLE` releases the slot from any channel after any reconnect. So a transfer that
//! could not release its slot leaves a debt with the brick, and the next transfer settles it
//! before it starts: the slot closed and the partial file deleted. A slot whose number was never
//! learned (the reply to the first command lost) is swept, 0..63 and never higher, only when a
//! person agrees.

mod support_files;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::{BrickCommand, BrickResponse, build_command};
use ev3_runtime::bricks::BrickError;
use ev3_runtime::fs::FsError;
use ev3_runtime::ledger::{LedgerFile, Ledgers, ReleaseScope, TransferDebt, TransferLedger};
use ev3_runtime::ports::ConsentAnswer;
use ev3_runtime::transfer::{CancelFlag, FileLink, FileTransferService, TransferOptions};
use ev3_transports::BrickKey;
use support_files::{
    Consent, FakeLink, FakeRoute, PATH, Reports, body, cable_out, link_lost, requester, usb_key,
    writes,
};
use tokio::time::sleep;

const BRICK: &str = "00165300000A";
const Y: &str = "/home/root/lms2012/prjs/y.rbf";
const Z: &str = "/home/root/lms2012/prjs/z.rbf";
const A: &str = "/home/root/lms2012/prjs/a.rbf";

struct Setup {
    link: Arc<FakeLink>,
    ledger: Arc<TransferLedger>,
    service: Arc<FileTransferService>,
}

fn setup_with(consent: Arc<Consent>, store: Option<Arc<LedgerFile>>) -> Setup {
    let link = FakeLink::new(Some(1024));
    // What a read finds: one continuation after the first reply, and that one the last.
    link.state().files.insert(PATH.into(), body(1500));
    let ledger = Arc::new(TransferLedger::new(BRICK, consent, store));
    let service = Arc::new(FileTransferService::new(
        Arc::new(FakeRoute(link.clone())),
        ledger.clone(),
        writes(Arc::new(Reports::default())),
    ));
    Setup {
        link,
        ledger,
        service,
    }
}

fn setup(consent: Arc<Consent>) -> Setup {
    setup_with(consent, None)
}

fn nobody() -> Arc<Consent> {
    Consent::always(ConsentAnswer::Unanswered)
}

fn none() -> TransferOptions {
    TransferOptions::default()
}

/// Lets every task that is ready run.
async fn settle() {
    sleep(Duration::from_millis(1)).await;
}

impl Setup {
    async fn write(&self, path: &str, n: usize) -> Result<(), FsError> {
        self.service.write_file(path, &body(n), &none()).await
    }

    async fn read(&self) -> Result<Vec<u8>, FsError> {
        self.service.read_file(PATH, &none()).await
    }

    fn spawn_write(
        &self,
        path: &'static str,
        n: usize,
    ) -> tokio::task::JoinHandle<Result<(), FsError>> {
        let service = self.service.clone();
        tokio::spawn(async move { service.write_file(path, &body(n), &none()).await })
    }

    fn spawn_read(&self) -> tokio::task::JoinHandle<Result<Vec<u8>, FsError>> {
        let service = self.service.clone();
        tokio::spawn(async move { service.read_file(PATH, &none()).await })
    }
}

// ── Known slots ─────────────────────────────────────────────────────

#[tokio::test]
async fn closes_the_slot_and_deletes_the_partial_file_before_the_next_transfer_after_the_link_was_lost()
 {
    let s = setup(nobody());
    s.link.cut_on("fs:continueWrite");
    let error = s.write(PATH, 3000).await.unwrap_err();
    assert!(error.may_have_run(), "{error:?}");

    s.link.reconnect();
    s.link.clear();
    s.write(Y, 10).await.unwrap();

    assert_eq!(
        s.link.kinds()[..3],
        ["close 3", "fs:delete", "fs:beginWrite"]
    );
    assert_eq!(s.link.deletes()[0], PATH);
}

#[tokio::test]
async fn takes_unknown_handle_as_settled_the_slot_was_already_free() {
    let s = setup(nobody());
    s.link.cut_on("fs:continueWrite");
    s.write(PATH, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.forget(3);

    s.write(Y, 10).await.unwrap();

    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test]
async fn keeps_the_debt_while_the_link_is_still_down_and_settles_it_the_next_time() {
    let s = setup(nobody());
    s.link.cut_on("fs:continueWrite");
    s.write(PATH, 3000).await.unwrap_err();

    s.write(Y, 10).await.unwrap_err();
    assert_eq!(s.ledger.pending(), 1);

    s.link.reconnect();
    s.write(Y, 10).await.unwrap();
    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test(start_paused = true)]
async fn releases_at_once_and_leaves_no_debt_when_the_link_is_still_there() {
    let s = setup(nobody());
    let cancel = CancelFlag::new();
    let options = TransferOptions {
        cancel: Some(cancel.clone()),
        ..none()
    };
    s.link.hold("fs:continueWrite");
    let content = body(5000);

    let (result, ()) = tokio::join!(s.service.write_file(PATH, &content, &options), async {
        settle().await;
        cancel.cancel();
        s.link.release();
    });

    assert_eq!(result, Err(FsError::Cancelled));
    let kinds = s.link.kinds();
    assert_eq!(
        kinds[kinds.len() - 2..],
        ["close 3", "fs:delete"],
        "{kinds:?}"
    );
    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test]
async fn leaves_a_reads_file_alone_and_closes_the_slot_only() {
    // The read has one continuation, the last, so its slot is uncertain and asked about.
    let consent = Consent::always(ConsentAnswer::Granted);
    let s = setup(consent.clone());
    s.link.cut_on("fs:continueRead");
    s.read().await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    s.read().await.unwrap();

    assert_eq!(consent.actions(), [ReleaseScope::One.question()]);
    assert_eq!(s.link.kinds()[..2], ["close 3", "fs:beginRead"]);
    assert!(s.link.deletes().is_empty());
}

// ── Slots never learned ─────────────────────────────────────────────

#[tokio::test]
async fn sweeps_a_slot_it_never_learned_0_to_63_and_no_higher_only_when_the_person_agrees() {
    let consent = Consent::always(ConsentAnswer::Granted);
    let s = setup(consent.clone());
    s.link.cut_on("fs:beginWrite"); // the first command's reply lost
    s.write(PATH, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();

    assert_eq!(s.link.closes(), (0..64).collect::<Vec<u8>>());
    assert_eq!(consent.actions(), [ReleaseScope::All.question()]);
    assert_eq!(s.link.deletes(), [PATH]);
    // The question names who it is asked for, and the brick.
    let asked = consent.asked.lock().unwrap()[0].clone();
    assert_eq!(
        (asked.requester, asked.brick_key),
        (requester(), Some(usb_key()))
    );
}

#[tokio::test]
async fn does_not_sweep_when_the_person_declines_and_does_not_ask_again() {
    let consent = Consent::always(ConsentAnswer::Declined);
    let s = setup(consent.clone());
    s.link.cut_on("fs:beginWrite");
    s.write(PATH, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();
    s.write(Z, 10).await.unwrap();

    assert!(s.link.closes().is_empty());
    assert_eq!(consent.count(), 1);
    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test]
async fn never_sweeps_without_someone_answering_the_debt_waits() {
    let s = setup(nobody());
    s.link.cut_on("fs:beginWrite");
    s.write(PATH, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();

    assert!(s.link.closes().is_empty());
    assert_eq!(s.ledger.pending(), 1);
}

#[tokio::test(start_paused = true)]
async fn settles_nothing_while_another_transfer_of_its_own_runs_it_could_close_that_ones_slot() {
    let s = setup(Consent::always(ConsentAnswer::Granted));
    s.link.cut_on("fs:beginWrite");
    s.write(Z, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.hold("fs:continueWrite");
    let first = s.spawn_write(A, 3000);
    settle().await;
    s.link.clear();

    let second = s.spawn_read();
    settle().await;
    assert!(
        s.link.closes().is_empty(),
        "no sweep under a running transfer"
    );
    s.link.release();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(
        s.ledger.pending(),
        0,
        "settled by the first transfer, before it began"
    );
}

#[tokio::test(start_paused = true)]
async fn leaves_a_debt_that_arose_while_a_transfer_of_its_own_runs_for_after_it() {
    let s = setup(Consent::always(ConsentAnswer::Granted));
    s.link.hold("fs:continueWrite");
    let running = s.spawn_write(A, 3000);
    settle().await;
    s.ledger.owe(TransferDebt::Unknown { delete_path: None }); // another call's first reply, lost
    s.link.clear();

    let next = s.spawn_read();
    settle().await;
    assert!(
        s.link.closes().is_empty(),
        "the running write keeps its slot"
    );
    s.link.release();
    running.await.unwrap().unwrap();
    next.await.unwrap().unwrap();
    assert_eq!(
        s.ledger.pending(),
        1,
        "still owed, for a transfer that starts with nothing running"
    );
}

#[tokio::test(start_paused = true)]
async fn lets_no_transfer_start_while_a_settlement_still_waits_on_the_person() {
    let consent = Consent::gated(ConsentAnswer::Granted);
    let s = setup(consent.clone());
    s.link.cut_on("fs:beginWrite");
    s.write(Z, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    let first = s.spawn_write(Y, 10);
    settle().await;
    let second = s.spawn_read(); // starts while the question is open
    settle().await;
    assert!(
        s.link.kinds().is_empty(),
        "a transfer went out under the settlement"
    );

    consent.open_gate();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    let kinds = s.link.kinds();
    let at = |k: &str| kinds.iter().position(|x| x == k).unwrap();
    let last_close = kinds.iter().rposition(|x| x == "close 63").unwrap();
    assert!(
        last_close < at("fs:beginRead") && last_close < at("fs:beginWrite"),
        "the sweep did not end before both transfers began: {kinds:?}"
    );
}

#[tokio::test]
async fn keeps_the_debt_when_nobody_answers_and_asks_again() {
    let consent = Consent::answering(|n| {
        if n == 0 {
            ConsentAnswer::Unanswered
        } else {
            ConsentAnswer::Granted
        }
    });
    let s = setup(consent.clone());
    s.link.cut_on("fs:beginWrite");
    s.write(PATH, 3000).await.unwrap_err();
    s.link.reconnect();

    s.write(Y, 10).await.unwrap();
    assert_eq!(
        s.ledger.pending(),
        1,
        "the debt went with an unanswered question"
    );
    s.write(Z, 10).await.unwrap();
    assert_eq!(consent.count(), 2);
    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test]
async fn owes_nothing_for_a_first_command_refused_before_it_left() {
    let s = setup(Consent::always(ConsentAnswer::Granted));
    s.link.state().refuse = Some(Box::new(|_| true));

    let error = s.write(PATH, 3000).await.unwrap_err();

    assert_eq!(error, FsError::Command(link_lost()));
    assert_eq!(s.ledger.pending(), 0);
}

// ── After the last byte ─────────────────────────────────────────────

/// A brick that takes every byte in `BEGIN_DOWNLOAD` without saying end of file, and whose
/// close fails as told.
struct NoEndOfFile {
    key: BrickKey,
    close_fails: BrickError,
    sent: Mutex<Vec<&'static str>>,
}

#[async_trait]
impl FileLink for NoEndOfFile {
    fn brick_key(&self) -> &BrickKey {
        &self.key
    }

    fn max_packet_bytes(&self) -> Option<usize> {
        Some(1024)
    }

    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        self.sent.lock().unwrap().push(command.kind());
        match command {
            BrickCommand::FsBeginWrite { .. } => Ok(BrickResponse::FsBeginWrite {
                handle: 7,
                end_of_file: false,
            }),
            BrickCommand::FsCloseHandle { .. } => Err(self.close_fails.clone()),
            other => panic!("unexpected {}", other.kind()),
        }
    }
}

struct Fixed(Arc<NoEndOfFile>);

#[async_trait]
impl ev3_runtime::transfer::RouteSource for Fixed {
    async fn open(
        &self,
        _deadline: Option<tokio::time::Instant>,
    ) -> Result<Box<dyn FileLink>, FsError> {
        struct Shared(Arc<NoEndOfFile>);
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
        Ok(Box::new(Shared(self.0.clone())))
    }
}

async fn owed_after_close_fails(close_fails: BrickError) -> (Vec<&'static str>, Vec<TransferDebt>) {
    let link = Arc::new(NoEndOfFile {
        key: usb_key(),
        close_fails,
        sent: Mutex::new(Vec::new()),
    });
    let ledger = Arc::new(TransferLedger::new(BRICK, nobody(), None));
    let service = FileTransferService::new(
        Arc::new(Fixed(link.clone())),
        ledger.clone(),
        writes(Arc::new(Reports::default())),
    );
    // Every byte in BEGIN, no end of file: the file is whole, only the slot is left.
    service.write_file(PATH, &body(10), &none()).await.unwrap();
    let sent = link.sent.lock().unwrap().clone();
    (sent, ledger.snapshot())
}

#[tokio::test]
async fn owes_the_slot_when_the_close_after_the_last_byte_goes_with_the_link() {
    let (sent, owed) = owed_after_close_fails(cable_out()).await;
    assert_eq!(sent, ["fs:beginWrite", "fs:closeHandle"]);
    assert_eq!(owed.len(), 1);
}

#[tokio::test]
async fn owes_an_uncertain_slot_when_a_close_may_have_run_and_a_certain_one_when_it_never_left() {
    assert_eq!(
        owed_after_close_fails(cable_out()).await.1,
        [TransferDebt::uncertain_slot(7, None)]
    );
    assert_eq!(
        owed_after_close_fails(link_lost()).await.1,
        [TransferDebt::slot(7, None)]
    );
}

#[tokio::test]
async fn deletes_nothing_a_later_complete_write_produced() {
    let s = setup(nobody());
    s.ledger.owe(TransferDebt::Delete { path: PATH.into() });
    s.ledger.owe(TransferDebt::slot(5, Some(PATH.into())));
    s.ledger.written(PATH);

    s.write(Y, 10).await.unwrap();

    assert_eq!(
        s.link.kinds()[..2],
        ["close 5", "fs:beginWrite"],
        "the slot is still owed, the delete is not"
    );
    assert!(s.link.deletes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn keeps_a_file_completed_meanwhile_safe_from_a_delete_owed_while_it_was_written() {
    let s = setup(nobody());
    s.link.hold("fs:continueWrite");
    let writing = s.spawn_write(PATH, 3000);
    settle().await;
    s.ledger.owe(TransferDebt::Delete { path: PATH.into() }); // from an overlapping write, owed meanwhile
    s.link.release();
    writing.await.unwrap().unwrap();

    s.write(Y, 10).await.unwrap();
    assert!(s.link.deletes().is_empty(), "the complete file was deleted");
}

// ── A slot the brick may already have handed on ─────────────────────

/// `BEGIN_DOWNLOAD` carries 984 bytes of it, one continuation the rest.
const LAST_CHUNK_ONLY: usize = 1500;

#[tokio::test]
async fn closes_nothing_when_the_last_chunks_reply_is_lost_and_asks_before_closing_that_one_slot() {
    let consent = Consent::always(ConsentAnswer::Granted);
    let s = setup(consent.clone());
    s.link.cut_on("fs:continueWrite");
    s.write(PATH, LAST_CHUNK_ONLY).await.unwrap_err();
    assert_eq!(
        s.link.kinds(),
        ["fs:beginWrite", "fs:continueWrite"],
        "something went out after the uncertain chunk"
    );
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();

    assert_eq!(consent.actions(), [ReleaseScope::One.question()]);
    assert_eq!(
        s.link.kinds()[..3],
        ["close 3", "fs:delete", "fs:beginWrite"],
        "not that slot alone, before the transfer"
    );
    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test]
async fn leaves_the_slot_alone_when_the_person_declines_and_does_not_ask_again() {
    let consent = Consent::always(ConsentAnswer::Declined);
    let s = setup(consent.clone());
    s.link.cut_on("fs:continueWrite");
    s.write(PATH, LAST_CHUNK_ONLY).await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();
    s.write(Z, 10).await.unwrap();

    assert!(s.link.closes().is_empty());
    assert_eq!(consent.count(), 1);
    assert_eq!(s.ledger.pending(), 0);
}

#[tokio::test]
async fn still_closes_at_once_unasked_when_the_chunk_lost_was_not_the_last() {
    let consent = Consent::always(ConsentAnswer::Granted);
    let s = setup(consent.clone());
    s.link.cut_on("fs:continueWrite"); // the first of two continuation chunks
    s.write(PATH, 3000).await.unwrap_err();
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();

    assert_eq!(consent.count(), 0);
    assert_eq!(
        s.link.kinds()[..3],
        ["close 3", "fs:delete", "fs:beginWrite"]
    );
}

#[tokio::test]
async fn turns_a_known_slot_uncertain_when_the_settlements_own_close_loses_its_reply() {
    let consent = Consent::always(ConsentAnswer::Granted);
    let s = setup(consent.clone());
    s.ledger.owe(TransferDebt::slot(5, None));
    s.link.cut_on("fs:closeHandle"); // the close goes out, its reply does not come back
    s.write(Y, 10).await.unwrap_err();
    assert_eq!(s.ledger.snapshot(), [TransferDebt::uncertain_slot(5, None)]);
    s.link.reconnect();
    s.link.clear();

    s.write(Y, 10).await.unwrap();

    assert_eq!(
        consent.actions(),
        [ReleaseScope::One.question()],
        "the slot was closed again unasked"
    );
    assert_eq!(s.link.kinds()[..2], ["close 5", "fs:beginWrite"]);
}

#[tokio::test]
async fn asks_about_each_uncertain_slot_on_its_own_and_a_no_keeps_that_one_alone() {
    let consent = Consent::answering(|n| {
        if n == 0 {
            ConsentAnswer::Granted
        } else {
            ConsentAnswer::Declined
        }
    });
    let s = setup(consent.clone());
    s.ledger.owe(TransferDebt::uncertain_slot(5, None));
    s.ledger.owe(TransferDebt::uncertain_slot(6, None));

    s.write(Y, 10).await.unwrap();

    assert_eq!(consent.count(), 2);
    assert_eq!(s.link.closes(), [5]);
}

#[tokio::test(start_paused = true)]
async fn keeps_a_known_slot_as_uncertain_when_the_settlement_is_dropped_with_its_close_on_the_way()
{
    // The close may have run, freeing the number for someone else: it is asked about from now on,
    // never closed again unasked.
    let s = setup(nobody());
    s.ledger.owe(TransferDebt::slot(5, None));
    s.link.hold("fs:closeHandle");

    tokio::select! {
        _ = s.write(Y, 10) => panic!("finished"),
        () = sleep(Duration::from_millis(10)) => {}
    }

    assert_eq!(s.ledger.snapshot(), [TransferDebt::uncertain_slot(5, None)]);
}

// ── One ledger per brick ────────────────────────────────────────────

#[test]
fn keeps_one_ledger_per_brick_for_the_same_brick_layer() {
    let layer = Ledgers::new(nobody(), None);
    let other = Ledgers::new(nobody(), None);
    assert!(Arc::ptr_eq(
        &layer.ledger_for("AAA"),
        &layer.ledger_for("AAA")
    ));
    assert!(!Arc::ptr_eq(
        &layer.ledger_for("AAA"),
        &layer.ledger_for("BBB")
    ));
    assert!(!Arc::ptr_eq(
        &layer.ledger_for("AAA"),
        &other.ledger_for("AAA")
    ));
}

#[test]
fn never_puts_a_slot_number_past_the_firmwares_table_on_the_wire() {
    let close_64 = build_command(&BrickCommand::FsCloseHandle { handle: 64 }).unwrap_err();
    assert!(close_64.message().contains("0..63"), "{close_64}");
    let chunk_200 = build_command(&BrickCommand::FsContinueWrite {
        handle: 200,
        chunk: vec![0],
    })
    .unwrap_err();
    assert!(chunk_200.message().contains("0..63"), "{chunk_200}");
    assert!(build_command(&BrickCommand::FsCloseHandle { handle: 63 }).is_ok());
}

// ── Across daemons ──────────────────────────────────────────────────

/// A fresh state folder for one test, removed when dropped.
struct StateDir(PathBuf);

impl StateDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ev3-ledger-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Self(dir)
    }

    fn ledger(&self) -> PathBuf {
        self.0.join("ledger.json")
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(self.ledger()).unwrap()).unwrap()
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn keeps_debts_in_the_state_file_and_pays_them_before_the_next_daemons_first_transfer() {
    let dir = StateDir::new("paid");

    // The first daemon records a debt and ends.
    {
        let store = Arc::new(LedgerFile::open(dir.ledger()).unwrap());
        let first = Ledgers::new(nobody(), Some(store));
        first.ledger_for(BRICK).owe(TransferDebt::slot(
            7,
            Some("/home/root/lms2012/prjs/a.rbf".into()),
        ));
    }
    assert_eq!(
        dir.json(),
        serde_json::json!({ BRICK: [{ "kind": "slot", "handle": 7, "deletePath": "/home/root/lms2012/prjs/a.rbf" }] })
    );

    // The next daemon starts, and its first transfer on that brick pays the debt.
    let store = Arc::new(LedgerFile::open(dir.ledger()).unwrap());
    let next = Ledgers::new(nobody(), Some(store));
    let ledger = next.ledger_for(BRICK);
    assert_eq!(ledger.pending(), 1);
    let link = FakeLink::new(Some(1024));
    drop(ledger.begin(link.as_ref(), &requester()).await.unwrap());
    assert_eq!(link.kinds(), ["close 7", "fs:delete"]);
    assert_eq!(ledger.pending(), 0);
    assert_eq!(dir.json(), serde_json::json!({}));
}

#[tokio::test]
async fn sweeps_a_cut_uploads_slot_after_a_restart_only_with_consent_and_never_offers_a_declined_one_again()
 {
    let dir = StateDir::new("sweep");

    // A cut upload: the first command's reply lost.
    {
        let store = Arc::new(LedgerFile::open(dir.ledger()).unwrap());
        let s = setup_with(nobody(), Some(store));
        s.link.cut_on("fs:beginWrite");
        s.write(PATH, 3000).await.unwrap_err();
    }
    assert_eq!(
        dir.json(),
        serde_json::json!({ BRICK: [{ "kind": "unknown", "deletePath": PATH }] })
    );

    // The daemon restarts; nobody answers: the debt survives that too.
    {
        let store = Arc::new(LedgerFile::open(dir.ledger()).unwrap());
        let s = setup_with(nobody(), Some(store));
        s.write(Y, 10).await.unwrap();
        assert!(s.link.closes().is_empty());
    }
    assert_eq!(dir.json()[BRICK].as_array().map(Vec::len), Some(1));

    // Restarts again; this time the person agrees.
    let consent = Consent::always(ConsentAnswer::Granted);
    let store = Arc::new(LedgerFile::open(dir.ledger()).unwrap());
    let s = setup_with(consent.clone(), Some(store));
    s.write(Y, 10).await.unwrap();
    assert_eq!(s.link.closes(), (0..64).collect::<Vec<u8>>());
    assert_eq!(s.link.deletes()[0], PATH);
    assert_eq!(consent.count(), 1);
    assert_eq!(dir.json(), serde_json::json!({}));

    // A declined sweep is dropped from the file: the next daemon does not ask again.
    let declined = StateDir::new("declined");
    {
        let store = Arc::new(LedgerFile::open(declined.ledger()).unwrap());
        let s = setup_with(Consent::always(ConsentAnswer::Declined), Some(store));
        s.link.cut_on("fs:beginWrite");
        s.write(PATH, 3000).await.unwrap_err();
        s.link.reconnect();
        s.write(Y, 10).await.unwrap();
    }
    let asked = Consent::always(ConsentAnswer::Granted);
    let store = Arc::new(LedgerFile::open(declined.ledger()).unwrap());
    let s = setup_with(asked.clone(), Some(store));
    assert_eq!(s.ledger.pending(), 0);
    s.write(Y, 10).await.unwrap();
    assert_eq!(asked.count(), 0);
}

#[test]
fn stores_every_kind_of_debt_in_the_shape_the_node_daemon_kept() {
    let dir = StateDir::new("format");
    let store = LedgerFile::open(dir.ledger()).unwrap();
    store.save(
        BRICK,
        &[
            TransferDebt::slot(7, Some("/p/a.rbf".into())),
            TransferDebt::uncertain_slot(5, None),
            TransferDebt::Delete {
                path: "/p/b.rbf".into(),
            },
            TransferDebt::Unknown { delete_path: None },
            TransferDebt::Unknown {
                delete_path: Some("/p/c.rbf".into()),
            },
        ],
    );
    store.save("001653000000", &[]);

    let expected = format!(
        r#"{{
  "{BRICK}": [
    {{
      "kind": "slot",
      "handle": 7,
      "deletePath": "/p/a.rbf"
    }},
    {{
      "kind": "slot",
      "handle": 5,
      "uncertain": true
    }},
    {{
      "kind": "delete",
      "path": "/p/b.rbf"
    }},
    {{
      "kind": "unknown"
    }},
    {{
      "kind": "unknown",
      "deletePath": "/p/c.rbf"
    }}
  ]
}}
"#
    );
    assert_eq!(std::fs::read_to_string(dir.ledger()).unwrap(), expected);
    assert_eq!(store.last_error(), None);
}

#[test]
fn reads_a_ledger_the_node_daemon_wrote() {
    let dir = StateDir::new("node");
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(
        dir.ledger(),
        r#"{"00165300000B":[{"kind":"slot","handle":7,"deletePath":"/home/root/lms2012/prjs/a.rbf"},{"kind":"slot","handle":5,"uncertain":true},{"kind":"delete","path":"/p/b"},{"kind":"unknown"}]}"#,
    )
    .unwrap();

    let store = LedgerFile::open(dir.ledger()).unwrap();

    assert_eq!(
        store.load("00165300000B"),
        [
            TransferDebt::slot(7, Some("/home/root/lms2012/prjs/a.rbf".into())),
            TransferDebt::uncertain_slot(5, None),
            TransferDebt::Delete {
                path: "/p/b".into()
            },
            TransferDebt::Unknown { delete_path: None },
        ]
    );
    assert!(store.load(BRICK).is_empty());
}

#[test]
fn refuses_a_ledger_file_it_cannot_read_rather_than_starting_over_it() {
    // Starting empty over a damaged file would overwrite the debts it holds at the next save.
    let dir = StateDir::new("damaged");
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(dir.ledger(), "{ not json").unwrap();

    let error = LedgerFile::open(dir.ledger())
        .err()
        .expect("a damaged file refused");
    assert!(error.to_string().contains("cannot be read"), "{error}");
}
