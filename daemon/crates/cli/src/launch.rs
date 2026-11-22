//! Starting the daemon. A client never starts the binary it carries: it copies it into the user's
//! state root, checks the copy's SHA-256, and starts exactly that copy.
//!
//! - The copy goes to `bin/<sha256>/` under the state root, through a unique temporary file renamed
//!   into place. `bin/` and `bin/<sha256>/` must be the user's alone: on Linux a plain directory of
//!   the user's that nobody else can open, on Windows one whose access list lets in nobody but the
//!   user, SYSTEM and the Administrators. The directories this client creates get an owner-only
//!   access list.
//! - The copy is hashed, not the source. A copy that verifies is reused; one that does not is
//!   replaced. A binary whose copy does not match the SHA-256 its manifest recorded is refused.
//! - The installed file is never started, so it is never locked: an update and a rebuild work
//!   while a daemon runs. The copy starts detached, with the state root as its working directory.
//! - Clients remove the copies other than their own and the running daemon's, skipping locked ones
//!   and ones used in the last minutes, which another client may be about to start.
//! - On Windows a start that fails (a spawn error, or an exit with a code the daemon never uses) is
//!   read as Smart App Control when the code-integrity policy reports it on or in evaluation.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{CliError, Failure, Result};

/// The file beside the binary that records its SHA-256, version and build kind.
pub const DAEMON_MANIFEST: &str = "ev3-cockpitd.manifest.json";

/// The daemon executable's file name.
pub const DAEMON_BINARY: &str = if cfg!(windows) {
    "ev3-cockpitd.exe"
} else {
    "ev3-cockpitd"
};

/// A daemon binary a client may start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub binary: PathBuf,
    pub sha256: String,
    pub version: String,
    /// `release` or `development`.
    pub build_kind: String,
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The manifest in `dir` as a launch, the binary beside it; `hint` says how to get a good one.
pub fn manifest_launch(dir: &Path, hint: &str) -> Result<LaunchSpec> {
    let file = dir.join(DAEMON_MANIFEST);
    let text = std::fs::read_to_string(&file).map_err(|error| {
        let message = if error.kind() == io::ErrorKind::NotFound {
            format!(
                "The cockpit daemon's manifest {} is missing. {hint}",
                file.display()
            )
        } else {
            format!(
                "The cockpit daemon's manifest {} cannot be read ({error}). {hint}",
                file.display()
            )
        };
        CliError::start(Failure::MissingBinary, message)
    })?;
    let invalid = || {
        CliError::start(
            Failure::MissingBinary,
            format!(
                "The cockpit daemon's manifest {} is not valid. {hint}",
                file.display()
            ),
        )
    };
    let manifest: Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    let field = |key: &str| manifest.get(key).and_then(Value::as_str).unwrap_or("");
    let name = field("binary");
    // The binary is named by its file name alone: a manifest never points out of its directory.
    let plain_name = !name.is_empty()
        && name != "."
        && name != ".."
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name);
    let build_kind = field("buildKind");
    if !plain_name
        || !is_sha256(field("sha256"))
        || field("version").is_empty()
        || !matches!(build_kind, "release" | "development")
    {
        return Err(invalid());
    }
    let launch = LaunchSpec {
        binary: dir.join(name),
        sha256: field("sha256").to_owned(),
        version: field("version").to_owned(),
        build_kind: build_kind.to_owned(),
    };
    if !launch.binary.exists() {
        return Err(CliError::start(
            Failure::MissingBinary,
            format!(
                "The cockpit daemon {} is missing. {hint}",
                launch.binary.display()
            ),
        ));
    }
    Ok(launch)
}

