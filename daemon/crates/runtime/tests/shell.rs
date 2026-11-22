//! Shell commands on the brick, over a fake brick that records each one and answers status 0.

mod support_programs;

use std::sync::Arc;

use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::fs::WriteReporter;
use ev3_runtime::shell::{ShellError, run_shell};
use support_programs::*;

const CHMOD: &str = "chmod +x /home/root/lms2012/prjs/Demo/prog";

#[tokio::test]
async fn runs_a_shell_command_and_answers_its_status() {
    let brick = FakeBrick::new();

    let status = run_shell(brick.as_ref(), CHMOD, None).await;

    assert_eq!(status, Ok(0));
    assert_eq!(brick.state().shell, [CHMOD]);
}

#[tokio::test]
async fn reports_the_command_as_a_write_in_the_name_of_who_ran_it() {
    let brick = FakeBrick::new();
    let reports = Arc::new(Reports::default());
    let writes = WriteReporter {
        port: reports.clone(),
        requester: person("ev3-c"),
    };

    run_shell(brick.as_ref(), CHMOD, Some(&writes))
        .await
        .unwrap();

    assert_eq!(
        reports.seen(),
        [
            format!("started Running {CHMOD} for ev3-c"),
            format!("ended Running {CHMOD} for ev3-c"),
        ]
    );
}

#[tokio::test]
async fn fails_with_the_links_error_when_the_reply_is_lost_and_does_not_run_it_again() {
    let brick = FakeBrick::new();
    brick.lose(|command| matches!(command, BrickCommand::SystemRun { .. }));

    let error = run_shell(brick.as_ref(), CHMOD, None).await.unwrap_err();

    assert_eq!(error, ShellError::Command(reply_lost("system:run")));
    assert_eq!(brick.state().shell.len(), 1, "the command ran again");
}

#[tokio::test]
async fn fails_on_a_reply_of_another_kind() {
    let brick = FakeBrick::new();
    brick.answer_with(|command| {
        matches!(command, BrickCommand::SystemRun { .. }).then_some(Ok(BrickResponse::ProgramStop))
    });

    let error = run_shell(brick.as_ref(), CHMOD, None).await.unwrap_err();

    assert!(matches!(error, ShellError::Protocol(_)), "{error:?}");
    assert_eq!(error.code(), Some(ev3_contract::ErrorCode::ProtocolFailed));
}
