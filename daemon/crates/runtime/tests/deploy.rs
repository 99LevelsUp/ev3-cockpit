//! Deploying files and starting a program as one operation, over a fake brick: it checks first
//! that nothing runs, then puts each file on the brick — leaving one whose MD5 already matches —
//! then starts the program and says how the start ended. A stop on the brick before the start ends
//! it, naming who stopped, and nothing starts; the caller's own cancel ends it and stops nothing.

mod support_programs;

use std::time::Duration;

use ev3_contract::{ErrorCode, StartOutcome};
use ev3_protocol::BrickCommand;
use ev3_runtime::deploy::{
    DeployFile, DeployReport, DeployRequest, DeployServices, MAX_INLINE_BYTES, deploy_and_run,
    same_on_brick,
};
use ev3_runtime::programs::{ProgramError, StartOptions};
use ev3_runtime::transfer::CancelFlag;
use support_programs::*;

const FOLDER: &str = "/home/root/lms2012/prjs/Demo";
const NOTES: &str = "/home/root/lms2012/prjs/Demo/notes.txt";
const SECOND: &str = "/home/root/lms2012/prjs/Demo/second.txt";

fn services(w: &World) -> DeployServices<'_> {
    DeployServices {
        programs: &w.programs,
        files: &w.files,
        transfer: &w.transfer,
    }
}

fn inline(path: &str, content: &[u8]) -> DeployFile {
    DeployFile {
        path: path.into(),
        content: content.to_vec(),
        inline: true,
        skip_if_same: false,
    }
}

fn request(files: Vec<DeployFile>) -> DeployRequest {
    DeployRequest {
        files,
        program: PRG.into(),
        ..DeployRequest::default()
    }
}

#[tokio::test]
async fn fails_with_program_running_and_puts_nothing_on_the_brick_when_a_program_runs_already() {
    let w = world();
    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();

    let error = deploy_and_run(
        services(&w),
        &vscode(),
        request(vec![inline(NOTES, b"hello")]),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code(), Some(ErrorCode::ProgramRunning));
    assert_eq!(error, ProgramError::Running { deploying: true });
    assert_eq!(
        w.brick.count("fs:beginWrite"),
        0,
        "a file went to the brick"
    );
    assert_eq!(w.brick.file(NOTES), None);
}

#[tokio::test]
async fn uploads_a_file_whose_md5_on_the_brick_differs_and_starts_the_program() {
    let w = world();
    w.brick
        .state()
        .files
        .insert(NOTES.into(), b"old notes".to_vec());
    w.brick.state().md5s.insert(NOTES.into(), IMAGE_MD5.into());
    let notes = DeployFile {
        path: NOTES.into(),
        content: b"from disk".to_vec(),
        inline: false,
        skip_if_same: true,
    };

    let report = deploy_and_run(services(&w), &vscode(), request(vec![notes])).await;

    assert_eq!(
        report,
        Ok(DeployReport {
            outcome: StartOutcome::Started,
            uploaded: vec![NOTES.into()],
            skipped: vec![],
        })
    );
    assert_eq!(w.brick.file(NOTES).as_deref(), Some(&b"from disk"[..]));
    assert_eq!(w.programs.is_running().await, Ok(true));
}

#[tokio::test]
async fn leaves_a_file_whose_md5_matches_uploads_one_that_changed_and_still_starts_the_program() {
    let w = world();
    w.brick.state().md5s.insert(PRG.into(), IMAGE_MD5.into());
    let files = vec![
        DeployFile {
            path: PRG.into(),
            content: IMAGE.to_vec(),
            inline: true,
            skip_if_same: true,
        },
        DeployFile {
            path: NOTES.into(),
            content: b"from disk".to_vec(),
            inline: false,
            skip_if_same: true,
        },
    ];

    let report = deploy_and_run(services(&w), &vscode(), request(files)).await;

    assert_eq!(
        report,
        Ok(DeployReport {
            outcome: StartOutcome::Started,
            uploaded: vec![NOTES.into()],
            skipped: vec![PRG.into()],
        })
    );
    assert_eq!(
        w.brick.count("fs:beginWrite"),
        1,
        "the unchanged file was uploaded too"
    );
    assert_eq!(w.programs.is_running().await, Ok(true));
}