/// The SHA-256 of a file, lowercase hex, or `None` when it is not there.
pub fn hash_file(file: &Path) -> io::Result<Option<String>> {
    let mut handle = match std::fs::File::open(file) {
        Ok(handle) => handle,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut hasher = Sha256::new();
    io::copy(&mut handle, &mut hasher)?;
    Ok(Some(ev3_channel::hex(&hasher.finalize())))
}

fn not_private(dir: &Path, why: &str) -> CliError {
    CliError::start(
        Failure::NotPrivate,
        format!(
            "The folder of the cockpit daemon's verified copies {} {why}; the daemon was not started from it.",
            dir.display()
        ),
    )
}

/// Refuses a copy directory anyone but the user could put a file in.
pub fn check_private_dir(dir: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(dir)
        .map_err(|error| not_private(dir, &format!("cannot be checked ({error})")))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(not_private(dir, "is not a plain folder"));
    }
    #[cfg(windows)]
    {
        let others = ev3_channel::fsutil::windows::others_with_access(dir)
            .map_err(|error| not_private(dir, &format!("cannot be checked ({error})")))?;
        if !others.is_empty() {
            return Err(not_private(
                dir,
                &format!("can be reached by others ({})", others.join(", ")),
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(not_private(dir, "belongs to another user"));
        }
        if meta.mode() & 0o077 != 0 {
            return Err(not_private(
                dir,
                &format!(
                    "can be opened by other users (mode {:o})",
                    meta.mode() & 0o777
                ),
            ));
        }
    }
    Ok(())
}

fn make_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        ev3_channel::fsutil::windows::create_private_dir(dir)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(dir)
    }
}

/// Makes `dir` as a private directory unless it exists, then checks it. A new directory is made
/// private under a temporary name and renamed into place, so another client never sees it half
/// done.
pub fn ensure_private_dir(dir: &Path) -> Result<()> {
    if !dir.exists() {
        let parent = dir.parent().unwrap_or(Path::new("."));
        let fresh = parent.join(format!(
            ".new-{}",
            ev3_channel::hex(&ev3_channel::random_bytes::<6>())
        ));
        if make_private_dir(&fresh).is_ok() {
            // Another client made it meanwhile: its directory is checked below like any other.
            let _ = std::fs::rename(&fresh, dir);
            let _ = std::fs::remove_dir_all(&fresh);
        }
    }
    check_private_dir(dir)
}

/// Windows refuses to replace a file that runs or is open without sharing.
fn replace_refused(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::AlreadyExists | io::ErrorKind::NotFound
    ) || matches!(error.raw_os_error(), Some(5 | 32 | 145))
}

/// The verified copy of `launch.binary` under `state_root`: reused when it hashes to
/// `launch.sha256`, else copied again. Refuses a binary whose copy does not match.
pub fn verified_copy(launch: &LaunchSpec, state_root: &Path) -> Result<PathBuf> {
    if !is_sha256(&launch.sha256) {
        return Err(CliError::start(
            Failure::ShaMismatch,
            format!(
                "The SHA-256 recorded for the cockpit daemon {} is not valid; it was not started.",
                launch.binary.display()
            ),
        ));
    }
    ev3_channel::fsutil::create_private_dir_all(state_root).map_err(|error| {
        CliError::start(
            Failure::Failed,
            format!(
                "The cockpit's state folder {} cannot be made ({error}).",
                state_root.display()
            ),
        )
    })?;
    let bin = state_root.join("bin");
    let dir = bin.join(&launch.sha256);
    let target = dir.join(DAEMON_BINARY);
    for _ in 0..3 {
        // In every round: another client's clean-up may have removed the folder meanwhile.
        ensure_private_dir(&bin)?;
        ensure_private_dir(&dir)?;
        if hash_file(&target).ok().flatten().as_deref() == Some(launch.sha256.as_str()) {
            mark_in_use(&dir);
            return Ok(target);
        }
        if !launch.binary.exists() {
            return Err(CliError::start(
                Failure::MissingBinary,
                format!("The cockpit daemon {} is missing.", launch.binary.display()),
            ));
        }
        let temp = dir.join(format!(
            ".{}.tmp",
            ev3_channel::hex(&ev3_channel::random_bytes::<8>())
        ));
        let placed = (|| -> Result<bool> {
            if let Err(error) = copy_new(&launch.binary, &temp) {
                if replace_refused(&error) {
                    return Ok(false);
                }
                return Err(CliError::Other(format!(
                    "The cockpit daemon could not be copied ({error})."
                )));
            }
            // Gone before it was hashed: removed by another client's clean-up. Copy again.
            let Some(copied) = hash_file(&temp).ok().flatten() else {
                return Ok(false);
            };
            if copied != launch.sha256 {
                let hint = if launch.build_kind == "development" {
                    "Rebuild it with npm run daemon:build, which writes its manifest again."
                } else {
                    "Reinstall EVƎ Cockpit."
                };
                return Err(CliError::start(
                    Failure::ShaMismatch,
                    format!(
                        "The cockpit daemon {} does not match the SHA-256 its package recorded: it is {copied}, the package says {}. It was not started. {hint}",
                        launch.binary.display(),
                        launch.sha256
                    ),
                ));
            }
            match std::fs::rename(&temp, &target) {
                Ok(()) => Ok(true),
                Err(error) if replace_refused(&error) => Ok(false),
                Err(error) => Err(CliError::Other(format!(
                    "The verified copy of the cockpit daemon could not be placed ({error})."
                ))),
            }
        })();
        let _ = std::fs::remove_file(&temp);
        placed?;
    }
    Err(CliError::start(
        Failure::Failed,
        format!(
            "The verified copy of the cockpit daemon could not be placed in {}.",
            dir.display()
        ),
    ))
}

