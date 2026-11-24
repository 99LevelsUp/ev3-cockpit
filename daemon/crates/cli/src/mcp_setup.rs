//! `ev3 mcp setup` (#16): registers `ev3 mcp` as the MCP server `ev3` in the agent hosts installed
//! for this user, so "connect the cockpit's MCP" is one command an agent finds in `ev3 --help`.
//!
//! - The hosts are found on PATH as `ev3 <name>` finds add-ons (absolute folders only; on Windows
//!   an `.exe` or an npm `.cmd` shim): Claude Code (`claude`, user scope) and Codex (`codex`).
//! - The server is registered by the absolute path of the `ev3` running this command, with the
//!   argument `mcp`: no shell and no launcher shim between the host and the server, on Windows as
//!   on Linux. An installed cockpit registers its own binary; a development build its own.
//! - An entry `ev3` that runs this command already is left as it is. One that runs something else
//!   is left as it is too, and said, unless `--replace`. `--remove` takes the entries out.
//! - Each host is changed only through its own `mcp add`, `mcp get` and `mcp remove` commands.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

use crate::error::exit;
use crate::output::Outcome;

/// The name the cockpit's server has in every host.
pub const SERVER: &str = "ev3";

/// An agent host this command knows how to change.
#[derive(Clone, Copy)]
struct Host {
    name: &'static str,
    program: &'static str,
    kind: HostKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HostKind {
    Claude,
    Codex,
}

const HOSTS: [Host; 2] = [
    Host {
        name: "Claude Code",
        program: "claude",
        kind: HostKind::Claude,
    },
    Host {
        name: "Codex",
        program: "codex",
        kind: HostKind::Codex,
    },
];

/// What a host has registered as `ev3`.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    None,
    /// The command and its arguments, as one line.
    Some {
        command: String,
        args: Vec<String>,
    },
}

/// Runs `ev3 mcp setup` with its flags.
pub fn setup(remove: bool, replace: bool) -> Outcome {
    let exe = match this_exe() {
        Ok(exe) => exe,
        Err(why) => {
            return Outcome::new(json!({ "error": why }), format!("ev3 mcp setup: {why}"))
                .with_exit(exit::FAILURE);
        }
    };
    let command = exe.display().to_string();
    let mut results = Vec::new();
    let mut lines = Vec::new();
    let mut failed = false;
    for host in HOSTS {
        let (result, detail) = match find_program(host.program) {
            None => (
                "notInstalled",
                format!(
                    "{} is not installed (no {} on PATH).",
                    host.name, host.program
                ),
            ),
            Some(program) => match one_host(host, &program, &command, remove, replace) {
                Ok(done) => done,
                Err(why) => {
                    failed = true;
                    ("failed", format!("{}: {why}", host.name))
                }
            },
        };
        lines.push(detail.clone());
        results.push(json!({ "host": host.name, "result": result, "detail": detail }));
    }
    let value = json!({
        "server": SERVER, "command": command, "args": ["mcp"], "hosts": results,
    });
    let outcome = Outcome::new(value, lines);
    if failed {
        outcome.with_exit(exit::FAILURE)
    } else {
        outcome
    }
}

/// Does what was asked in one host; the result's name and what to tell the user.
fn one_host(
    host: Host,
    program: &Path,
    command: &str,
    remove: bool,
    replace: bool,
) -> Result<(&'static str, String), String> {
    let existing = get(host, program)?;
    let ours = |entry: &Entry| match entry {
        Entry::Some { command: c, args } => same_path(c, command) && args == &["mcp"],
        Entry::None => false,
    };
    if remove {
        return match existing {
            Entry::None => Ok((
                "notRegistered",
                format!("{} has no MCP server {SERVER}.", host.name),
            )),
            Entry::Some { .. } => {
                run(program, &remove_args(host))?;
                Ok((
                    "removed",
                    format!("Removed the MCP server {SERVER} from {}.", host.name),
                ))
            }
        };
    }
    match &existing {
        Entry::None => {
            run(program, &add_args(host, command))?;
            Ok((
                "added",
                format!(
                    "Added the MCP server {SERVER} to {}: {command} mcp.",
                    host.name
                ),
            ))
        }
        entry if ours(entry) => Ok((
            "already",
            format!("{} has the MCP server {SERVER} already.", host.name),
        )),
        Entry::Some {
            command: other,
            args,
        } => {
            let theirs = format!("{other} {}", args.join(" ")).trim().to_owned();
            if !replace {
                return Ok((
                    "leftAsItIs",
                    format!(
                        "{} has another MCP server {SERVER} ({theirs}); it was left as it is. ev3 mcp setup --replace replaces it.",
                        host.name
                    ),
                ));
            }
            run(program, &remove_args(host))?;
            run(program, &add_args(host, command))?;
            Ok((
                "replaced",
                format!(
                    "Replaced the MCP server {SERVER} in {} ({theirs}) with {command} mcp.",
                    host.name
                ),
            ))
        }
    }
}

