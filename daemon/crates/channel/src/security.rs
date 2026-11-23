//! What the daemon checks about its own process before it does anything else: it never runs
//! elevated or as root, and on Windows it loads DLLs at run time from System32 only. `ev3` uses
//! the same checks, to load DLLs the same way and to say plainly why it cannot start the daemon
//! when it runs elevated itself.

/// Why the daemon refuses to run with these privileges, or `None` when it may.
pub fn privilege_refusal(elevated: bool) -> Option<&'static str> {
    if !elevated {
        return None;
    }
    Some(if cfg!(windows) {
        "The cockpit daemon does not run elevated (as administrator); start it as yourself."
    } else {
        "The cockpit daemon does not run as root; start it as yourself."
    })
}

/// Whether this process runs with elevated privileges: an elevated token on Windows, a real or
/// effective user id of 0 on Linux and macOS.
pub fn is_elevated() -> std::io::Result<bool> {
    imp::is_elevated()
}

/// Restricts DLLs this process loads at run time to System32. The static imports are restricted
/// the same way by the link flag the build script sets.
pub fn harden_dll_search() -> std::io::Result<()> {
    imp::harden_dll_search()
}

#[cfg(windows)]
mod imp {
    use std::io;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub fn is_elevated() -> io::Result<bool> {
        // SAFETY: plain Win32 calls with out-pointers to locals; the token handle is closed.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            Ok(elevation.TokenIsElevated != 0)
        }
    }

    pub fn harden_dll_search() -> io::Result<()> {
        // SAFETY: no pointers involved.
        if unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
mod imp {
    pub fn is_elevated() -> std::io::Result<bool> {
        // SAFETY: getuid and geteuid have no preconditions.
        Ok(unsafe { libc::getuid() == 0 || libc::geteuid() == 0 })
    }

    pub fn harden_dll_search() -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_elevated_or_root_process_is_refused() {
        assert_eq!(privilege_refusal(false), None);
        let refusal = privilege_refusal(true).expect("refused");
        assert!(refusal.contains("does not run"), "{refusal}");
    }

    #[test]
    fn this_process_can_tell_whether_it_is_elevated() {
        // Elevated, as GitHub's Windows runners run every step, the process tests skip themselves.
        let elevated = is_elevated().expect("the token can be read");
        assert!(privilege_refusal(elevated).is_some() == elevated);
    }
}