/// Copies `from` to a new file `to`, executable by the user alone on Linux.
fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut source = std::fs::File::open(from)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    let mut target = options.open(to)?;
    io::copy(&mut source, &mut target)?;
    target.sync_all()
}

/// A copy folder touched this recently may be about to start: clean-up leaves it.
pub const RECENT_COPY: Duration = Duration::from_secs(10 * 60);

/// Marks a verified copy as just used, so no other client's clean-up removes it before it starts.
fn mark_in_use(dir: &Path) {
    let mut options = std::fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS opens a directory; FILE_WRITE_ATTRIBUTES sets its times.
        options.access_mode(0x0100).custom_flags(0x0200_0000);
    }
    #[cfg(unix)]
    {
        options.read(true);
    }
    if let Ok(handle) = options.open(dir) {
        let _ = handle.set_modified(SystemTime::now());
    }
}

/// Removes the verified copies other than `keep` (SHA-256 values). A locked one stays, and so does
/// one used in the last minutes.
pub fn remove_old_copies(state_root: &Path, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(state_root.join("bin")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_sha256(&name) || keep.contains(&name.as_str()) {
            continue;
        }
        let dir = entry.path();
        let recent = std::fs::metadata(&dir)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_none_or(|age| age < RECENT_COPY);
        if recent {
            continue;
        }
        // Locked: a daemon still runs from it. The next client tries again.
        let removed = std::fs::read_dir(&dir).map(|files| {
            files
                .flatten()
                .all(|file| std::fs::remove_file(file.path()).is_ok())
        });
        if removed.unwrap_or(false) {
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

/// Records the installed cockpit's daemon in `install.json`, so an add-on can start it.
pub fn record_install(channel_dir: &Path, launch: &LaunchSpec) {
    let file = channel_dir.join("install.json");
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "binary": launch.binary, "sha256": launch.sha256, "version": launch.version,
            "buildKind": launch.build_kind,
        }))
        .unwrap_or_default()
    );
    if std::fs::read_to_string(&file).ok().as_deref() == Some(text.as_str()) {
        return;
    }
    let _ = ev3_channel::fsutil::create_private_dir_all(channel_dir);
    let _ = ev3_channel::fsutil::write_atomic(&file, text.as_bytes());
}

/// A started daemon, which outlives this client.
pub struct Spawned {
    child: Option<Child>,
    error: Option<io::Error>,
}

/// How a started daemon ended before it answered.
#[derive(Debug)]
pub enum Ended {
    Exit(Option<i32>),
    Error(io::Error),
}

impl Spawned {
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    /// How the process ended, or `None` while it runs.
    pub fn outcome(&mut self) -> Option<Ended> {
        if let Some(error) = self.error.take() {
            return Some(Ended::Error(error));
        }
        let status: ExitStatus = self.child.as_mut()?.try_wait().ok()??;
        Some(Ended::Exit(status.code()))
    }
}

/// Starts the daemon detached, so it outlives this client and a Ctrl+C in its terminal.
pub fn spawn(binary: &Path, args: &[String], cwd: &Path) -> Spawned {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches nothing of the parent's.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    // Windows hands every inheritable handle to the child, `ev3`'s own standard handles too: the
    // daemon would hold the pipe a shell reads `ev3`'s output from, and the shell would wait for
    // the daemon to end. They stay out of the daemon; add-ons still inherit them afterwards.
    #[cfg(windows)]
    let _kept = windows_std::NotInherited::standard_handles();
    match command.spawn() {
        Ok(child) => Spawned {
            child: Some(child),
            error: None,
        },
        Err(error) => Spawned {
            child: None,
            error: Some(error),
        },
    }
}

