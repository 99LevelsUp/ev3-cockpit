//! The key under concurrent creation, and confinement through links and junctions.

mod common;

use std::path::Path;
use std::sync::{Arc, Barrier};

use common::TempRoot;
use ev3_cockpitd::confine::Confinement;
use ev3_cockpitd::key::{KEY_BYTES, ensure_key};
use ev3_contract::ErrorCode;

#[test]
fn many_starters_at_once_end_with_one_key_and_no_temporary_files() {
    if common::refuses_this_process() {
        return;
    }
    let root = TempRoot::new("keyrace");
    let file = root.path().join("native").join("key");
    let barrier = Arc::new(Barrier::new(8));
    let keys: Vec<Vec<u8>> = (0..8)
        .map(|_| {
            let (file, barrier) = (file.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                ensure_key(&file).expect("a key")
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|t| t.join().expect("thread"))
        .collect();
    assert!(keys.iter().all(|k| k.len() == KEY_BYTES && *k == keys[0]));
    assert_eq!(std::fs::read(&file).expect("file"), keys[0]);
    let names: Vec<_> = std::fs::read_dir(file.parent().expect("dir"))
        .expect("list")
        .map(|e| e.expect("entry").file_name())
        .collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

#[test]
fn an_existing_key_is_never_replaced() {
    if common::refuses_this_process() {
        return;
    }
    let root = TempRoot::new("keykeep");
    let file = root.path().join("key");
    std::fs::write(&file, [9u8; KEY_BYTES]).expect("key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    }
    assert_eq!(ensure_key(&file).expect("read"), vec![9u8; KEY_BYTES]);
    std::fs::write(&file, [9u8; 5]).expect("damage");
    let error = ensure_key(&file).expect_err("damaged");
    assert!(error.0.contains("5 bytes"), "{}", error.0);
    assert!(!error.0.to_lowercase().contains("delete"), "{}", error.0);
    assert_eq!(std::fs::read(&file).expect("kept"), vec![9u8; 5]);
}

/// A junction on Windows (no privilege needed), a symbolic link elsewhere.
fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .expect("mklink");
        assert!(status.success(), "mklink /J failed");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("symlink");
}

/// One of the directories the daemon keeps client paths out of cannot be resolved (the user's own
/// state root runs through a link whose target is missing): the daemon does not start, rather
/// than serve with that directory unprotected.
#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
#[test]
fn a_protected_directory_that_cannot_be_resolved_stops_the_start() {
    if common::refuses_this_process() {
        return;
    }
    let root = TempRoot::new("unresolved");
    let platform = root.path().join("platform");
    std::fs::create_dir_all(&platform).expect("platform");
    link_dir(&root.path().join("nowhere"), &platform.join("ev3-cockpit"));
    let variable = if cfg!(windows) {
        "LOCALAPPDATA"
    } else {
        "XDG_STATE_HOME"
    };
    let state = root.path().join("state");
    let mut child = common::spawn_binary(
        common::bin(),
        &state,
        "t",
        &[],
        &[(variable, platform.to_str().expect("text"))],
    );
    // Generous: before it gets this far the daemon hashes its own executable, which is slow for
    // a test binary run from another system's disk.
    let status = common::wait_exit(&mut child, std::time::Duration::from_secs(30));
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let status = status.expect("the daemon ends instead of serving");
    let stderr = common::stderr_of(&mut child);
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("cannot resolve"), "{stderr}");
    assert!(
        !state
            .join("channels")
            .join("t")
            .join("channel.json")
            .exists()
    );
}

/// The user's state root cannot be found at all (none of the variables that name it is set): on
/// a test channel too the daemon does not start, rather than leave that root unprotected.
#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
#[test]
fn a_user_state_root_that_cannot_be_found_stops_the_start() {
    if common::refuses_this_process() {
        return;
    }
    let root = TempRoot::new("noroot");
    let unset: &[&str] = if cfg!(windows) {
        &["LOCALAPPDATA", "USERPROFILE"]
    } else {
        &["XDG_STATE_HOME", "HOME"]
    };
    let mut command = std::process::Command::new(common::bin());
    command
        .args(["--channel", "t", "--state-root"])
        .arg(root.path().join("state"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    for name in unset {
        command.env_remove(name);
    }
    let mut child = command.spawn().expect("the daemon starts");
    let status = common::wait_exit(&mut child, std::time::Duration::from_secs(30));
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let status = status.expect("the daemon ends instead of serving");
    let stderr = common::stderr_of(&mut child);
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(
        stderr.contains("cannot find the user's state root"),
        "{stderr}"
    );
}

#[test]
fn a_path_through_a_junction_or_link_into_the_state_root_is_refused() {
    if common::refuses_this_process() {
        return;
    }
    let root = TempRoot::new("junction");
    let state = root.path().join("state");
    let elsewhere = root.path().join("projects");
    std::fs::create_dir_all(&state).expect("state");
    std::fs::create_dir_all(&elsewhere).expect("projects");
    std::fs::write(state.join("key"), b"secret").expect("key");
    let door = elsewhere.join("door");
    link_dir(&state, &door);

    let confinement = Confinement::new([state.clone()]).expect("roots");
    for named in [door.join("key"), door.join("settings.json"), door.clone()] {
        let error = confinement.check(&named).expect_err("refused");
        assert_eq!(
            error.data.code,
            ErrorCode::AccessDenied,
            "{}",
            named.display()
        );
    }
    assert!(confinement.check(&elsewhere.join("prog.rbf")).is_ok());
}

#[cfg(unix)]
#[test]
fn a_file_link_or_a_dangling_link_into_the_state_root_is_refused() {
    if common::refuses_this_process() {
        return;
    }
    let root = TempRoot::new("filelink");
    let state = root.path().join("state");
    std::fs::create_dir_all(&state).expect("state");
    std::fs::write(state.join("key"), b"secret").expect("key");
    let out = root.path().join("out");
    std::fs::create_dir_all(&out).expect("out");
    std::os::unix::fs::symlink(state.join("key"), out.join("k")).expect("link");
    std::os::unix::fs::symlink(state.join("new"), out.join("dangling")).expect("dangling");
    let confinement = Confinement::new([state]).expect("roots");
    assert_eq!(
        confinement
            .check(&out.join("k"))
            .expect_err("file link")
            .data
            .code,
        ErrorCode::AccessDenied
    );
    assert!(confinement.check(&out.join("dangling")).is_err());
}
