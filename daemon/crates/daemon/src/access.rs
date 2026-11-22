//! The access mode: in `safe`, the default, a client writes, deletes and runs only in the user
//! areas (the brick's projects folder and the SD card) and reads everywhere; the shell needs
//! `full`, which only a person can switch on.
//!
//! A guardrail against mistakes, not a sandbox: a program run in safe mode can do anything on the
//! brick, and paths are checked as written; a link inside a user area that points outside it is
//! not resolved.

use ev3_contract::{AccessMode, ContractError, ErrorCode};

/// What a client wants to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Read,
    Write,
    Delete,
    Run,
    Shell,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Delete => "delete",
            Self::Run => "run",
            Self::Shell => "shell",
        }
    }
}

/// Where safe mode lets a client change things.
pub const USER_AREAS: [&str; 2] = ["/home/root/lms2012/prjs", "/media/card"];

/// The brick VM's working folder: the brick resolves a relative path from here (`../prjs/…`).
const VM_FOLDER: &str = "/home/root/lms2012/sys";

/// A brick path made absolute, `.` and `..` resolved, without a trailing slash.
pub fn normalise_brick_path(path: &str) -> String {
    let full = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{VM_FOLDER}/{path}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in full.split('/') {
        match part {
            ".." => {
                parts.pop();
            }
            "" | "." => {}
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Whether a brick path carries a control character. The brick reads a path as a C string, so a
/// NUL ends it there: the check would judge the whole path and the brick act on its first part.
pub fn has_control_character(path: &str) -> bool {
    path.chars().any(char::is_control)
}

/// Whether `mode` allows `operation` on `path` (no path for the shell). A path with a control
/// character is allowed in no mode.
pub fn is_allowed(mode: AccessMode, operation: Operation, path: Option<&str>) -> bool {
    if path.is_some_and(has_control_character) {
        return false;
    }
    if mode == AccessMode::Full || operation == Operation::Read {
        return true;
    }
    let Some(path) = path.filter(|_| operation != Operation::Shell) else {
        return false;
    };
    let target = normalise_brick_path(path);
    USER_AREAS
        .iter()
        .any(|area| target.starts_with(&format!("{area}/")))
}

/// Refuses with `invalid_request` a path with a control character, and with `access_denied`
/// what `mode` does not allow.
pub fn check(
    mode: AccessMode,
    operation: Operation,
    path: Option<&str>,
) -> Result<(), ContractError> {
    if path.is_some_and(has_control_character) {
        return Err(ContractError::new(
            ErrorCode::InvalidRequest,
            "The brick path contains a control character. The brick would cut the path there \
             and act on another file than the one named, so the cockpit refuses it.",
        ));
    }
    if is_allowed(mode, operation, path) {
        return Ok(());
    }
    let what = if operation == Operation::Shell {
        "running a shell command".to_owned()
    } else {
        format!("{} of {}", operation.name(), path.unwrap_or("(no path)"))
    };
    let mut error = ContractError::new(
        ErrorCode::AccessDenied,
        format!(
            "The cockpit is in safe mode, which does not allow {what}: safe mode changes only {}, \
             and the shell needs full mode, which only a person can switch on: run ev3 config set \
             access-mode full in a terminal, or use EVƎ: Settings in VS Code.",
            USER_AREAS.join(" and ")
        ),
    );
    error.data.command = Some("ev3 config set access-mode full".into());
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_mode_changes_only_the_user_areas_and_reads_everywhere() {
        let safe = AccessMode::Safe;
        assert!(is_allowed(
            safe,
            Operation::Write,
            Some("/home/root/lms2012/prjs/a/b.rbf")
        ));
        assert!(is_allowed(safe, Operation::Delete, Some("/media/card/x")));
        assert!(is_allowed(safe, Operation::Run, Some("../prjs/a/b.rbf")));
        assert!(!is_allowed(
            safe,
            Operation::Write,
            Some("/home/root/lms2012/prjs")
        ));
        assert!(!is_allowed(
            safe,
            Operation::Delete,
            Some("/home/root/lms2012/prjs/../sys/ui")
        ));
        assert!(!is_allowed(safe, Operation::Write, Some("/etc/passwd")));
        assert!(!is_allowed(
            safe,
            Operation::Write,
            Some("/home/root/lms2012/prjsx/a")
        ));
        assert!(is_allowed(safe, Operation::Read, Some("/etc/passwd")));
        assert!(!is_allowed(safe, Operation::Shell, None));
        assert!(is_allowed(AccessMode::Full, Operation::Shell, None));
        assert!(is_allowed(
            AccessMode::Full,
            Operation::Delete,
            Some("/etc")
        ));
    }

    #[test]
    fn a_path_with_a_nul_or_another_control_character_is_allowed_in_no_mode() {
        // The brick would read ".../sys/ui" from this C string, while the dots after the NUL
        // normalise into the projects folder.
        let cut = "/home/root/lms2012/sys/ui\u{0}/../../prjs/a";
        assert!(!is_allowed(AccessMode::Safe, Operation::Write, Some(cut)));
        assert!(!is_allowed(AccessMode::Safe, Operation::Delete, Some(cut)));
        assert!(!is_allowed(AccessMode::Safe, Operation::Run, Some(cut)));
        assert!(!is_allowed(AccessMode::Safe, Operation::Read, Some(cut)));
        assert!(!is_allowed(AccessMode::Full, Operation::Write, Some(cut)));
        assert!(!is_allowed(
            AccessMode::Safe,
            Operation::Write,
            Some("/home/root/lms2012/prjs/a\nb")
        ));
        let error = check(AccessMode::Full, Operation::Write, Some(cut)).unwrap_err();
        assert_eq!(error.data.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn a_refusal_is_access_denied_naming_the_person_command() {
        let error = check(AccessMode::Safe, Operation::Shell, None).unwrap_err();
        assert_eq!(error.data.code, ErrorCode::AccessDenied);
        assert!(error.message.contains("running a shell command"));
        assert_eq!(
            error.data.command.as_deref(),
            Some("ev3 config set access-mode full")
        );
    }
}