async fn stopped_during_the_upload(emergency: bool) {
    let w = world();
    // The first file's upload is on its way when the brick is stopped.
    w.brick.hold("fs:beginWrite");
    let me = vscode();
    let files = vec![inline(NOTES, b"first"), inline(SECOND, b"second")];
    let deploying = deploy_and_run(services(&w), &me, request(files));
    let stopper = async {
        w.brick
            .until(|s| s.arrived.iter().any(|k| k == "fs:beginWrite"))
            .await;
        if emergency {
            w.programs.emergency_stop(&vscode()).await.unwrap();
        } else {
            w.programs.stop(&vscode()).await.unwrap();
        }
        w.brick.release();
    };

    let (result, ()) = tokio::join!(deploying, stopper);

    let error = result.unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Cancelled));
    assert_eq!(error.stopped_by(), Some("VS Code"));
    assert!(error.to_string().contains("VS Code"), "{error}");
    assert_eq!(
        w.brick.count("program:run"),
        0,
        "a start went out after the stop"
    );
    assert_eq!(
        w.brick.count("fs:beginWrite"),
        1,
        "the upload went on after the stop"
    );
    assert_eq!(w.programs.is_running().await, Ok(false));
}

#[tokio::test]
async fn ends_with_cancelled_naming_who_stopped_when_a_stop_comes_during_the_upload() {
    stopped_during_the_upload(false).await;
}

#[tokio::test]
async fn ends_with_cancelled_naming_who_stopped_when_an_emergency_stop_comes_during_the_upload() {
    stopped_during_the_upload(true).await;
}

#[tokio::test]
async fn starts_nothing_when_a_stop_comes_during_the_last_upload() {
    let w = world();
    w.brick.hold("fs:beginWrite");
    let me = vscode();
    let deploying = deploy_and_run(services(&w), &me, request(vec![inline(NOTES, b"only")]));
    let stopper = async {
        w.brick
            .until(|s| s.arrived.iter().any(|k| k == "fs:beginWrite"))
            .await;
        w.programs.stop(&person("ev3")).await.unwrap();
        w.brick.release();
    };

    let (result, ()) = tokio::join!(deploying, stopper);

    assert_eq!(result.unwrap_err().stopped_by(), Some("ev3"));
    assert_eq!(
        w.brick.count("program:run"),
        0,
        "a start went out after the stop"
    );
    assert!(
        !w.reports
            .seen()
            .iter()
            .any(|seen| seen.contains("Starting")),
        "a start the stop cancelled was reported as a write: {:?}",
        w.reports.seen()
    );
}

#[tokio::test]
async fn ends_with_cancelled_when_its_caller_cancels_during_the_upload_and_stops_nothing() {
    let w = world();
    let cancel = CancelFlag::new();
    w.brick.hold("fs:beginWrite");
    let mut deploy = request(vec![inline(NOTES, b"first"), inline(SECOND, b"second")]);
    deploy.cancel = Some(cancel.clone());
    let canceller = async {
        w.brick
            .until(|s| s.arrived.iter().any(|k| k == "fs:beginWrite"))
            .await;
        cancel.cancel();
        w.brick.release();
    };

    let me = vscode();
    let (result, ()) = tokio::join!(deploy_and_run(services(&w), &me, deploy), canceller);

    assert_eq!(result, Err(ProgramError::Cancelled));
    assert_eq!(w.brick.count("fs:beginWrite"), 1);
    assert_eq!(w.brick.count("program:run"), 0);
    assert_eq!(
        w.brick.count("program:stop"),
        0,
        "a cancel stopped the brick"
    );
    assert_eq!(w.programs.last_stopper(), None);
}

#[tokio::test]
async fn reports_a_start_whose_reply_was_lost_as_uncertain_and_does_not_start_it_again() {
    let w = world();
    w.brick
        .lose(|command| matches!(command, BrickCommand::ProgramRun { .. }));

    let report = deploy_and_run(services(&w), &vscode(), request(vec![]))
        .await
        .unwrap();

    assert_eq!(report.outcome, StartOutcome::Uncertain);
    assert_eq!(w.brick.count("program:run"), 1, "the start was sent again");
}

