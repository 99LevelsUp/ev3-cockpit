//! The channel and the lock at the level a client's probe meets them.

mod common;

use std::time::{Duration, Instant};

use common::TempRoot;
use ev3_cockpitd::channel::{BindError, Listener};
use ev3_cockpitd::lock::{self, LockError};

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_pipe_name_someone_else_created_is_refused() {
    let name = format!(
        r"\\.\pipe\ev3-cockpit-{}",
        ev3_cockpitd::hex(&ev3_cockpitd::random_bytes::<8>())
    );
    let _foreign = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(&name)
        .expect("someone else's pipe");
    match Listener::bind(&name) {
        Err(BindError::Refused(message)) => {
            assert!(
                message.contains("already created by another process"),
                "{message}"
            );
        }
        Err(other) => panic!("refused for the wrong reason: {other}"),
        Ok(_) => panic!("the daemon served on a name someone else holds"),
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_socket_name_someone_else_created_is_refused() {
    let root = TempRoot::new("sock");
    let dir = root.path().join("run");
    std::fs::create_dir(&dir).expect("dir");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    }
    let path = dir.join("daemon-0011223344.sock");
    let _foreign = std::os::unix::net::UnixListener::bind(&path).expect("someone else's socket");
    match Listener::bind(path.to_str().expect("utf-8")) {
        Err(BindError::Refused(message)) => {
            assert!(message.contains("already exists"), "{message}")
        }
        Err(other) => panic!("refused for the wrong reason: {other}"),
        Ok(_) => panic!("the daemon served on a name someone else holds"),
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn every_pipe_instance_is_the_daemons_and_one_always_listens() {
    let name = format!(
        r"\\.\pipe\ev3-cockpit-{}",
        ev3_cockpitd::hex(&ev3_cockpitd::random_bytes::<8>())
    );
    let mut listener = Listener::bind(&name).expect("bind");
    let accept = tokio::spawn(async move {
        let first = listener.accept().await.expect("first");
        // The next instance was created before the first was handed out: someone creating the
        // same name now is refused, not served.
        let squat = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(listener.path());
        (first, squat.is_err())
    });
    let _client = common::open(&name).await.expect("connect");
    let (_first, squat_refused) = accept.await.expect("accept");
    assert!(squat_refused);
}

/// Windows: while the daemon holds the lock, a client's open for writing fails with a sharing
/// violation, which is how the client knows the daemon lives.
#[cfg(windows)]
#[test]
fn a_held_lock_refuses_a_clients_open_and_a_free_one_allows_it() {
    let root = TempRoot::new("share");
    let path = root.path().join("daemon.lock");
    let held = lock::acquire(&path).expect("take");
    let probe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path);
    assert_eq!(
        probe.expect_err("the daemon holds it").raw_os_error(),
        Some(32),
        "ERROR_SHARING_VIOLATION"
    );
    drop(held);
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .expect("free once the daemon is gone");
}

/// Windows: a client's probe holds the file for a moment; the daemon waits it out instead of
/// reporting another daemon.
#[cfg(windows)]
#[test]
fn a_brief_client_probe_does_not_keep_the_daemon_from_the_lock() {
    let root = TempRoot::new("probe");
    let path = root.path().join("daemon.lock");
    std::fs::write(&path, b"").expect("lock file");
    let probe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .expect("probe");
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        drop(probe);
    });
    let started = Instant::now();
    let held = lock::acquire(&path).expect("taken once the probe let go");
    assert!(started.elapsed() >= Duration::from_millis(250));
    release.join().expect("probe thread");
    drop(held);
}

#[test]
fn a_probe_that_never_lets_go_reads_as_another_daemon() {
    let root = TempRoot::new("stuck");
    let path = root.path().join("daemon.lock");
    let _first = lock::acquire(&path).expect("first");
    let started = Instant::now();
    assert!(matches!(lock::acquire(&path), Err(LockError::Held)));
    if cfg!(windows) {
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "retried about a second"
        );
    }
}
