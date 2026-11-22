//! Files only the user can open, created that way from the start, and written atomically.
//!
//! Windows: every such file and the pipe get a protected DACL granting the current user, by SID,
//! full access and nobody else anything. Linux and macOS: mode 0600 for files and 0700 for
//! directories, set when they are created.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Makes `dir` and its missing parents; the ones it makes are the user's alone on Linux and macOS.
pub fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Creates `path`, which must not exist, readable and writable by the user alone.
pub fn create_new_private(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        windows::create_file(path, windows::Disposition::CreateNew, true)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
    }
}

/// A fresh temporary name beside `path`.
pub fn temp_beside(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        crate::hex(&crate::random_bytes::<6>())
    ))
}

/// Writes `bytes` to `path` through a private temporary file and a rename, so a reader sees the
/// old content or the new, never a part. Windows refuses a rename while a reader has the file
/// open for a moment, so the rename is tried again briefly.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = temp_beside(path);
    let written = (|| {
        let mut file = create_new_private(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    let mut attempt = 0;
    loop {
        match std::fs::rename(&temp, path) {
            Ok(()) => return Ok(()),
            Err(error) if cfg!(windows) && attempt < 40 && is_transient(&error) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temp);
                return Err(error);
            }
        }
    }
}

/// Windows: a sharing violation or access denied that a reader holding the file causes.
fn is_transient(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32))
}

/// SDDL names of the accounts that may reach any user's files anyway: SYSTEM and the
/// Administrators.
const TRUSTED_SDDL: [&str; 4] = ["SY", "S-1-5-18", "BA", "S-1-5-32-544"];

/// Who besides `me`, SYSTEM and the Administrators the security descriptor in `sddl` lets in:
/// the SIDs of its allow entries, and its owner, who can always change the DACL. It fails closed:
/// a descriptor it cannot read whole names a reason instead of a SID, so the folder is never
/// taken for private because it could not be read.
pub fn others_in_sddl(sddl: &str, me: &str) -> Vec<String> {
    let trusted = |sid: &str| sid == me || TRUSTED_SDDL.contains(&sid);
    let mut others = Vec::new();
    match section(sddl, "O:") {
        Some(owner) if trusted(owner) => {}
        Some(owner) => others.push(format!("owner {owner}")),
        None => others.push("no owner read".into()),
    }
    let Some(dacl) = section(sddl, "D:") else {
        others.push("no DACL read".into());
        return others;
    };
    // The DACL's flags (P, AI, AR, NO_ACCESS_CONTROL), then its entries in parentheses.
    let flags_end = dacl.find('(').unwrap_or(dacl.len());
    let flags = &dacl[..flags_end];
    if flags.contains("NO_ACCESS_CONTROL") {
        others.push("everyone (no access control)".into());
        return others;
    }
    if !flags.chars().all(|c| c.is_ascii_uppercase()) {
        others.push(format!("unread DACL flags {flags}"));
        return others;
    }
    let mut rest = &dacl[flags_end..];
    while !rest.is_empty() {
        let Some(entry) = rest.strip_prefix('(') else {
            others.push("unread DACL text".into());
            return others;
        };
        // A conditional entry carries its condition in nested parentheses.
        let mut depth = 1;
        let Some(end) = entry.char_indices().find_map(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            (depth == 0).then_some(i)
        }) else {
            others.push("unterminated DACL entry".into());
            return others;
        };
        let fields: Vec<&str> = entry[..end].split(';').collect();
        let kind = fields.first().copied().unwrap_or_default();
        let sid = fields.get(5).copied().unwrap_or_default();
        match kind {
            // Deny entries take nothing away from the user's own access.
            "D" | "OD" | "XD" => {}
            "A" | "OA" | "XA" | "ZA" if trusted(sid) => {}
            "A" | "OA" | "XA" | "ZA" => others.push(sid.to_owned()),
            other => others.push(format!("unread entry {other}")),
        }
        rest = &entry[end + 1..];
    }
    others
}

