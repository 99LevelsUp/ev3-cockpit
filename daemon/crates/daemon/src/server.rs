//! The daemon's life: refuse what must not run, take the lock, read or create the key, open the
//! channel, record it, serve clients, and end cleanly.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ev3_transports::ProviderSource;

use crate::channel::{BindError, Listener};
use crate::cli::Options;
use crate::confine::Confinement;
use crate::exit_code;
use crate::log::Log;
use crate::methods::Daemon;
use crate::paths::{Paths, default_state_root};
use crate::questions::Questions;
use crate::settings::SettingsStore;
use crate::state::{ExitReason, Identity, Shared};
use crate::surface::Surface;
use crate::surface::runtime::{Bluetooth, ProviderEnd, Providers, RecordPlan};

/// How long the daemon stays after the last client left while nothing is held.
pub const IDLE_EXIT: Duration = Duration::from_secs(10);
/// How often the daemon checks that its `channel.json` is still there.
const RECORD_CHECK: Duration = Duration::from_secs(2);
/// How long releasing the bricks and devices may take at the end.
const RELEASE_LIMIT: Duration = Duration::from_secs(10);

fn refuse(code: i32, message: &str) -> i32 {
    eprintln!("ev3-cockpitd: {message}");
    code
}

/// Runs the daemon to its end and returns the process exit code.
pub fn run(options: &Options) -> i32 {
    match security_refusal() {
        Ok(None) => {}
        Ok(Some(message)) => return refuse(exit_code::REFUSED, message),
        Err(error) => {
            return refuse(
                exit_code::FAILED,
                &format!("The daemon could not check its own privileges ({error})."),
            );
        }
    }

    let root = match &options.state_root {
        Some(root) => root.clone(),
        None => match default_state_root() {
            Ok(root) => root,
            Err(message) => return refuse(exit_code::FAILED, &message),
        },
    };
    let paths = Paths::new(&root, options.channel.as_deref());
    let source = match options.provider_source() {
        Ok(source) => source,
        Err(message) => return refuse(exit_code::REFUSED, &message),
    };

    // The lock comes before anything else the daemon touches.
    if let Err(error) = crate::fsutil::create_private_dir_all(&paths.dir) {
        return refuse(
            exit_code::FAILED,
            &format!(
                "The directory {} could not be made ({error}).",
                paths.dir.display()
            ),
        );
    }
    let lock = match crate::lock::acquire(&paths.lock) {
        Ok(lock) => lock,
        Err(crate::lock::LockError::Held) => {
            return refuse(
                exit_code::LOCK_HELD,
                &format!(
                    "Another cockpit daemon already runs on this channel ({}).",
                    paths.lock.display()
                ),
            );
        }
        Err(error) => return refuse(exit_code::FAILED, &error.to_string()),
    };

    let key = match crate::key::ensure_key(&paths.key) {
        Ok(key) => key,
        Err(error) => return refuse(exit_code::FAILED, &error.0),
    };
    let record = match (source, &options.record_dir) {
        (ProviderSource::Hardware { record: true }, Some(dir)) => {
            if let Err(error) = create_record_dir(dir) {
                return refuse(
                    exit_code::REFUSED,
                    &format!(
                        "The recording directory {} cannot be used: {error}. Name a directory that does not exist yet; the daemon creates it for the user alone.",
                        dir.display()
                    ),
                );
            }
            Some(RecordPlan {
                dir: dir.clone(),
                transports: options.record_transports.clone(),
            })
        }
        _ => None,
    };
    let log = Log::open(&paths.log);
    // Before the settings and the ledger are read: the user's channel takes over what the Node
    // daemon left. A test channel takes over nothing.
    if let Some(old_root) = crate::migrate::old_root(&paths.root) {
        crate::migrate::migrate(&old_root, &paths, &log);
    }
    let settings = SettingsStore::load(&paths.settings, |warning| log.warn(&warning));
    let exe = std::env::current_exe().ok();
    let build_id = match exe.as_deref().map(crate::build_info::file_sha256) {
        Some(Ok(id)) => id,
        _ => {
            return refuse(
                exit_code::FAILED,
                "The daemon could not read its own executable.",
            );
        }
    };

    let nonce = crate::random_bytes::<16>();
    let hash = crate::channel::name_hash(&key, options.channel.as_deref(), &nonce);
    #[cfg(windows)]
    let channel_path = crate::channel::pipe_path(&hash);
    #[cfg(unix)]
    let channel_path = match crate::channel::socket_path(&paths.socket_dir, &hash).to_str() {
        Some(path) => path.to_string(),
        None => {
            return refuse(
                exit_code::REFUSED,
                "The socket directory is not valid text.",
            );
        }
    };

    // The directories no client path may reach. One that cannot be found or resolved stops the
    // start: serving with it unprotected would be a narrower protection nobody asked for.
    let mut roots = vec![paths.root.clone()];
    match default_state_root() {
        Ok(default) if default != paths.root => roots.push(default),
        Ok(_) => {}
        Err(message) => {
            let message = format!(
                "The daemon does not start: it cannot find the user's state root to keep client paths out of it ({message})."
            );
            log.error(&message);
            return refuse(exit_code::FAILED, &message);
        }
    }
    if let Some(dir) = exe.as_deref().and_then(Path::parent) {
        roots.push(dir.to_path_buf());
    }
    #[cfg(unix)]
    roots.push(paths.socket_dir.clone());
    let confinement = match Confinement::new(roots) {
        Ok(confinement) => confinement,
        Err(error) => {
            let message = format!("{} The daemon does not start.", error.0);
            log.error(&message);
            return refuse(exit_code::FAILED, &message);
        }
    };

    let identity = Identity {
        version: crate::build_info::VERSION.to_string(),
        build_kind: options.build_kind(),
        build_id,
        mode: if source.opens_hardware() {
            ev3_contract::DaemonMode::Hardware
        } else {
            ev3_contract::DaemonMode::Replay
        },
        pid: std::process::id(),
        instance_id: crate::hex(&crate::random_bytes::<16>()),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        channel_path: channel_path.clone(),
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            return refuse(
                exit_code::FAILED,
                &format!("The daemon could not start its runtime ({error})."),
            );
        }
    };
    let code = runtime.block_on(async move {
        let listener = match Listener::bind(&channel_path) {
            Ok(listener) => listener,
            Err(BindError::Refused(message)) => {
                log.error(&message);
                return refuse(exit_code::REFUSED, &message);
            }
            Err(error) => {
                let message = error.to_string();
                log.error(&message);
                return refuse(exit_code::FAILED, &message);
            }
        };
        let shared = Arc::new(Shared::new(
            identity,
            key,
            paths.key.clone(),
            log,
            settings,
            confinement,
        ));
        let questions = Arc::new(Questions::default());
        let (providers, end) = match Providers::for_source(
            source,
            options.fixtures.as_deref(),
            options.strict_replay,
            record.as_ref(),
            || Bluetooth::system(&shared, &questions),
        )
        .await
        {
            Ok(providers) => providers,
            Err(message) => {
                shared.log.error(&message);
                return refuse(exit_code::REFUSED, &message);
            }
        };
        shared.set_transports(
            providers
                .list
                .iter()
                .map(|provider| provider.transport().as_str().to_owned())
                .collect(),
        );
        let held = crate::holders::read_held(&paths.held, |warning| shared.log.warn(&warning));
        let surface = match Surface::start(shared.clone(), questions, providers, &paths.dir, held) {
            Ok(surface) => surface,
            Err(message) => {
                shared.log.error(&message);
                return refuse(exit_code::FAILED, &message);
            }
        };
        serve(listener, shared, surface, &paths, end).await
    });
    drop(lock);
    code
}

