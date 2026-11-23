//! `ev3`: every cockpit operation from a terminal or a script, and `ev3 mcp`, the MCP server for
//! agents, through the user's cockpit daemon, which it starts when none runs.
//!
//! ```text
//! ev3 [--json] [--brick <brick>] <command> [arguments]
//! ```
//!
//! `--json` prints the result for programs; the exit code says how the command ended (see
//! `output.rs`, and `ev3 help`). A command that is not built in runs the add-on `ev3-<command>`
//! found on PATH.

mod addons;
mod clock;
mod commands;
mod confirm;
mod error;
mod install;
mod mcp;
mod output;
mod telemetry;

use std::collections::HashSet;
use std::process::ExitCode;

use commands::{COMMANDS, Ctx};
use error::{CliError, Result, exit};
use output::{EXIT_CODE_HELP, print_error, print_result, say};

#[derive(Debug, Default, PartialEq, Eq)]
struct Parsed {
    json: bool,
    help: bool,
    version: bool,
    brick: Option<String>,
    command: Option<String>,
    /// For an add-on: everything after its name, untouched.
    rest: Vec<String>,
    args: Vec<String>,
    flags: HashSet<String>,
}

fn parse(argv: &[String]) -> Result<Parsed> {
    let mut parsed = Parsed::default();
    let mut command: Option<&commands::Spec> = None;
    let mut options_done = false;
    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        let is_option = !options_done
            && token.starts_with('-')
            && token != "-"
            && !token[1..].starts_with(|c: char| c.is_ascii_digit());
        if !is_option {
            if parsed.command.is_none() {
                parsed.command = Some(token.clone());
                command = commands::spec(token);
                if command.is_none() && token != "help" {
                    parsed.rest = argv[i + 1..].to_vec();
                    return Ok(parsed);
                }
            } else {
                parsed.args.push(token.clone());
            }
            i += 1;
            continue;
        }
        match token.as_str() {
            "--" => options_done = true,
            "--json" => parsed.json = true,
            "-h" | "--help" => parsed.help = true,
            "--version" => parsed.version = true,
            _ if token == "--brick" || token.starts_with("--brick=") => {
                parsed.brick = Some(match token.split_once('=') {
                    Some((_, value)) => value.to_owned(),
                    None => {
                        i += 1;
                        argv.get(i)
                            .cloned()
                            .ok_or_else(|| CliError::usage("--brick needs a value."))?
                    }
                });
            }
            _ => {
                let flag = if token == "-r" {
                    Some("recursive")
                } else {
                    token.strip_prefix("--")
                };
                match (command, flag) {
                    (Some(spec), Some(flag)) if spec.flags.contains(&flag) => {
                        parsed.flags.insert(flag.to_owned());
                    }
                    _ => {
                        let after = parsed
                            .command
                            .as_ref()
                            .map(|c| format!(" for ev3 {c}"))
                            .unwrap_or_default();
                        return Err(CliError::usage(format!("Unknown option {token}{after}.")));
                    }
                }
            }
        }
        i += 1;
    }
    Ok(parsed)
}

fn help_text() -> Vec<String> {
    let width = COMMANDS.iter().map(|c| c.usage.len()).max().unwrap_or(0);
    let mut lines = vec![
        "Usage: ev3 [--json] [--brick <brick>] <command> [arguments]".to_owned(),
        "       ev3 --version".to_owned(),
        String::new(),
    ];
    lines.extend(
        COMMANDS
            .iter()
            .map(|c| format!("  {:width$}  {}", c.usage, c.summary)),
    );
    lines.push(String::new());
    lines.push("A brick is named by its name or its id. With none named and exactly one brick connected, that one is used.".into());
    lines.push("What needs a person's yes (forget, bt-clear, access mode full, daemon restart) is asked here when this is an".into());
    lines.push("interactive terminal; elsewhere it is refused.".into());
    lines.push("ev3 <name> runs the add-on ev3-<name> found on PATH.".into());
    lines.extend(EXIT_CODE_HELP.iter().map(|l| (*l).to_owned()));
    lines
}