/// The text of the SDDL section `tag` (`O:`, `G:`, `D:`, `S:`) up to the next section, if present.
fn section<'a>(sddl: &'a str, tag: &str) -> Option<&'a str> {
    let start = sddl.find(tag)? + tag.len();
    let rest = &sddl[start..];
    // The next section starts with one of the tags; inside a DACL a ':' appears only in a
    // conditional expression, which sits within parentheses.
    let mut depth = 0i32;
    let mut end = rest.len();
    let bytes = rest.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'O' | b'G' | b'D' | b'S' if depth == 0 && bytes.get(i + 1) == Some(&b':') && i > 0 => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    Some(&rest[..end])
}

#[cfg(windows)]
pub mod windows {
    //! The Windows side: the owner-only security descriptor and file creation with it.

    use std::fs::File;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GetTokenInformation, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE,
        FILE_SHARE_READ, OPEN_ALWAYS,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// A path as a NUL-terminated wide string.
    pub fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// The current user's SID as a string, from the process token.
    pub fn current_user_sid() -> io::Result<String> {
        // SAFETY: plain Win32 calls with out-pointers to locals; every handle and allocation is
        // released before returning.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut needed = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            let mut buffer = vec![0u8; needed as usize];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            );
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text as HLOCAL);
            Ok(sid)
        }
    }

    /// A protected DACL with one entry: the current user, full access.
    pub struct OwnerOnly {
        descriptor: PSECURITY_DESCRIPTOR,
    }

    // SAFETY: the descriptor is an immutable heap allocation owned by this value; Windows only
    // reads it.
    unsafe impl Send for OwnerOnly {}
    // SAFETY: as above, it is never written after creation.
    unsafe impl Sync for OwnerOnly {}

    impl OwnerOnly {
        /// The descriptor for the current user.
        pub fn current_user() -> io::Result<Self> {
            Self::from_sddl(&owner_only_sddl(&current_user_sid()?))
        }

        fn from_sddl(sddl: &str) -> io::Result<Self> {
            let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: `sddl` is NUL-terminated; the out-pointer is a local.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { descriptor })
        }

        /// Security attributes pointing at the descriptor, not inheritable; valid while `self`
        /// lives.
        pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.descriptor,
                bInheritHandle: 0,
            }
        }
    }

    impl Drop for OwnerOnly {
        fn drop(&mut self) {
            // SAFETY: the descriptor came from LocalAlloc inside the conversion call.
            unsafe {
                LocalFree(self.descriptor as HLOCAL);
            }
        }
    }

    /// The SDDL of the owner-only DACL: protected (`P`, nothing inherited), one allow entry with
    /// generic all for the user's SID.
    pub fn owner_only_sddl(sid: &str) -> String {
        format!("D:P(A;;GA;;;{sid})")
    }

    /// How [`create_file`] treats an existing file.
    pub enum Disposition {
        /// Fail when it exists.
        CreateNew,
        /// Open it when it exists, create it otherwise.
        OpenAlways,
    }

    /// Opens `path` for reading and writing, with the owner-only DACL when it creates it.
    /// `share` false opens it with no sharing at all.
    pub fn create_file(path: &Path, disposition: Disposition, share: bool) -> io::Result<File> {
        let owner = OwnerOnly::current_user()?;
        let attributes = owner.attributes();
        let name = wide(path);
        let disposition = match disposition {
            Disposition::CreateNew => CREATE_NEW,
            Disposition::OpenAlways => OPEN_ALWAYS,
        };
        let share = if share {
            FILE_SHARE_READ | FILE_SHARE_DELETE
        } else {
            0
        };
        // SAFETY: `name` is NUL-terminated and `attributes` outlives the call.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                share,
                &attributes,
                disposition,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a valid handle we own from here on.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    /// Makes `dir`, which must not exist, with a protected DACL granting the current user full
    /// access, inherited by what is created inside.
    pub fn create_private_dir(dir: &Path) -> io::Result<()> {
        let sid = current_user_sid()?;
        let owner = OwnerOnly::from_sddl(&format!("D:P(A;OICI;GA;;;{sid})"))?;
        let attributes = owner.attributes();
        let name = wide(dir);
        // SAFETY: `name` is NUL-terminated and `attributes` outlives the call.
        if unsafe { CreateDirectoryW(name.as_ptr(), &attributes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Who besides the current user, SYSTEM and the Administrators the DACL of `path` lets in.
    pub fn others_with_access(path: &Path) -> io::Result<Vec<String>> {
        let me = current_user_sid()?;
        let name = wide(path);
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated; the out-pointers are locals; the descriptor is freed
        // below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `descriptor` is valid until freed; `text` is a local out-pointer.
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        let error = io::Error::last_os_error();
        // SAFETY: allocated by GetNamedSecurityInfoW with LocalAlloc.
        unsafe { LocalFree(descriptor as HLOCAL) };
        if ok == 0 {
            return Err(error);
        }
        // SAFETY: a NUL-terminated wide string allocated by the conversion; freed after reading.
        let sddl = unsafe {
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let sddl = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text as HLOCAL);
            sddl
        };
        Ok(super::others_in_sddl(&sddl, &me))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-fs-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn an_atomic_write_leaves_no_temporary_file() {
        let dir = temp_dir();
        let file = dir.join("x.json");
        write_atomic(&file, b"one").expect("first");
        write_atomic(&file, b"two").expect("second");
        assert_eq!(std::fs::read(&file).expect("read"), b"two");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .expect("list")
            .map(|e| e.expect("entry").file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_private_file_is_never_created_over_an_existing_one() {
        let dir = temp_dir();
        let file = dir.join("k");
        create_new_private(&file).expect("first");
        let error = create_new_private(&file).expect_err("exists");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_has_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let file = dir.join("k");
        create_new_private(&file).expect("create");
        let mode = std::fs::metadata(&file).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn only_allow_entries_for_someone_else_count_as_others() {
        let me = "S-1-5-21-1-2-3-1001";
        let sddl = format!(
            "O:{me}D:PAI(A;OICI;FA;;;{me})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(D;;FA;;;WD)(A;;0x1200a9;;;BU)S:(ML;;NW;;;LW)"
        );
        assert_eq!(others_in_sddl(&sddl, me), vec!["BU".to_owned()]);
        assert!(others_in_sddl(&format!("O:{me}D:P(A;OICI;GA;;;{me})"), me).is_empty());
        assert!(others_in_sddl(&format!("O:BAD:P(A;OICI;GA;;;{me})"), me).is_empty());
    }

    #[test]
    fn a_descriptor_that_cannot_be_read_whole_is_never_private() {
        let me = "S-1-5-21-1-2-3-1001";
        let refused = |sddl: String| {
            let others = others_in_sddl(&sddl, me);
            assert!(!others.is_empty(), "{sddl} was taken for private");
        };
        // A NULL DACL lets everyone in.
        refused(format!("O:{me}D:NO_ACCESS_CONTROL"));
        // No DACL, or no owner, read.
        refused(format!("O:{me}"));
        refused(format!("D:P(A;OICI;GA;;;{me})"));
        // Another owner can always rewrite the DACL.
        refused(format!("O:S-1-5-21-9-9-9-1002D:P(A;OICI;GA;;;{me})"));
        // A callback allow entry for someone else, after a conditional one with nested parentheses.
        refused(format!(
            "O:{me}D:P(XA;;FA;;;{me};(@User.x == 1))(ZA;;FA;;;BU;(x))"
        ));
        // An entry kind it does not know, and text it cannot read.
        refused(format!("O:{me}D:P(Q;;FA;;;{me})"));
        refused(format!("O:{me}D:P(A;;FA;;;{me})junk"));
        refused(format!("O:{me}D:P(A;;FA;;;{me}"));
    }

    #[test]
    fn callback_entries_for_the_user_and_deny_entries_keep_a_folder_private() {
        let me = "S-1-5-21-1-2-3-1001";
        assert!(
            others_in_sddl(
                &format!("O:{me}D:P(XA;;FA;;;{me};(@User.x == 1))(D;;FA;;;WD)"),
                me
            )
            .is_empty()
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_private_directory_lets_in_the_user_alone() {
        let dir = temp_dir();
        let private = dir.join("bin");
        windows::create_private_dir(&private).expect("create");
        assert_eq!(
            windows::others_with_access(&private).expect("read"),
            Vec::<String>::new()
        );
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[cfg(windows)]
    #[test]
    fn the_owner_only_dacl_names_the_current_user_alone() {
        let sid = windows::current_user_sid().expect("sid");
        assert!(sid.starts_with("S-1-5-"), "{sid}");
        assert_eq!(
            windows::owner_only_sddl(&sid),
            format!("D:P(A;;GA;;;{sid})")
        );
        windows::OwnerOnly::current_user().expect("the SDDL converts");
    }
}