fn security_refusal() -> std::io::Result<Option<&'static str>> {
    Ok(crate::security::privilege_refusal(
        crate::security::is_elevated()?,
    ))
}

/// Checks the recording or the strict replay once the providers are let go: a line for the log
/// when all is well, the reason and a failed exit otherwise.
fn finish_providers(end: &ProviderEnd, shared: &Shared, code: i32) -> i32 {
    match end.finish() {
        Ok(Some(line)) => {
            shared.log.info(&line);
            code
        }
        Ok(None) => code,
        Err(message) => {
            shared.log.error(&message);
            eprintln!("ev3-cockpitd: {message}");
            exit_code::FAILED
        }
    }
}

async fn serve(
    mut listener: Listener,
    shared: Arc<Shared>,
    surface: Arc<Surface>,
    paths: &Paths,
    end: ProviderEnd,
) -> i32 {
    let record = crate::channel::record_text(listener.path(), shared.identity.pid);
    if let Err(error) = crate::fsutil::write_atomic(&paths.record, record.as_bytes()) {
        let message = format!(
            "The channel record {} could not be written ({error}).",
            paths.record.display()
        );
        shared.log.error(&message);
        surface.shutdown().await;
        finish_providers(&end, &shared, exit_code::FAILED);
        return refuse(exit_code::FAILED, &message);
    }
    shared.log.info(&format!(
        "Serving on {} (pid {}, {} {}, {}).",
        listener.path(),
        shared.identity.pid,
        shared.identity.version,
        shared.identity.build_kind,
        shared.identity.mode
    ));

    let daemon = Arc::new(Daemon::new(shared.clone(), surface.clone()));
    let connections = tokio_util::task::TaskTracker::new();
    tokio::spawn(idle_watch(shared.clone()));
    tokio::spawn(record_watch(
        shared.clone(),
        paths.record.clone(),
        record.clone(),
    ));
    tokio::spawn(signal_watch(shared.clone()));

    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = shared.shutdown().cancelled() => break,
        };
        match accepted {
            Ok(stream) => {
                if !key_unchanged(&shared) {
                    drop(stream);
                    shared.request_exit(ExitReason::KeyChanged);
                    break;
                }
                connections.spawn(crate::rpc::serve(stream, shared.clone(), daemon.clone()));
            }
            Err(error) => {
                shared
                    .log
                    .error(&format!("The channel stopped accepting clients ({error})."));
                shared.request_exit(ExitReason::ChannelFailed);
                break;
            }
        }
    }

    connections.close();
    let _ = tokio::time::timeout(Duration::from_secs(2), connections.wait()).await;
    drop(daemon);
    // Releases every brick and device the daemon holds; the holds stay in `held.json`.
    let _ = tokio::time::timeout(RELEASE_LIMIT, surface.shutdown()).await;
    remove_record_if_ours(&paths.record, &record);
    drop(listener);
    let reason = shared.exit_reason();
    let code = match reason {
        Some(ExitReason::ChannelFailed) => exit_code::FAILED,
        _ => exit_code::CLEAN,
    };
    let code = finish_providers(&end, &shared, code);
    shared
        .log
        .info(&format!("Exiting ({}).", describe_exit(reason)));
    code
}

