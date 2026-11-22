//! The filesystem service: the behaviours hardware caught, not the obvious ones.
//!
//! Every assertion here stands for something that was wrong when first run against a brick:
//! `exists` answering true whatever the reply said, `size` reporting kilobytes where bytes were
//! promised, `files` being zero for a plain file, and a rename needing two commands because the
//! protocol has none.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ev3_protocol::responses::{FsEntry, FsEntryKind, format_listing};
use ev3_protocol::{BrickCommand, BrickResponse, ProtocolError};
use ev3_runtime::bricks::BrickError;
use ev3_runtime::error::SessionError;
use ev3_runtime::fs::{CommandSender, FilesystemService, FsError, WriteReporter};
use ev3_runtime::ports::{ActivityEvent, ActivityPort, ClientKind, Requester};
use ev3_transports::{BrickKey, Transport, TransportError};

type Answer = Box<dyn Fn(&BrickCommand) -> Result<BrickResponse, BrickError> + Send + Sync>;

/// Records commands and answers them from a table keyed by command kind.
struct FakeBrick {
    answers: Vec<(&'static str, Answer)>,
    sent: Mutex<Vec<BrickCommand>>,
}

impl FakeBrick {
    fn new() -> Self {
        Self {
            answers: Vec::new(),
            sent: Mutex::new(Vec::new()),
        }
    }

    fn answer(
        mut self,
        kind: &'static str,
        answer: impl Fn(&BrickCommand) -> Result<BrickResponse, BrickError> + Send + Sync + 'static,
    ) -> Self {
        self.answers.push((kind, Box::new(answer)));
        self
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(BrickCommand::kind)
            .collect()
    }
}

#[async_trait]
impl CommandSender for FakeBrick {
    async fn send(&self, command: &BrickCommand) -> Result<BrickResponse, BrickError> {
        self.sent.lock().unwrap().push(command.clone());
        match self
            .answers
            .iter()
            .find(|(kind, _)| *kind == command.kind())
        {
            Some((_, answer)) => answer(command),
            None => Err(link_failure(&format!(
                "no fake answer for {}",
                command.kind()
            ))),
        }
    }

    fn channel(&self) -> Option<BrickKey> {
        Some(BrickKey::new(Transport::Usb, "00165300000A").unwrap())
    }
}

fn link_failure(message: &str) -> BrickError {
    BrickError::Session(SessionError::Transport(TransportError::transport_failed(
        message,
    )))
}

fn brick_refused(message: &str) -> BrickError {
    BrickError::Session(SessionError::Protocol(ProtocolError::new(message)))
}

fn entry(name: &str, kind: FsEntryKind) -> FsEntry {
    FsEntry {
        name: name.to_owned(),
        kind,
        bytes: None,
        md5: None,
    }
}

fn service(brick: FakeBrick) -> (Arc<FakeBrick>, FilesystemService) {
    let brick = Arc::new(brick);
    (brick.clone(), FilesystemService::new(brick, None))
}

// ── Listing ─────────────────────────────────────────────────────────

#[tokio::test]
async fn drops_the_dot_entries_a_brick_really_returns() {
    // Left in, a caller walking a tree recurses into its own parent forever.
    let (_, files) = service(FakeBrick::new().answer("fs:list", |_| {
        Ok(BrickResponse::FsList {
            complete: true,
            handle: None,
            listing: format_listing(&[
                entry(".", FsEntryKind::Directory),
                entry("..", FsEntryKind::Directory),
                entry("Proj", FsEntryKind::Directory),
                entry("a.rbf", FsEntryKind::File),
            ]),
        })
    }));

    let names: Vec<String> = files
        .list("/p")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, ["Proj", "a.rbf"]);
}

#[tokio::test]
async fn reads_a_name_the_brick_cut_between_two_pages_as_one_entry() {
    // The firmware fills each page to the byte and carries the rest of a cut name into the next
    // one (c_com.c, CONTINUE_LIST_FILES). Read page by page, the cut line made two wrong entries.
    let whole = b"0123456789ABCDEF0123456789ABCDEF 0000002A long file name.rbf\nsub/\n";
    let cut = 50; // inside the file name
    let (_, files) = service(
        FakeBrick::new()
            .answer("fs:list", move |_| {
                Ok(BrickResponse::FsList {
                    complete: false,
                    handle: Some(4),
                    listing: whole[..cut].to_vec(),
                })
            })
            .answer("fs:listContinue", move |_| {
                Ok(BrickResponse::FsListContinue {
                    complete: true,
                    handle: 4,
                    listing: whole[cut..].to_vec(),
                })
            }),
    );

    let entries = files.list("/p").await.unwrap();
    let shape: Vec<_> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.kind, e.bytes))
        .collect();
    assert_eq!(
        shape,
        [
            ("long file name.rbf", FsEntryKind::File, Some(42)),
            ("sub", FsEntryKind::Directory, None)
        ]
    );
}

