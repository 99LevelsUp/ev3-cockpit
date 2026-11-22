//! Path confinement: the one check every file method runs on a local path a client names, to read
//! from or to write to.
//!
//! The daemon refuses any such path that resolves, through links and junctions, into the
//! cockpit's own state, binary or runtime directories, whoever the client is. A path that does not
//! exist yet resolves through its deepest existing ancestor; `..` after that ancestor, or a link
//! whose target is missing, is refused, since either could land anywhere once written.
//!
//! What it checks: the file a path finally reaches, through links and junctions, does not lie in
//! those directories, by its resolved path and again by its open handle's final path, so a link
//! made between the check of the letters and the open is caught too; and a regular file with
//! more than one name is not one of theirs. What it does not cover: protection from another
//! process of the same user that swaps folders while the daemon is opening a file (that process
//! can reach the cockpit's directories itself: the trust boundary is the user account, see
//! `docs/channel.md`), links inside those directories that lead back out, other namespaces for
//! the same volume (a local share), alternate data streams and special files. A guardrail for
//! clients that name a path, not a sandbox.

use std::path::{Component, Path, PathBuf};

use ev3_contract::{ContractError, ErrorCode};

/// The directories no client-named path may resolve into.
#[derive(Debug, Clone)]
pub struct Confinement {
    roots: Vec<PathBuf>,
}

/// Why a path cannot be resolved.
#[derive(Debug)]
pub struct ResolveError(pub String);

/// Resolves an absolute `path` through links and junctions; a part that does not exist yet is
/// appended to its deepest existing ancestor's resolution.
pub fn resolve(path: &Path) -> Result<PathBuf, ResolveError> {
    if !path.is_absolute() {
        return Err(ResolveError(format!(
            "{} is not an absolute path.",
            path.display()
        )));
    }
    let mut existing = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(resolved) => {
                let mut out = resolved;
                for part in missing.iter().rev() {
                    out.push(part);
                }
                return Ok(out);
            }
            Err(_) => {
                if std::fs::symlink_metadata(&existing).is_ok() {
                    return Err(ResolveError(format!(
                        "{} is a link whose target does not exist.",
                        existing.display()
                    )));
                }
                match existing.components().next_back() {
                    Some(Component::Normal(name)) => {
                        missing.push(name.to_os_string());
                        existing.pop();
                    }
                    Some(Component::CurDir) => {
                        existing.pop();
                    }
                    Some(Component::ParentDir) => {
                        return Err(ResolveError(format!(
                            "{} climbs out of a folder that does not exist.",
                            path.display()
                        )));
                    }
                    _ => {
                        return Err(ResolveError(format!(
                            "{} cannot be resolved.",
                            path.display()
                        )));
                    }
                }
            }
        }
    }
}

/// The path an open file has now, through every link and junction: what the handle reaches, not
/// what its name said when it was opened. Same form as [`std::fs::canonicalize`], which the roots
/// went through.
#[cfg(windows)]
pub fn final_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };
    let mut buffer = vec![0u16; 512];
    loop {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: the handle is open for the borrow of `file`, and the buffer holds `capacity`
        // UTF-16 units; the call writes at most that many.
        let written = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if written == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if written < buffer.len() {
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..written],
            )));
        }
        // Too small: `written` is the size needed, terminator included.
        buffer.resize(written, 0);
    }
}

/// The path an open file has now (see the Windows variant).
#[cfg(target_os = "linux")]
pub fn final_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

/// The path an open file has now (see the Windows variant).
#[cfg(target_os = "macos")]
pub fn final_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes a terminated path of at most PATH_MAX bytes into the buffer.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])))
}

/// Why an opened file is not used: the confinement refused it, or the system could not say.
enum HandleRefusal {
    Refused(ContractError),
    Io(std::io::Error),
}

impl HandleRefusal {
    fn or_io(self, io: impl FnOnce(std::io::Error) -> ContractError) -> ContractError {
        match self {
            Self::Refused(error) => error,
            Self::Io(error) => io(error),
        }
    }
}

/// A file's identity on its volume, the same under every name.
type FileIdentity = (u64, u64);