/// Creates `dir`, which must not exist yet, for the user alone: mode 0700 on Linux and macOS, a
/// protected DACL granting the user full access, inherited by what is created inside, on Windows.
/// An existing directory is refused whoever owns it, so a recording never lands where someone
/// else could have prepared or can read it.
pub fn create_record_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        std::fs::DirBuilder::new().mode(0o700).create(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err(std::io::Error::other(
                "it is not a directory of the user's own with no access for others",
            ));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        windows_dir::create_owner_only(dir)
    }
}

#[cfg(windows)]
mod windows_dir {
    use std::io;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

    /// The owner-only DACL of the directory: protected, one entry granting the user full access,
    /// inherited by files and folders created in it (`OICI`).
    pub fn sddl(sid: &str) -> String {
        format!("D:P(A;OICI;GA;;;{sid})")
    }

    pub fn create_owner_only(dir: &Path) -> io::Result<()> {
        let sid = crate::fsutil::windows::current_user_sid()?;
        let text: Vec<u16> = sddl(&sid).encode_utf16().chain(Some(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `text` is NUL-terminated; the out-pointer is a local.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = crate::fsutil::windows::wide(dir);
        // SAFETY: `name` is NUL-terminated and `attributes` points at a live descriptor.
        let created = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
        let error = io::Error::last_os_error();
        // SAFETY: the descriptor came from LocalAlloc inside the conversion call.
        unsafe {
            LocalFree(descriptor as HLOCAL);
        }
        if created == 0 {
            return Err(error);
        }
        Ok(())
    }
}

fn describe_exit(reason: Option<ExitReason>) -> &'static str {
    match reason {
        Some(ExitReason::Idle) => "no client for 10 s and nothing held",
        Some(ExitReason::Requested) => "a client asked",
        Some(ExitReason::KeyChanged) => "the key changed",
        Some(ExitReason::Signal) => "the system asked",
        Some(ExitReason::ChannelFailed) => "the channel failed",
        None => "unknown",
    }
}

/// Reads the key again; a key that changed or went away ends the daemon, which then releases the
/// hardware it holds.
fn key_unchanged(shared: &Shared) -> bool {
    match crate::key::read_key(&shared.key_file) {
        Ok(key) if key == shared.key => true,
        Ok(_) => {
            shared
                .log
                .warn("The cockpit key changed; releasing the hardware and exiting.");
            false
        }
        Err(error) => {
            shared
                .log
                .warn(&format!("{error} Releasing the hardware and exiting."));
            false
        }
    }
}

fn remove_record_if_ours(file: &Path, ours: &str) {
    if std::fs::read_to_string(file).is_ok_and(|text| text == ours) {
        let _ = std::fs::remove_file(file);
    }
}

/// Ends the daemon after [`IDLE_EXIT`] without a connection while nothing is held; the time
/// counts from the start too, so a daemon nobody connects to ends as well.
async fn idle_watch(shared: Arc<Shared>) {
    let mut connections = shared.watch_connections();
    loop {
        let idle = *connections.borrow_and_update() == 0 && !shared.holding();
        if idle {
            tokio::select! {
                () = tokio::time::sleep(IDLE_EXIT) => {
                    if *connections.borrow() == 0 && !shared.holding() {
                        shared.request_exit(ExitReason::Idle);
                        return;
                    }
                }
                changed = connections.changed() => if changed.is_err() { return },
            }
        } else if connections.changed().await.is_err() {
            return;
        }
    }
}

/// Writes `channel.json` again if it disappeared while the daemon lives, so clients can still
/// find it.
async fn record_watch(shared: Arc<Shared>, file: PathBuf, record: String) {
    loop {
        tokio::select! {
            () = tokio::time::sleep(RECORD_CHECK) => {}
            () = shared.shutdown().cancelled() => return,
        }
        let current = std::fs::read_to_string(&file).ok();
        if current.as_deref() != Some(record.as_str()) {
            match crate::fsutil::write_atomic(&file, record.as_bytes()) {
                Ok(()) => shared
                    .log
                    .warn("The channel record was gone; written again."),
                Err(error) => shared.log.error(&format!(
                    "The channel record could not be written again ({error})."
                )),
            }
        }
    }
}

async fn signal_watch(shared: Arc<Shared>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let Ok(mut term) = signal(SignalKind::terminate()) else {
            return;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            () = shared.shutdown().cancelled() => return,
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = shared.shutdown().cancelled() => return,
        }
    }
    shared.request_exit(ExitReason::Signal);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-rec-{tag}-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_recording_directory_is_created_new_and_an_existing_one_is_refused() {
        let parent = fresh("new");
        let dir = parent.join("scenario");
        create_record_dir(&dir).expect("a new directory");
        assert!(dir.is_dir());
        let error = create_record_dir(&dir).expect_err("it exists now");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists, "{error}");
        let error = create_record_dir(&parent).expect_err("someone's existing directory");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists, "{error}");
        std::fs::remove_dir_all(parent).expect("clean");
    }

    #[cfg(unix)]
    #[test]
    fn a_recording_directory_is_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let parent = fresh("mode");
        let dir = parent.join("scenario");
        create_record_dir(&dir).expect("created");
        let mode = std::fs::metadata(&dir).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::remove_dir_all(parent).expect("clean");
    }

    #[cfg(windows)]
    #[test]
    fn a_recording_directory_grants_the_user_alone_and_passes_it_on() {
        // Elevated, the folders a process makes belong to the Administrators group, not the user.
        if crate::security::is_elevated().unwrap_or(false) {
            eprintln!("skipped: this process runs elevated");
            return;
        }
        let sid = crate::fsutil::windows::current_user_sid().expect("sid");
        assert_eq!(windows_dir::sddl(&sid), format!("D:P(A;OICI;GA;;;{sid})"));
        let parent = fresh("dacl");
        let dir = parent.join("scenario");
        create_record_dir(&dir).expect("created");
        std::fs::write(dir.join("recording.jsonl"), b"{}").expect("a file inside");
        let acl = std::process::Command::new("icacls")
            .arg(dir.join("recording.jsonl"))
            .output()
            .expect("icacls runs");
        let text = String::from_utf8_lossy(&acl.stdout).to_string();
        let entries: Vec<&str> = text.lines().filter(|l| l.contains(":(")).collect();
        assert_eq!(entries.len(), 1, "one entry, the user's: {text}");
        assert!(
            entries[0].contains("(I)(F)"),
            "inherited full access: {text}"
        );
        std::fs::remove_dir_all(parent).expect("clean");
    }
}