async fn run(argv: Vec<String>) -> u8 {
    let parsed = match parse(&argv) {
        Ok(parsed) => parsed,
        Err(error) => return print_error(argv.iter().any(|a| a == "--json"), &error),
    };
    let json = parsed.json;
    if parsed.version {
        say(install::VERSION);
        return exit::OK;
    }
    let Some(name) = parsed
        .command
        .clone()
        .filter(|c| c != "help" && !parsed.help)
    else {
        let spec = parsed.command.as_deref().and_then(commands::spec);
        match spec {
            Some(spec) => {
                say(&format!("Usage: {}\n{}", spec.usage, spec.summary));
            }
            None => {
                let _ = help_text().iter().all(|l| say(l));
            }
        }
        return if parsed.command.is_none() && !parsed.help {
            exit::USAGE
        } else {
            exit::OK
        };
    };
    let Some(spec) = commands::spec(&name) else {
        return match addons::find(&name) {
            Ok(Some(addon)) => addons::run(&addon, &parsed.rest),
            Ok(None) => print_error(
                json,
                &CliError::usage(format!(
                    "There is no command {name}, and no add-on ev3-{name} on PATH."
                )),
            ),
            Err(error) => print_error(json, &error),
        };
    };
    let channel = match install::channel() {
        Ok(channel) => channel,
        Err(error) => return print_error(json, &error),
    };
    let paths = match install::paths(channel.as_deref()) {
        Ok(paths) => paths,
        Err(error) => return print_error(json, &error),
    };
    if name == "mcp" {
        return mcp::serve(paths).await;
    }
    let mut ctx = Ctx::new(json, parsed.brick, parsed.args, parsed.flags, paths, spec);
    let code = match commands::run(&name, &mut ctx).await {
        Ok(outcome) => {
            print_result(json, &outcome);
            outcome.exit_code
        }
        Err(error) => print_error(json, &error),
    };
    ctx.close().await;
    code
}

fn main() -> ExitCode {
    // Run-time DLL loads from System32 only, as the daemon does; the static imports are restricted
    // the same way by the link flag in build.rs.
    let _ = ev3_channel::security::harden_dll_search();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("ev3: {error}");
            return ExitCode::from(exit::FAILURE);
        }
    };
    let code = runtime.block_on(run(argv));
    // Background tasks (a blocked stdin read for a question) must not keep the process alive.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    ExitCode::from(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn options_go_anywhere_and_flags_belong_to_their_command() {
        let parsed = parse(&args("--json rm -r /x --brick=CCC")).expect("parsed");
        assert!(parsed.json);
        assert_eq!(parsed.command.as_deref(), Some("rm"));
        assert_eq!(parsed.args, vec!["/x"]);
        assert!(parsed.flags.contains("recursive"));
        assert_eq!(parsed.brick.as_deref(), Some("CCC"));
        assert!(matches!(
            parse(&args("ls --recursive")),
            Err(CliError::Usage(_))
        ));
        assert!(matches!(parse(&args("--bogus")), Err(CliError::Usage(_))));
        assert!(matches!(
            parse(&args("ls --brick")),
            Err(CliError::Usage(_))
        ));
    }

    #[test]
    fn an_unknown_command_keeps_its_arguments_for_the_add_on() {
        let parsed = parse(&args("--json eve --x -y 1")).expect("parsed");
        assert_eq!(parsed.command.as_deref(), Some("eve"));
        assert_eq!(parsed.rest, vec!["--x", "-y", "1"]);
    }

    #[test]
    fn a_negative_number_and_a_dash_are_arguments() {
        let parsed = parse(&args("config set x -5")).expect("parsed");
        assert_eq!(parsed.args, vec!["set", "x", "-5"]);
    }
}