#[tokio::test]
async fn refuses_inline_content_over_its_limit_before_anything_reaches_the_brick() {
    let w = world();

    let error = deploy_and_run(
        services(&w),
        &vscode(),
        request(vec![inline(NOTES, &vec![0; MAX_INLINE_BYTES + 1])]),
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("4096"), "{error}");
    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert!(
        w.brick.log().is_empty(),
        "something was sent: {:?}",
        w.brick.log()
    );
}

#[tokio::test]
async fn takes_a_large_file_that_did_not_come_inline() {
    let w = world();
    let big = vec![7; MAX_INLINE_BYTES + 1];
    let file = DeployFile {
        path: NOTES.into(),
        content: big.clone(),
        inline: false,
        skip_if_same: false,
    };

    let report = deploy_and_run(services(&w), &vscode(), request(vec![file]))
        .await
        .unwrap();

    assert_eq!(report.uploaded, [NOTES]);
    assert_eq!(w.brick.file(NOTES), Some(big));
}

#[tokio::test]
async fn refuses_a_path_the_brick_would_cut_before_anything_reaches_the_brick() {
    let w = world();
    let long = format!("{FOLDER}/{}", "n".repeat(40));

    let error = deploy_and_run(services(&w), &vscode(), request(vec![inline(&long, b"x")]))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert!(w.brick.log().is_empty());
}

#[tokio::test]
async fn waits_out_a_lost_route_until_its_deadline_and_reports_the_uploads_and_the_start() {
    let w = world();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut deploy = request(vec![inline(NOTES, b"hello")]);
    deploy.deadline = Some(deadline);

    deploy_and_run(services(&w), &vscode(), deploy)
        .await
        .unwrap();

    assert_eq!(w.brick.state().route_waits, [deadline]);
    assert_eq!(
        w.reports.seen(),
        [
            format!("started Writing {NOTES} for VS Code"),
            format!("ended Writing {NOTES} for VS Code"),
            format!("started Starting {PRG} for VS Code"),
            format!("ended Starting {PRG} for VS Code"),
        ]
    );
}

// ── Whether the brick holds the same file ───────────────────────────

#[tokio::test]
async fn finds_the_same_file_by_the_md5_and_size_the_listing_gives() {
    let w = world();
    w.brick.state().md5s.insert(PRG.into(), IMAGE_MD5.into());

    assert_eq!(
        same_on_brick(&w.files, PRG, IMAGE.len(), IMAGE_MD5).await,
        Ok(true)
    );
    assert_eq!(
        same_on_brick(&w.files, PRG, IMAGE.len(), &IMAGE_MD5.to_uppercase()).await,
        Ok(true),
        "hex case"
    );
    assert_eq!(
        same_on_brick(&w.files, PRG, IMAGE.len(), FROM_DISK_MD5).await,
        Ok(false),
        "another digest"
    );
    assert_eq!(
        same_on_brick(&w.files, PRG, IMAGE.len() + 1, IMAGE_MD5).await,
        Ok(false),
        "another size"
    );
}

#[tokio::test]
async fn finds_nothing_to_match_for_a_file_the_listing_lacks_or_lists_without_an_md5() {
    let w = world();

    assert_eq!(
        same_on_brick(&w.files, PRG, IMAGE.len(), IMAGE_MD5).await,
        Ok(false),
        "no md5"
    );
    assert_eq!(
        same_on_brick(&w.files, NOTES, 5, IMAGE_MD5).await,
        Ok(false),
        "no such file"
    );
    assert_eq!(
        same_on_brick(&w.files, "/home/root/lms2012/prjs/None/x.rbf", 5, IMAGE_MD5).await,
        Ok(false),
        "no such folder"
    );
}

#[tokio::test]
async fn leaves_a_link_failure_of_the_listing_to_the_caller() {
    let w = world();
    w.brick
        .refuse(|command| matches!(command, BrickCommand::FsList { .. }));

    let error = same_on_brick(&w.files, PRG, IMAGE.len(), IMAGE_MD5)
        .await
        .unwrap_err();

    assert!(!error.is_protocol(), "{error}");
}