/// The identity of an open file and how many names it has.
#[cfg(unix)]
fn file_identity(file: &std::fs::File) -> std::io::Result<(FileIdentity, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(((meta.dev(), meta.ino()), meta.nlink()))
}

/// The identity of an open file and how many names it has.
#[cfg(windows)]
fn file_identity(file: &std::fs::File) -> std::io::Result<(FileIdentity, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is valid; the handle is open for the borrow.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a valid out pointer for the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((
        (u64::from(info.dwVolumeSerialNumber), index),
        u64::from(info.nNumberOfLinks),
    ))
}

/// The identity of the file a directory entry names, asked without reading it: a file the
/// daemon may only write, or one another process holds open, still has one.
#[cfg(unix)]
fn identity_at(path: &Path) -> std::io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path)?;
    Ok((meta.dev(), meta.ino()))
}

/// The identity of the file a directory entry names, asked without reading it (an open with no
/// access rights, which no sharing mode refuses).
#[cfg(windows)]
fn identity_at(path: &Path) -> std::io::Result<FileIdentity> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    Ok(file_identity(&file)?.0)
}

/// How many entries a search of the cockpit's directories looks at before it gives up unsure.
const SEARCH_BUDGET: usize = 10_000;

/// Opens a folder, to ask its final path.
#[cfg(unix)]
fn open_folder(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// Opens a folder, to ask its final path (Windows opens a directory only with backup semantics).
#[cfg(windows)]
fn open_folder(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

/// What a search of the cockpit's directories for a file found.
#[derive(Debug, PartialEq, Eq)]
enum Search {
    Found,
    NotFound,
    /// A directory or an entry could not be read, or the walk ran past its bound: the file may be
    /// there, so the caller refuses.
    Unsure,
}

/// Searches `dir` and everything under it, links not followed, for a file with `identity`.
/// `budget` bounds the entries looked at; the cockpit's directories hold a handful of files.
fn search(dir: &Path, identity: FileIdentity, budget: &mut usize) -> Search {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Search::NotFound,
        Err(_) => return Search::Unsure,
    };
    let mut unsure = false;
    for entry in entries {
        if *budget == 0 {
            return Search::Unsure;
        }
        *budget -= 1;
        let Ok(entry) = entry else {
            unsure = true;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            unsure = true;
            continue;
        };
        if kind.is_dir() {
            match search(&entry.path(), identity, budget) {
                Search::Found => return Search::Found,
                Search::Unsure => unsure = true,
                Search::NotFound => {}
            }
        } else if kind.is_file() {
            match identity_at(&entry.path()) {
                Ok(other) if other == identity => return Search::Found,
                Ok(_) => {}
                Err(_) => unsure = true,
            }
        }
    }
    if unsure {
        Search::Unsure
    } else {
        Search::NotFound
    }
}

/// Whether `path` is `root` or lies inside it; letters compare without case on Windows.
fn inside(path: &Path, root: &Path) -> bool {
    let norm = |c: Component<'_>| {
        let text = c.as_os_str().to_string_lossy().into_owned();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    let mut path = path.components();
    for part in root.components() {
        match path.next() {
            Some(other) if norm(other) == norm(part) => {}
            _ => return false,
        }
    }
    true
}

impl Confinement {
    /// Confinement to everything outside `roots`, each resolved the way a client path is.
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        let roots = roots
            .into_iter()
            .filter_map(|root| resolve(&root).ok())
            .collect();
        Self { roots }
    }

    /// The directories no path may resolve into.
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Resolves `path` and refuses it when it lands in the cockpit's own directories; returns the
    /// resolved path, the one the file method then opens.
    pub fn check(&self, path: &Path) -> Result<PathBuf, ContractError> {
        let resolved = resolve(path).map_err(|ResolveError(why)| {
            ContractError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "The daemon does not use the local path {}: {why}",
                    path.display()
                ),
            )
        })?;
        self.check_resolved(path, &resolved)?;
        Ok(resolved)
    }

    /// Reads the file a confined path names. The check ran on the path's letters, so a link
    /// swapped into one of its folders since then would lead elsewhere: the file is opened, the
    /// handle's own final path is checked again, and only then read through that handle.
    pub fn read(&self, named: &Path, resolved: &Path) -> Result<Vec<u8>, ContractError> {
        use std::io::Read;
        let unreadable = |error: std::io::Error| {
            ContractError::new(
                ErrorCode::InvalidRequest,
                format!("{} could not be read ({error}).", named.display()),
            )
        };
        let mut file = std::fs::File::open(resolved).map_err(unreadable)?;
        self.check_handle(named, &file)
            .map_err(|e| e.or_io(unreadable))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(unreadable)?;
        Ok(data)
    }

    /// Writes `data` to the file a confined path names, through a handle checked again first (see
    /// [`Confinement::read`]). An existing file is emptied only after that check, so a refused
    /// write leaves it as it was. A new file is created only after its folder, opened, passed the
    /// check; one created all the same where the check then refuses it is removed again.
    pub fn write(&self, named: &Path, resolved: &Path, data: &[u8]) -> Result<(), ContractError> {
        use std::io::Write;
        let unwritable = |error: std::io::Error| {
            ContractError::new(
                ErrorCode::Internal,
                format!("{} could not be written ({error}).", named.display()),
            )
        };
        if std::fs::symlink_metadata(resolved).is_err()
            && let Some(folder) = resolved.parent()
        {
            let folder = open_folder(folder).map_err(unwritable)?;
            self.check_resolved(named, &final_path(&folder).map_err(unwritable)?)?;
        }
        let (mut file, created) = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(resolved)
        {
            Ok(file) => (file, true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(resolved)
                    .map_err(unwritable)?,
                false,
            ),
            Err(error) => return Err(unwritable(error)),
        };
        if let Err(refusal) = self.check_handle(named, &file) {
            if created {
                // Created where the check refuses: take it back, by the path the handle has.
                if let Ok(path) = final_path(&file) {
                    let _ = std::fs::remove_file(path);
                }
            }
            return Err(refusal.or_io(unwritable));
        }
        file.set_len(0).map_err(unwritable)?;
        file.write_all(data).map_err(unwritable)?;
        file.flush().map_err(unwritable)
    }

    /// Refuses an opened file that lies in the cockpit's own directories: by the handle's final
    /// path, and, for a file with more than one name, by its identity, since a hard link outside
    /// reaches the same file under a path no check would refuse.
    fn check_handle(&self, named: &Path, file: &std::fs::File) -> Result<(), HandleRefusal> {
        let path = final_path(file).map_err(HandleRefusal::Io)?;
        self.check_resolved(named, &path)
            .map_err(HandleRefusal::Refused)?;
        let (identity, links) = file_identity(file).map_err(HandleRefusal::Io)?;
        if links <= 1 {
            return Ok(());
        }
        let mut budget = SEARCH_BUDGET;
        for root in &self.roots {
            let why = match search(root, identity, &mut budget) {
                Search::NotFound => continue,
                Search::Found => "it is another name for one of the cockpit's own files",
                Search::Unsure => {
                    "it has several names, and the daemon could not make sure none of them is \
                     one of the cockpit's own files"
                }
            };
            return Err(HandleRefusal::Refused(ContractError::new(
                ErrorCode::AccessDenied,
                format!(
                    "The daemon does not read or write {}: {why} in {}.",
                    named.display(),
                    root.display()
                ),
            )));
        }
        Ok(())
    }

    /// Refuses an already resolved path, such as the final path of a handle a file method has
    /// opened, when it lies in the cockpit's own directories.
    pub fn check_resolved(&self, named: &Path, resolved: &Path) -> Result<(), ContractError> {
        match self.roots.iter().find(|root| inside(resolved, root)) {
            Some(root) => Err(ContractError::new(
                ErrorCode::AccessDenied,
                format!(
                    "The daemon does not read or write {}: it resolves into the cockpit's own files in {}.",
                    named.display(),
                    root.display()
                ),
            )),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-confine-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::canonicalize(dir).expect("canonical")
    }

    #[test]
    fn a_path_inside_a_root_is_refused_and_one_outside_is_resolved() {
        let base = temp_dir();
        let state = base.join("state");
        let other = base.join("other");
        std::fs::create_dir_all(&state).expect("state");
        std::fs::create_dir_all(&other).expect("other");
        std::fs::write(state.join("key"), b"k").expect("key");
        let confinement = Confinement::new([state.clone()]);
        for named in [
            state.clone(),
            state.join("key"),
            state.join("new").join("file"),
            other.join("..").join("state").join("key"),
        ] {
            let error = confinement.check(&named).expect_err("refused");
            assert_eq!(
                error.data.code,
                ErrorCode::AccessDenied,
                "{}",
                named.display()
            );
        }
        let fine = confinement
            .check(&other.join("out.rbf"))
            .expect("outside the state root");
        assert!(fine.ends_with("out.rbf"));
        assert!(
            confinement.check(&base.join("statefile")).is_ok(),
            "a sibling prefix is not inside"
        );
        std::fs::remove_dir_all(base).expect("clean");
    }

    #[test]
    fn a_relative_path_or_climbing_out_of_a_missing_folder_is_refused() {
        let base = temp_dir();
        let confinement = Confinement::new([base.join("state")]);
        let error = confinement
            .check(Path::new("relative.txt"))
            .expect_err("relative");
        assert_eq!(error.data.code, ErrorCode::InvalidRequest);
        // Windows removes `..` from a path by its letters before it follows anything, so the
        // climb lands where the operating system would open it: in the state root, refused. On
        // Linux and macOS `..` after a missing folder cannot be resolved at all.
        let climb = base.join("missing").join("..").join("state").join("key");
        let expected = if cfg!(windows) {
            ErrorCode::AccessDenied
        } else {
            ErrorCode::InvalidRequest
        };
        assert_eq!(
            confinement.check(&climb).expect_err("climb").data.code,
            expected
        );
        std::fs::remove_dir_all(base).expect("clean");
    }

    /// Makes `link` a link to the folder `target`: a symbolic link on Linux and macOS, a junction
    /// on Windows (which needs no privilege).
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("symlink");
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
    }

    #[test]
    fn a_confined_file_is_written_and_read_through_its_handle() {
        let base = temp_dir();
        let confinement = Confinement::new([base.join("state")]);
        let named = base.join("out.bin");
        let resolved = confinement.check(&named).expect("outside");
        confinement
            .write(&named, &resolved, b"a longer first content")
            .expect("write");
        confinement
            .write(&named, &resolved, b"short")
            .expect("rewrite");
        assert_eq!(confinement.read(&named, &resolved).expect("read"), b"short");
        std::fs::remove_dir_all(base).expect("clean");
    }

    #[test]
    fn a_folder_swapped_for_a_link_after_the_check_is_refused_and_nothing_is_touched() {
        let base = temp_dir();
        let state = base.join("state");
        let out = base.join("out");
        std::fs::create_dir_all(&state).expect("state");
        std::fs::create_dir_all(&out).expect("out");
        std::fs::write(state.join("key"), b"secret").expect("key");
        let confinement = Confinement::new([state.clone()]);
        let named = out.join("key");
        let resolved = confinement
            .check(&named)
            .expect("outside the state when checked");
        // Between the check and the open (a whole brick transfer for files/read), the folder
        // becomes a link into the cockpit's own state.
        std::fs::remove_dir(&out).expect("remove out");
        link_folder(&state, &out);

        let write = confinement
            .write(&named, &resolved, b"overwritten")
            .expect_err("write refused");
        assert_eq!(write.data.code, ErrorCode::AccessDenied);
        let read = confinement
            .read(&named, &resolved)
            .expect_err("read refused");
        assert_eq!(read.data.code, ErrorCode::AccessDenied);
        assert_eq!(std::fs::read(state.join("key")).expect("key"), b"secret");

        #[cfg(windows)]
        std::fs::remove_dir(&out).expect("remove junction");
        #[cfg(unix)]
        std::fs::remove_file(&out).expect("remove link");
        std::fs::remove_dir_all(base).expect("clean");
    }

    #[test]
    fn a_new_file_through_a_swapped_folder_is_refused_and_not_left_in_the_state() {
        let base = temp_dir();
        let state = base.join("state");
        let out = base.join("out");
        std::fs::create_dir_all(&state).expect("state");
        std::fs::create_dir_all(&out).expect("out");
        let confinement = Confinement::new([state.clone()]);
        let named = out.join("new.bin");
        let resolved = confinement.check(&named).expect("outside when checked");
        std::fs::remove_dir(&out).expect("remove out");
        link_folder(&state, &out);

        let error = confinement
            .write(&named, &resolved, b"planted")
            .expect_err("refused");
        assert_eq!(error.data.code, ErrorCode::AccessDenied);
        assert!(
            !state.join("new.bin").exists(),
            "the refused write left a file in the state"
        );

        #[cfg(windows)]
        std::fs::remove_dir(&out).expect("remove junction");
        #[cfg(unix)]
        std::fs::remove_file(&out).expect("remove link");
        std::fs::remove_dir_all(base).expect("clean");
    }

    #[test]
    fn a_hard_link_outside_to_a_state_file_is_refused_both_ways() {
        let base = temp_dir();
        let state = base.join("state");
        std::fs::create_dir_all(&state).expect("state");
        std::fs::write(state.join("key"), b"secret").expect("key");
        let named = base.join("innocent.txt");
        std::fs::hard_link(state.join("key"), &named).expect("hard link");
        let confinement = Confinement::new([state.clone()]);
        let resolved = confinement.check(&named).expect("its letters are outside");

        let read = confinement
            .read(&named, &resolved)
            .expect_err("read refused");
        assert_eq!(read.data.code, ErrorCode::AccessDenied);
        let write = confinement
            .write(&named, &resolved, b"overwritten")
            .expect_err("write refused");
        assert_eq!(write.data.code, ErrorCode::AccessDenied);
        assert_eq!(std::fs::read(state.join("key")).expect("key"), b"secret");

        // As deep in the state as it may be.
        let deep = state
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("e")
            .join("f");
        std::fs::create_dir_all(&deep).expect("deep");
        std::fs::write(deep.join("ledger.json"), b"{}").expect("deep file");
        let outside = base.join("deep-link.json");
        std::fs::hard_link(deep.join("ledger.json"), &outside).expect("deep link");
        let resolved = confinement.check(&outside).expect("letters outside");
        assert_eq!(
            confinement
                .write(&outside, &resolved, b"x")
                .expect_err("deep refused")
                .data
                .code,
            ErrorCode::AccessDenied
        );
        assert_eq!(
            std::fs::read(deep.join("ledger.json")).expect("deep"),
            b"{}"
        );

        // A state file the daemon could only write is still recognised.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let only_write = state.join("only-write");
            std::fs::write(&only_write, b"w").expect("only-write");
            std::fs::set_permissions(&only_write, std::fs::Permissions::from_mode(0o200))
                .expect("chmod");
            let outside = base.join("only-write-link");
            std::fs::hard_link(&only_write, &outside).expect("link");
            let resolved = confinement.check(&outside).expect("letters outside");
            assert_eq!(
                confinement
                    .write(&outside, &resolved, b"x")
                    .expect_err("write-only refused")
                    .data
                    .code,
                ErrorCode::AccessDenied
            );
            std::fs::set_permissions(&only_write, std::fs::Permissions::from_mode(0o600))
                .expect("chmod back");
        }

        // A file with two names, neither in the state, is fine.
        std::fs::write(base.join("a.txt"), b"a").expect("a");
        std::fs::hard_link(base.join("a.txt"), base.join("b.txt")).expect("b");
        let b = confinement.check(&base.join("b.txt")).expect("b outside");
        assert_eq!(
            confinement.read(&base.join("b.txt"), &b).expect("read"),
            b"a"
        );
        std::fs::remove_dir_all(base).expect("clean");
    }

    #[cfg(windows)]
    #[test]
    fn letters_compare_without_case_on_windows() {
        let base = temp_dir();
        let state = base.join("State");
        std::fs::create_dir_all(&state).expect("state");
        let confinement = Confinement::new([state.clone()]);
        let shouted = PathBuf::from(state.to_string_lossy().to_uppercase()).join("x");
        assert!(confinement.check(&shouted).is_err());
        std::fs::remove_dir_all(base).expect("clean");
    }
}
