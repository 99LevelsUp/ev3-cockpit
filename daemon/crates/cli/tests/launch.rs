//! `ev3` started with its output captured by a pipe, as a shell or an agent's tool runs it, ends as
//! soon as its command does, even when it started the daemon: the daemon must not hold the pipe.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

mod common;

fn sha256(file: &Path) -> String {
    use sha2::Digest as _;
    let bytes = std::fs::read(file).expect("daemon binary");
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn a_piped_ev3_that_started_the_daemon_ends_with_its_command() {
    let ev3 = common::ev3();
    let Some(daemon) = common::daemon_beside_ev3() else {
        eprintln!("skipped: build ev3-cockpitd first (npm run daemon:build)");
        return;
    };
    // The manifest the development build reads, written for the daemon as it is now.
    let manifest = serde_json::json!({
        "binary": daemon.file_name().expect("name").to_string_lossy(),
        "sha256": sha256(&daemon),
        "version": env!("EV3_COCKPIT_VERSION"),
        "buildKind": "development",
    });
    std::fs::write(
        daemon.with_file_name("ev3-cockpitd.manifest.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("json")
        ),
    )
    .expect("manifest");

    let home = std::env::temp_dir().join(format!("ev3-launch-test-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("home");
    let started = Instant::now();
    let mut child = Command::new(&ev3)
        .args(["--json", "status"])
        .env("EV3_COCKPIT_CHANNEL", "launchtest")
        .env("LOCALAPPDATA", &home)
        .env("XDG_STATE_HOME", &home)
        .env_remove("XDG_RUNTIME_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("ev3 starts");
    // Reading to the end waits for every writer of the pipe, the daemon too if it inherited it.
    let mut out = String::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_string(&mut out)
        .expect("read");
    let status = child.wait().expect("ev3 ends");
    let took = started.elapsed();
    let status_json: serde_json::Value = serde_json::from_str(&out).expect("a status object");
    assert!(status_json["pid"].as_u64().is_some(), "{out}");

    // The daemon ends by itself 10 s after its last client; reading must not have waited for it.
    assert!(status.success(), "{out}");
    assert!(
        took < Duration::from_secs(8),
        "ev3 held the pipe for {took:?}"
    );
    let end = Instant::now() + Duration::from_secs(20);
    while Instant::now() < end
        && home
            .join("ev3-cockpit/native/channels/launchtest/channel.json")
            .exists()
    {
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = std::fs::remove_dir_all(&home);
}