#[tokio::test]
async fn follows_the_continuation_until_the_brick_reports_completion() {
    let page = Arc::new(Mutex::new(0));
    let counter = page.clone();
    let (brick, files) = service(
        FakeBrick::new()
            .answer("fs:list", |_| {
                Ok(BrickResponse::FsList {
                    complete: false,
                    handle: Some(7),
                    listing: format_listing(&[entry("one", FsEntryKind::File)]),
                })
            })
            .answer("fs:listContinue", move |_| {
                let mut page = counter.lock().unwrap();
                *page += 1;
                Ok(BrickResponse::FsListContinue {
                    complete: *page == 2,
                    handle: 7,
                    listing: format_listing(&[entry(&format!("page{page}"), FsEntryKind::File)]),
                })
            }),
    );

    let names: Vec<String> = files
        .list("/p")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, ["one", "page1", "page2"]);
    assert_eq!(
        brick
            .kinds()
            .iter()
            .filter(|k| **k == "fs:listContinue")
            .count(),
        2
    );
}

#[tokio::test]
async fn stops_when_a_continuation_returns_nothing_rather_than_looping() {
    // A brick that never says complete and never adds anything would spin forever.
    let (_, files) = service(
        FakeBrick::new()
            .answer("fs:list", |_| {
                Ok(BrickResponse::FsList {
                    complete: false,
                    handle: Some(1),
                    listing: format_listing(&[entry("one", FsEntryKind::File)]),
                })
            })
            .answer("fs:listContinue", |_| {
                Ok(BrickResponse::FsListContinue {
                    complete: false,
                    handle: 1,
                    listing: Vec::new(),
                })
            }),
    );

    let names: Vec<String> = files
        .list("/p")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, ["one"]);
}

// ── Metadata ────────────────────────────────────────────────────────

#[tokio::test]
async fn reports_existence_from_the_reply_not_from_the_call_succeeding() {
    // The regression this replaces returned true whenever the command did not fail, so it
    // claimed a file was present in a directory created empty a moment earlier.
    let (_, absent) = service(FakeBrick::new().answer("fs:exists", |_| {
        Ok(BrickResponse::FsExists { exists: false })
    }));
    assert!(!absent.exists("/p/x").await.unwrap());
    let (_, present) = service(FakeBrick::new().answer("fs:exists", |_| {
        Ok(BrickResponse::FsExists { exists: true })
    }));
    assert!(present.exists("/p/x").await.unwrap());
}

#[tokio::test]
async fn passes_through_kilobytes_and_a_zero_file_count_for_a_plain_file() {
    // Both what the firmware does: the size is rounded up to whole kilobytes, and the file
    // counter only advances while walking a directory.
    let (_, files) = service(FakeBrick::new().answer("fs:size", |_| {
        Ok(BrickResponse::FsSize {
            kilobytes: 1,
            files: 0,
        })
    }));

    let size = files.size("/p/x").await.unwrap();
    assert_eq!((size.kilobytes, size.files), (1, 0));
}

// ── Structure ───────────────────────────────────────────────────────

#[tokio::test]
async fn fails_when_the_brick_says_the_directory_does_not_exist_afterwards() {
    let (_, files) = service(FakeBrick::new().answer("fs:makeDirectory", |_| {
        Ok(BrickResponse::FsMakeDirectory { exists: false })
    }));

    let error = files.make_directory("/p/d").await.unwrap_err();
    assert!(error.to_string().contains("did not create"), "{error}");
}

#[tokio::test]
async fn explains_a_populated_directory_refusal_instead_of_passing_no_permission_on() {
    // The firmware reports ENOTEMPTY as NO_PERMISSION, which sends the reader looking for a
    // permissions problem that is not there. It arrives as the brick's own error answer.
    let (_, files) = service(FakeBrick::new().answer("fs:delete", |_| {
        Err(brick_refused(
            "EV3 system command error for 'fs:delete': NO_PERMISSION",
        ))
    }));

    let error = files.remove("/p/d").await.unwrap_err();
    assert!(matches!(error, FsError::NotEmpty { .. }), "{error:?}");
    assert!(error.to_string().contains("not empty"), "{error}");
}

#[tokio::test]
async fn renames_as_a_copy_followed_by_a_delete_in_that_order() {
    // The protocol has no rename: opFILE/MOVE runs cp -r and leaves the source. The delete
    // walks the source as a recursive remove does: listed, then deleted bottom-up.
    let (brick, files) = service(
        FakeBrick::new()
            .answer("fs:copy", |_| Ok(BrickResponse::FsCopy))
            .answer("fs:list", |_| {
                Ok(BrickResponse::FsList {
                    complete: true,
                    handle: None,
                    listing: Vec::new(),
                })
            })
            .answer("fs:delete", |_| {
                Ok(BrickResponse::FsDelete { deleted: true })
            }),
    );

    files.move_path("/p/a", "/p/b").await.unwrap();
    assert_eq!(brick.kinds(), ["fs:copy", "fs:list", "fs:delete"]);
}