fn add_args(host: Host, command: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["mcp".into(), "add".into()];
    if host.kind == HostKind::Claude {
        args.extend(["--scope".into(), "user".into()]);
    }
    args.extend([SERVER.into(), "--".into(), command.into(), "mcp".into()]);
    args
}

fn remove_args(host: Host) -> Vec<String> {
    let mut args: Vec<String> = vec!["mcp".into(), "remove".into(), SERVER.into()];
    if host.kind == HostKind::Claude {
        args.extend(["--scope".into(), "user".into()]);
    }
    args
}

/// What `host` has registered as `ev3`.
fn get(host: Host, program: &Path) -> Result<Entry, String> {
    let args: Vec<String> = match host.kind {
        HostKind::Claude => vec!["mcp".into(), "get".into(), SERVER.into()],
        HostKind::Codex => vec!["mcp".into(), "get".into(), "--json".into(), SERVER.into()],
    };
    let output = Command::new(program)
        .args(&args)
        .output()
        .map_err(|e| format!("{} could not start: {e}", program.display()))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        if text.contains("No MCP server named") {
            return Ok(Entry::None);
        }
        return Err(format!("mcp get {SERVER} failed: {}", text.trim()));
    }
    Ok(match host.kind {
        HostKind::Claude => parse_claude(&text),
        HostKind::Codex => parse_codex(&text),
    })
}

/// The command and arguments in `claude mcp get`'s answer (`Command:` and `Args:` lines).
fn parse_claude(text: &str) -> Entry {
    let field = |name: &str| {
        text.lines()
            .map(str::trim)
            .find_map(|l| l.strip_prefix(name))
            .map(|v| v.trim().to_owned())
    };
    Entry::Some {
        command: field("Command:").unwrap_or_default(),
        args: field("Args:")
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
    }
}

/// The command and arguments in `codex mcp get --json`'s answer.
fn parse_codex(text: &str) -> Entry {
    let value: Value = text
        .find('{')
        .and_then(|at| serde_json::from_str(&text[at..]).ok())
        .unwrap_or(Value::Null);
    let transport = &value["transport"];
    Entry::Some {
        command: transport["command"]
            .as_str()
            .or_else(|| transport["url"].as_str())
            .unwrap_or("")
            .to_owned(),
        args: transport["args"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    }
}

/// Runs a host command; its own message when it fails.
fn run(program: &Path, args: &[String]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{} could not start: {e}", program.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Err(format!(
        "{} {} failed: {}",
        program.display(),
        args.join(" "),
        text.trim()
    ))
}

/// Finds a host program on PATH, as add-ons are found.
fn find_program(program: &str) -> Option<PathBuf> {
    for dir in crate::addons::path_dirs() {
        #[cfg(windows)]
        for extension in ["exe", "cmd"] {
            let candidate = dir.join(format!("{program}.{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        #[cfg(unix)]
        {
            let candidate = dir.join(program);
            if crate::addons::is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// The `ev3` running this command, as a plain absolute path.
fn this_exe() -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("this program's path is unknown: {e}"))?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let text = exe.to_string_lossy();
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => exe,
    })
}

/// Whether two paths name the same file: by their letters, ignoring case on Windows.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_command_of_each_hosts_entry() {
        let claude = "ev3:\n  Scope: User config\n  Type: stdio\n  Command: C:\\x\\ev3.exe\n  Args: mcp\n  Environment:\n";
        assert_eq!(
            parse_claude(claude),
            Entry::Some {
                command: r"C:\x\ev3.exe".into(),
                args: vec!["mcp".into()]
            }
        );
        let codex = r#"{"name":"ev3","transport":{"type":"stdio","command":"/usr/bin/ev3","args":["mcp"]}}"#;
        assert_eq!(
            parse_codex(codex),
            Entry::Some {
                command: "/usr/bin/ev3".into(),
                args: vec!["mcp".into()]
            }
        );
    }

    #[test]
    fn claude_is_set_up_for_the_user_and_codex_as_it_has_no_scope() {
        assert_eq!(
            add_args(HOSTS[0], "/bin/ev3"),
            [
                "mcp", "add", "--scope", "user", "ev3", "--", "/bin/ev3", "mcp"
            ]
        );
        assert_eq!(
            add_args(HOSTS[1], "/bin/ev3"),
            ["mcp", "add", "ev3", "--", "/bin/ev3", "mcp"]
        );
        assert_eq!(
            remove_args(HOSTS[0]),
            ["mcp", "remove", "ev3", "--scope", "user"]
        );
    }
}