#[cfg(windows)]
mod windows_std {
    use windows_sys::Win32::Foundation::{
        GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        SetHandleInformation,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    /// This process's standard handles made non-inheritable until dropped.
    pub struct NotInherited(Vec<HANDLE>);

    impl NotInherited {
        pub fn standard_handles() -> Self {
            let mut cleared = Vec::new();
            for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
                // SAFETY: plain queries and flag changes on this process's own handles.
                unsafe {
                    let handle = GetStdHandle(which);
                    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                        continue;
                    }
                    let mut flags = 0u32;
                    if GetHandleInformation(handle, &mut flags) != 0
                        && flags & HANDLE_FLAG_INHERIT != 0
                        && SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) != 0
                    {
                        cleared.push(handle);
                    }
                }
            }
            Self(cleared)
        }
    }

    impl Drop for NotInherited {
        fn drop(&mut self) {
            for &handle in &self.0 {
                // SAFETY: restores the flag this value cleared on a handle of this process.
                unsafe {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                }
            }
        }
    }
}

/// The Windows error a code-integrity policy raises when it blocks an executable.
const ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION: i32 = 4551;
const LOCK_HELD: i32 = 2;
const REFUSED: i32 = 3;
/// Every exit code the daemon documents; a process that exited with one of them ran.
#[cfg(windows)]
const DAEMON_EXIT_CODES: [i32; 5] = [0, 1, LOCK_HELD, REFUSED, 64];

