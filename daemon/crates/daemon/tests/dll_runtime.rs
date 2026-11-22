//! Windows: after the daemon's start-up hardening, a DLL loaded by bare name at run time comes
//! from System32 only, never from the executable's directory.
//!
//! Its own test binary, because the hardening applies to the whole process.

#![cfg(windows)]

use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::FreeLibrary;
use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;

fn wide(text: &str) -> Vec<u16> {
    std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

/// A copy of a real System32 DLL under a fresh name in this executable's directory.
fn planted_copy(tag: &str) -> (String, PathBuf) {
    let dir = std::env::current_exe()
        .expect("exe")
        .parent()
        .expect("dir")
        .to_path_buf();
    let name = format!(
        "ev3probe-{tag}-{}.dll",
        ev3_cockpitd::hex(&ev3_cockpitd::random_bytes::<4>())
    );
    let path = dir.join(&name);
    let system =
        std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    std::fs::copy(
        Path::new(&system).join("System32").join("version.dll"),
        &path,
    )
    .expect("copy a system DLL");
    (name, path)
}

#[test]
fn after_hardening_a_dll_beside_the_executable_is_not_loaded_by_name() {
    let (before_name, before_path) = planted_copy("before");
    let (after_name, after_path) = planted_copy("after");

    // SAFETY: NUL-terminated names; the module is freed below.
    let before = unsafe { LoadLibraryW(wide(&before_name).as_ptr()) };
    assert!(
        !before.is_null(),
        "without hardening the executable's directory is searched"
    );

    ev3_cockpitd::security::harden_dll_search().expect("hardening");
    // SAFETY: as above.
    let after = unsafe { LoadLibraryW(wide(&after_name).as_ptr()) };
    let error = std::io::Error::last_os_error();
    // SAFETY: modules loaded above.
    unsafe {
        FreeLibrary(before);
        if !after.is_null() {
            FreeLibrary(after);
        }
    }
    let _ = std::fs::remove_file(before_path);
    let _ = std::fs::remove_file(after_path);
    assert!(
        after.is_null(),
        "after hardening the executable's directory is not searched"
    );
    assert_eq!(error.raw_os_error(), Some(126), "ERROR_MOD_NOT_FOUND");
}
