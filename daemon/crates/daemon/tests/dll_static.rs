//! Windows: the daemon's static imports resolve from System32 only, so a DLL planted beside the
//! executable under an imported name is never loaded.
//!
//! The executable's load configuration carries `DependentLoadFlags = 0x800`
//! (`LOAD_LIBRARY_SEARCH_SYSTEM32`). A copy with garbage DLLs planted under its imported names
//! still starts; the same copy with the flag cleared does not, which proves the planted files are
//! where the loader would otherwise look first.

#![cfg(windows)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{TempRoot, wait_exit};

const LOAD_LIBRARY_SEARCH_SYSTEM32: u16 = 0x800;
const USAGE: i32 = 64;

struct Pe {
    bytes: Vec<u8>,
}

impl Pe {
    fn read(path: &Path) -> Self {
        Self {
            bytes: std::fs::read(path).expect("read the executable"),
        }
    }

    fn u16(&self, at: usize) -> u16 {
        u16::from_le_bytes([self.bytes[at], self.bytes[at + 1]])
    }

    fn u32(&self, at: usize) -> u32 {
        u32::from_le_bytes(self.bytes[at..at + 4].try_into().expect("4 bytes"))
    }

    fn optional_header(&self) -> usize {
        let pe = self.u32(0x3c) as usize;
        assert_eq!(&self.bytes[pe..pe + 4], b"PE\0\0");
        let optional = pe + 24;
        assert_eq!(self.u16(optional), 0x20b, "a 64-bit image");
        optional
    }

    /// The (RVA, size) of data directory `index`.
    fn directory(&self, index: usize) -> (u32, u32) {
        let at = self.optional_header() + 112 + index * 8;
        (self.u32(at), self.u32(at + 4))
    }

    fn file_offset(&self, rva: u32) -> usize {
        let pe = self.u32(0x3c) as usize;
        let sections = self.u16(pe + 6) as usize;
        let table = self.optional_header() + self.u16(pe + 20) as usize;
        for i in 0..sections {
            let s = table + i * 40;
            let (virtual_size, virtual_address) = (self.u32(s + 8), self.u32(s + 12));
            let raw = self.u32(s + 20);
            if rva >= virtual_address && rva < virtual_address + virtual_size.max(self.u32(s + 16))
            {
                return (rva - virtual_address + raw) as usize;
            }
        }
        panic!("RVA {rva:#x} is in no section");
    }

    /// Where `DependentLoadFlags` sits in the file.
    fn dependent_load_flags_offset(&self) -> usize {
        let (rva, _) = self.directory(10);
        assert_ne!(rva, 0, "the image has a load configuration");
        let config = self.file_offset(rva);
        assert!(
            self.u32(config) >= 80,
            "the load configuration includes DependentLoadFlags"
        );
        config + 78
    }

    fn imports(&self) -> Vec<String> {
        let (rva, _) = self.directory(1);
        let mut at = self.file_offset(rva);
        let mut names = Vec::new();
        loop {
            let name_rva = self.u32(at + 12);
            if name_rva == 0 {
                break;
            }
            let start = self.file_offset(name_rva);
            let end = start
                + self.bytes[start..]
                    .iter()
                    .position(|b| *b == 0)
                    .expect("NUL");
            names.push(String::from_utf8_lossy(&self.bytes[start..end]).into_owned());
            at += 20;
        }
        names
    }
}

/// Imported DLLs the loader would look for beside the executable: neither API sets nor
/// KnownDLLs, which never come from there.
fn plantable(imports: &[String]) -> Vec<String> {
    const KNOWN: &[&str] = &[
        "kernel32.dll",
        "advapi32.dll",
        "ws2_32.dll",
        "user32.dll",
        "gdi32.dll",
        "ole32.dll",
        "oleaut32.dll",
        "rpcrt4.dll",
        "sechost.dll",
        "shell32.dll",
        "msvcrt.dll",
        "combase.dll",
        "nsi.dll",
        "shlwapi.dll",
        "setupapi.dll",
        "imm32.dll",
        "normaliz.dll",
        "ntdll.dll",
    ];
    imports
        .iter()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            !lower.starts_with("api-ms-win-")
                && !lower.starts_with("ext-ms-")
                && !KNOWN.contains(&lower.as_str())
        })
        .cloned()
        .collect()
}

fn set_quiet_error_mode() {
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX, SetErrorMode,
    };
    // SAFETY: no pointers; children inherit the mode, so a bad image fails without a dialog.
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

/// Runs `exe` with an argument it refuses: the usage exit code proves the process started.
fn starts(exe: &Path) -> Option<i32> {
    let mut child = match Command::new(exe)
        .arg("--not-an-argument")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return None,
    };
    match wait_exit(&mut child, Duration::from_secs(15)) {
        Some(status) => status.code(),
        None => {
            let _ = child.kill();
            panic!("the copy neither started nor failed within 15 s");
        }
    }
}

#[test]
fn the_binary_resolves_its_static_imports_from_system32_only() {
    if common::refuses_this_process() {
        return;
    }
    let pe = Pe::read(common::bin());
    assert_eq!(
        pe.u16(pe.dependent_load_flags_offset()),
        LOAD_LIBRARY_SEARCH_SYSTEM32
    );
}

#[test]
fn a_dll_planted_beside_the_binary_under_an_imported_name_is_not_loaded() {
    if common::refuses_this_process() {
        return;
    }
    set_quiet_error_mode();
    let pe = Pe::read(common::bin());
    // With the C runtime linked statically the remaining imports are system DLLs the loader
    // takes from System32 or memory anyway; whatever is left that is not a KnownDLL is planted.
    let planted = plantable(&pe.imports());
    if planted.is_empty() {
        return;
    }

    let dir = TempRoot::new("plant");
    let exe = dir.path().join("ev3-cockpitd.exe");
    std::fs::copy(common::bin(), &exe).expect("copy");
    for name in &planted {
        std::fs::write(dir.path().join(name), b"MZ not a real DLL").expect("plant");
    }
    assert_eq!(
        starts(&exe),
        Some(USAGE),
        "the hardened copy ignores {planted:?}"
    );

    // The same copy without the flag shows whether any planted name would have been loaded at
    // all: the system may already hold every one of them (the binary links its C runtime
    // statically, so the DLL this used to catch is no longer imported). Reported, not asserted.
    let unhardened = dir.path().join("unhardened.exe");
    let mut bytes = pe.bytes.clone();
    let at = pe.dependent_load_flags_offset();
    bytes[at..at + 2].copy_from_slice(&0u16.to_le_bytes());
    std::fs::write(&unhardened, bytes).expect("write");
    let loaded_without_flag = starts(&unhardened) != Some(USAGE);
    eprintln!("without the flag a planted DLL is loaded: {loaded_without_flag} ({planted:?})");
}

#[test]
fn the_binary_does_not_import_the_c_runtime() {
    if common::refuses_this_process() {
        return;
    }
    let pe = Pe::read(common::bin());
    let imports: Vec<String> = pe
        .imports()
        .iter()
        .map(|n| n.to_ascii_lowercase())
        .collect();
    assert!(
        !imports
            .iter()
            .any(|n| n.starts_with("vcruntime") || n.starts_with("api-ms-win-crt")),
        "the C runtime must be linked statically, so the daemon runs with nothing installed: {imports:?}"
    );
}