/// Windows: `VerifiedAndReputablePolicyState` (0 off, 1 on, 2 evaluation), if readable.
#[cfg(windows)]
fn smart_app_control_policy() -> Option<u32> {
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let reg = Path::new(&system).join("System32").join("reg.exe");
    let out = Command::new(reg)
        .args([
            "query",
            r"HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy",
            "/v",
            "VerifiedAndReputablePolicyState",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let hex = text.split("0x").nth(1)?.split_whitespace().next()?;
    u32::from_str_radix(hex, 16).ok()
}

fn log_tail(file: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(file) else {
        return String::new();
    };
    let lines: Vec<&str> = text.trim_end().lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let start = lines.len().saturating_sub(12);
    format!(
        "\nIts log {} ends:\n{}",
        file.display(),
        lines[start..].join("\n")
    )
}

/// Why a started daemon ended before it answered.
pub fn classify(ended: &Ended, binary: &Path, log: &Path) -> CliError {
    let blocked = || {
        CliError::start(
            Failure::SmartAppControl,
            format!(
                "Windows Smart App Control blocked the EVƎ Cockpit daemon ({}). Smart App Control lets only signed or well-known apps run, and the cockpit's daemon is not signed yet, so the cockpit cannot run on this computer while Smart App Control is on.",
                binary.display()
            ),
        )
    };
    let violation = match ended {
        Ended::Exit(code) => *code == Some(ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION),
        Ended::Error(error) => {
            error.raw_os_error() == Some(ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION)
        }
    };
    if cfg!(windows) && violation {
        return blocked();
    }
    match ended {
        Ended::Exit(Some(LOCK_HELD)) => {
            return CliError::start(
                Failure::LockHeld,
                format!(
                    "Another cockpit daemon holds this channel's lock while it starts or ends; {} stopped.",
                    binary.display()
                ),
            );
        }
        Ended::Exit(Some(REFUSED)) => {
            return CliError::start(
                Failure::NameHeld,
                format!(
                    "The cockpit daemon refused to run: its pipe or socket name may be held by someone else, or it was started with administrator or root rights.{}",
                    log_tail(log)
                ),
            );
        }
        _ => {}
    }
    #[cfg(windows)]
    {
        let ran = matches!(ended, Ended::Exit(Some(code)) if DAEMON_EXIT_CODES.contains(code));
        if !ran && matches!(smart_app_control_policy(), Some(1 | 2)) {
            return blocked();
        }
    }
    let how = match ended {
        Ended::Error(error) => format!("it could not be started ({error})"),
        Ended::Exit(Some(code)) => format!("it exited with code {code}"),
        Ended::Exit(None) => "it ended on a signal".to_owned(),
    };
    CliError::start(
        Failure::Failed,
        format!(
            "The cockpit daemon could not start: {how}.{}",
            log_tail(log)
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ev3-launch-{}",
            ev3_channel::hex(&ev3_channel::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn manifest(dir: &Path, binary: &str, sha: &str) {
        std::fs::write(
            dir.join(DAEMON_MANIFEST),
            json!({ "binary": binary, "sha256": sha, "version": "1.2.3", "buildKind": "development" })
                .to_string(),
        )
        .expect("manifest");
    }

    #[test]
    fn a_manifest_never_points_out_of_its_directory() {
        let dir = temp_dir();
        std::fs::write(dir.join(DAEMON_BINARY), b"daemon").expect("binary");
        let sha = hash_file(&dir.join(DAEMON_BINARY))
            .expect("hash")
            .expect("there");
        manifest(&dir, DAEMON_BINARY, &sha);
        assert_eq!(manifest_launch(&dir, "h").expect("valid").sha256, sha);
        for bad in ["..", "../x", "sub/x", ""] {
            manifest(&dir, bad, &sha);
            let error = manifest_launch(&dir, "h").expect_err(bad);
            assert!(
                matches!(
                    error,
                    CliError::Start {
                        failure: Failure::MissingBinary,
                        ..
                    }
                ),
                "{bad}"
            );
        }
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_copy_is_started_only_when_it_matches_the_manifest() {
        let root = temp_dir();
        let source = root.join("source.bin");
        std::fs::write(&source, b"the daemon").expect("source");
        let sha = hash_file(&source).expect("hash").expect("there");
        let launch = LaunchSpec {
            binary: source.clone(),
            sha256: sha.clone(),
            version: "1".into(),
            build_kind: "development".into(),
        };
        let state = root.join("state");
        let copy = verified_copy(&launch, &state).expect("copied");
        assert_eq!(copy, state.join("bin").join(&sha).join(DAEMON_BINARY));
        assert_eq!(std::fs::read(&copy).expect("read"), b"the daemon");
        assert_eq!(verified_copy(&launch, &state).expect("reused"), copy);

        let wrong = LaunchSpec {
            sha256: "0".repeat(64),
            ..launch
        };
        let error = verified_copy(&wrong, &state).expect_err("mismatch");
        assert!(
            matches!(
                error,
                CliError::Start {
                    failure: Failure::ShaMismatch,
                    ..
                }
            ),
            "{error}"
        );
        std::fs::remove_dir_all(root).expect("clean");
    }

    #[test]
    fn the_daemons_own_exit_codes_say_it_ran() {
        let log = Path::new("no-such-log");
        let bin = Path::new("ev3-cockpitd");
        let failure = |ended| match classify(&ended, bin, log) {
            CliError::Start { failure, .. } => failure,
            other => panic!("{other:?}"),
        };
        assert_eq!(failure(Ended::Exit(Some(2))), Failure::LockHeld);
        assert_eq!(failure(Ended::Exit(Some(3))), Failure::NameHeld);
        assert_eq!(failure(Ended::Exit(Some(1))), Failure::Failed);
        if cfg!(windows) {
            assert_eq!(failure(Ended::Exit(Some(4551))), Failure::SmartAppControl);
            assert_eq!(
                failure(Ended::Error(io::Error::from_raw_os_error(4551))),
                Failure::SmartAppControl
            );
        }
    }

    #[test]
    fn old_copies_go_but_recent_and_kept_ones_stay() {
        let root = temp_dir();
        let bin = root.join("bin");
        let keep = "a".repeat(64);
        let recent = "b".repeat(64);
        for name in [&keep, &recent] {
            std::fs::create_dir_all(bin.join(name)).expect("dir");
            std::fs::write(bin.join(name).join(DAEMON_BINARY), b"x").expect("file");
        }
        remove_old_copies(&root, &[&keep]);
        assert!(bin.join(&keep).exists());
        assert!(bin.join(&recent).exists(), "used in the last minutes");
        std::fs::remove_dir_all(root).expect("clean");
    }
}