#[tokio::test]
async fn says_both_copies_exist_when_the_delete_half_of_a_rename_fails() {
    // Silence here would leave a duplicate the caller does not know about.
    let (_, files) = service(
        FakeBrick::new()
            .answer("fs:copy", |_| Ok(BrickResponse::FsCopy))
            .answer("fs:list", |_| Err(link_failure("brick refused"))),
    );

    let error = files.move_path("/p/a", "/p/b").await.unwrap_err();
    assert!(error.to_string().contains("both now exist"), "{error}");
}

#[tokio::test]
async fn removes_a_tree_bottom_up_and_reports_what_the_brick_kept() {
    // The firmware's own remove is one level deep, so the walk is done here: a subdirectory with
    // anything in it would otherwise stay, and the directory with it, without a word.
    let (brick, files) = service(
        FakeBrick::new()
            .answer("fs:list", |command| {
                let BrickCommand::FsList { path } = command else {
                    unreachable!()
                };
                let entries = match path.as_str() {
                    "/p/d" => vec![
                        entry("sub", FsEntryKind::Directory),
                        entry("a", FsEntryKind::File),
                    ],
                    "/p/d/sub" => vec![entry("b", FsEntryKind::File)],
                    _ => Vec::new(),
                };
                Ok(BrickResponse::FsList {
                    complete: true,
                    handle: None,
                    listing: format_listing(&entries),
                })
            })
            .answer("fs:delete", |command| {
                let BrickCommand::FsDelete { path } = command else {
                    unreachable!()
                };
                Ok(BrickResponse::FsDelete {
                    deleted: path != "/p/d/a",
                })
            })
            .answer("fs:exists", |_| {
                Ok(BrickResponse::FsExists { exists: true })
            }),
    );

    let report = files.remove_tree("/p/d/").await.unwrap();
    assert_eq!(report.left_behind, ["/p/d/a"]);
    let deletes: Vec<String> = brick
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter_map(|c| match c {
            BrickCommand::FsDelete { path } => Some(path.clone()),
            _ => None,
        })
        .collect();
    // The directory that kept a file is not deleted, and not listed as left behind either.
    assert_eq!(deletes, ["/p/d/sub/b", "/p/d/sub", "/p/d/a"]);
}

// ── Path guard ──────────────────────────────────────────────────────

#[tokio::test]
async fn refuses_a_path_the_firmware_would_truncate_before_sending_anything() {
    let (brick, files) = service(FakeBrick::new());
    let too_long = format!("/home/root/lms2012/prjs/{}", "d".repeat(40));

    let error = files.exists(&too_long).await.unwrap_err();
    assert!(error.to_string().contains("truncates silently"), "{error}");
    assert!(brick.kinds().is_empty());
}

#[tokio::test]
async fn refuses_a_path_with_a_nul_before_sending_anything() {
    // The brick reads the path as a C string and would delete .../sys/ui, not the named file.
    let (brick, files) = service(FakeBrick::new());

    let error = files
        .remove("/home/root/lms2012/sys/ui\u{0}/../../prjs/a")
        .await
        .unwrap_err();
    assert_eq!(error, FsError::PathHasControlCharacter);
    assert!(brick.kinds().is_empty());
}

// ── Write reports ───────────────────────────────────────────────────

#[derive(Default)]
struct Reports(Mutex<Vec<ActivityEvent>>);

impl ActivityPort for Reports {
    fn report(&self, event: ActivityEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[tokio::test]
async fn reports_a_write_to_the_brick_while_it_runs_and_none_for_a_read() {
    let brick = Arc::new(
        FakeBrick::new()
            .answer("fs:makeDirectory", |_| {
                Ok(BrickResponse::FsMakeDirectory { exists: true })
            })
            .answer("fs:exists", |_| {
                Ok(BrickResponse::FsExists { exists: true })
            }),
    );
    let reports = Arc::new(Reports::default());
    let files = FilesystemService::new(
        brick,
        Some(WriteReporter {
            port: reports.clone(),
            requester: Requester {
                name: "VS Code".into(),
                kind: ClientKind::Vscode,
                connection: None,
            },
        }),
    );

    files.exists("/p/x").await.unwrap();
    files.make_directory("/p/d").await.unwrap();

    let events = reports.0.lock().unwrap().clone();
    assert_eq!(events.len(), 2, "{events:?}");
    let ActivityEvent::WriteStarted(started) = &events[0] else {
        panic!("{events:?}")
    };
    assert_eq!(started.requester.name, "VS Code");
    assert!(started.what.contains("/p/d"), "{}", started.what);
    assert!(matches!(&events[1], ActivityEvent::WriteEnded(ended) if ended == started));
}
