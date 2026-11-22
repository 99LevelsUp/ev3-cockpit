//! The command line.
//!
//! ```text
//! ev3-cockpitd [--channel <name> [--state-root <dir>] [--report-release]
//!                [--fixtures <dir> [--replay matched|strict]]
//!                [--record-dir <dir> [--transports usb,bt,tcp]]]
//!              [--mode hardware|record|replay]
//! ```
//!
//! Without `--channel` the daemon serves the user's own channel. `--channel` names a test channel:
//! its files live in `channels/<name>/` under the state root, and it opens real hardware only to
//! record. `--state-root` replaces the state root, and is accepted only together with a test
//! channel, so a test run can keep its key and state away from the user's. `--fixtures` names the
//! directory of a recording a test channel replays; without it a replay daemon has no brick.
//! `--replay` says how: `matched` (the default) answers each request with the recorded answer to
//! an equal one, `strict` wants every recorded call in its recorded order. `--mode` defaults to
//! `hardware` on the user's channel and `replay` on a test channel; a mode the channel must not
//! run is refused. `--mode record` runs a test channel on the real providers, each wrapped by the
//! recorder, which writes into `--record-dir`, a new directory the daemon creates for the user
//! alone; `--transports` limits the providers it records. `--report-release` exists only in
//! development builds: on a test channel it makes the daemon report itself as a release build, so
//! a test meets a release daemon without a second build. A release build does not know the
//! argument, so nothing makes it report development.

use std::ffi::OsString;
use std::path::PathBuf;

use ev3_transports::{ChannelKind, DaemonMode, ProviderSource, Transport, provider_source};

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// A test channel's name; `None` for the user's own channel.
    pub channel: Option<String>,
    /// A state root to use instead of the platform's, for a test channel only.
    pub state_root: Option<PathBuf>,
    /// The mode asked for, if any.
    pub mode: Option<DaemonMode>,
    /// The recording a test channel replays.
    pub fixtures: Option<PathBuf>,
    /// Replay wants every recorded call in its recorded order, not just an answer to each request.
    pub strict_replay: bool,
    /// The new directory a recording goes into.
    pub record_dir: Option<PathBuf>,
    /// The transports a recording uses; `None` for every one the platform has.
    pub record_transports: Option<Vec<Transport>>,
    /// A development build on a test channel reports itself as a release build. Always `false` in
    /// a release build, which does not know the argument.
    pub report_release: bool,
}

pub use ev3_channel::paths::valid_channel_name;

/// The usage line, for an error message.
pub const USAGE: &str = "usage: ev3-cockpitd [--channel <name> [--state-root <dir>] [--fixtures <dir> [--replay matched|strict]] [--record-dir <dir> [--transports usb,bt,tcp]]] [--mode hardware|record|replay]";

impl Options {
    /// The build kind this command line has the daemon report.
    pub fn build_kind(&self) -> ev3_contract::BuildKind {
        crate::build_info::reported_build_kind(self.report_release)
    }
}

/// Reads the arguments after the program name.
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Options, String> {
    let mut options = Options {
        channel: None,
        state_root: None,
        mode: None,
        fixtures: None,
        strict_replay: false,
        record_dir: None,
        record_transports: None,
        report_release: false,
    };
    let mut replay_named = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let arg = arg
            .into_string()
            .map_err(|_| "An argument is not valid text.".to_string())?;
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value."));
        match arg.as_str() {
            "--channel" => {
                let name = value("--channel")?
                    .into_string()
                    .map_err(|_| "The channel name is not valid text.".to_string())?;
                if !valid_channel_name(&name) {
                    return Err(format!(
                        "\"{name}\" is not a usable channel name: use lowercase letters, digits and dashes, at most 32."
                    ));
                }
                options.channel = Some(name);
            }
            "--state-root" => {
                let root = PathBuf::from(value("--state-root")?);
                if !root.is_absolute() {
                    return Err(format!(
                        "The state root {} is not an absolute path.",
                        root.display()
                    ));
                }
                options.state_root = Some(root);
            }
            "--fixtures" => {
                let dir = PathBuf::from(value("--fixtures")?);
                if !dir.is_absolute() {
                    return Err(format!(
                        "The fixtures directory {} is not an absolute path.",
                        dir.display()
                    ));
                }
                options.fixtures = Some(dir);
            }
            "--replay" => {
                let how = value("--replay")?;
                options.strict_replay = match how.to_str() {
                    Some("matched") => false,
                    Some("strict") => true,
                    _ => {
                        return Err(format!(
                            "{} is not a way to replay: use matched or strict.",
                            how.to_string_lossy()
                        ));
                    }
                };
                replay_named = true;
            }
            "--record-dir" => {
                let dir = PathBuf::from(value("--record-dir")?);
                if !dir.is_absolute() {
                    return Err(format!(
                        "The recording directory {} is not an absolute path.",
                        dir.display()
                    ));
                }
                options.record_dir = Some(dir);
            }
            "--transports" => {
                let list = value("--transports")?;
                let list = list
                    .to_str()
                    .ok_or_else(|| "The transports are not valid text.".to_string())?;
                let mut transports = Vec::new();
                for name in list.split(',') {
                    match Transport::parse(name.trim()) {
                        Some(t) if t != Transport::Mock => {
                            if !transports.contains(&t) {
                                transports.push(t);
                            }
                        }
                        _ => {
                            return Err(format!(
                                "{name} is not a transport to record: use usb, bt or tcp."
                            ));
                        }
                    }
                }
                options.record_transports = Some(transports);
            }
            "--mode" => {
                let mode = value("--mode")?;
                options.mode = Some(match mode.to_str() {
                    Some("hardware") => DaemonMode::Hardware,
                    Some("record") => DaemonMode::Record,
                    Some("replay") => DaemonMode::Replay,
                    _ => {
                        return Err(format!(
                            "{} is not a mode: use hardware, record or replay.",
                            mode.to_string_lossy()
                        ));
                    }
                });
            }
            // Compiled into development builds only: a release build reads it as unknown.
            #[cfg(not(ev3_release_build))]
            "--report-release" => options.report_release = true,
            other => return Err(format!("{other} is not an argument the daemon knows.")),
        }
    }
    if options.report_release && options.channel.is_none() {
        return Err(
            "--report-release is accepted only together with --channel: on the user's channel a development daemon always says it is one."
                .into(),
        );
    }
    if options.state_root.is_some() && options.channel.is_none() {
        return Err(
            "--state-root is accepted only together with --channel: the user's channel always lives in the platform's state directory."
                .into(),
        );
    }
    if options.fixtures.is_some() && options.mode() != DaemonMode::Replay {
        return Err(
            "--fixtures is accepted only on a test channel in replay mode: a recording never stands in for the user's bricks."
                .into(),
        );
    }
    if replay_named && options.fixtures.is_none() {
        return Err("--replay is accepted only together with --fixtures.".into());
    }
    let recording = options.channel.is_some() && options.mode() == DaemonMode::Record;
    if options.record_dir.is_some() != recording {
        return Err(
            "--record-dir goes with --mode record on a test channel, and recording needs it: name a new directory for the recording."
                .into(),
        );
    }
    if options.record_transports.is_some() && !recording {
        return Err("--transports is accepted only with --mode record on a test channel.".into());
    }
    Ok(options)
}

impl Options {
    /// The mode to run in: the one asked for, else the channel's default.
    pub fn mode(&self) -> DaemonMode {
        self.mode.unwrap_or(if self.channel.is_some() {
            DaemonMode::Replay
        } else {
            DaemonMode::Hardware
        })
    }

    /// The providers this daemon may build, from its channel and mode, or why the two must not
    /// run together.
    ///
    /// The rule itself lives in `ev3_transports::provider_source`.
    pub fn provider_source(&self) -> Result<ProviderSource, String> {
        let channel = if self.channel.is_some() {
            ChannelKind::Test
        } else {
            ChannelKind::User
        };
        provider_source(channel, self.mode()).map_err(|error| error.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn channel_names_match_the_cross_language_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contract/vectors/channel.json"))
                .expect("vectors");
        for (key, valid) in [("valid", true), ("invalid", false)] {
            for name in vectors["channelName"][key].as_array().expect(key) {
                let name = name.as_str().expect("name");
                assert_eq!(valid_channel_name(name), valid, "{name:?}");
            }
        }
    }

    #[test]
    fn no_arguments_is_the_users_channel_on_hardware() {
        let options = parse(args(&[])).expect("parses");
        assert_eq!(options.channel, None);
        assert_eq!(options.mode(), DaemonMode::Hardware);
    }

    #[test]
    fn a_test_channel_runs_on_replay_by_default() {
        let root = if cfg!(windows) { "C:\\t" } else { "/t" };
        let options = parse(args(&["--channel", "ci-1", "--state-root", root])).expect("parses");
        assert_eq!(options.channel.as_deref(), Some("ci-1"));
        assert_eq!(options.state_root, Some(PathBuf::from(root)));
        assert_eq!(options.mode(), DaemonMode::Replay);
    }

    #[test]
    fn a_state_root_without_a_test_channel_is_refused() {
        let root = if cfg!(windows) { "C:\\t" } else { "/t" };
        let error = parse(args(&["--state-root", root])).expect_err("refused");
        assert!(error.contains("--channel"), "{error}");
    }

    #[test]
    fn a_channel_name_that_could_leave_its_directory_is_refused() {
        for name in ["", "..", "A", "-x", "a/b", "a\\b", &"a".repeat(33)] {
            assert!(!valid_channel_name(name), "{name:?}");
            assert!(parse(args(&["--channel", name])).is_err(), "{name:?}");
        }
        assert!(valid_channel_name("0"));
        assert!(valid_channel_name(&"a".repeat(32)));
    }

    #[test]
    fn fixtures_go_only_with_a_test_channel_in_replay() {
        let dir = if cfg!(windows) { "C:\\f" } else { "/f" };
        let options = parse(args(&["--channel", "t", "--fixtures", dir])).expect("parses");
        assert_eq!(options.fixtures, Some(PathBuf::from(dir)));
        assert!(parse(args(&["--fixtures", dir])).is_err());
        assert!(parse(args(&["--channel", "t", "--fixtures", "rel"])).is_err());
    }

    #[test]
    fn only_a_development_build_on_a_test_channel_may_report_a_release_build() {
        let options = parse(args(&["--channel", "t", "--report-release"]));
        if cfg!(ev3_release_build) {
            let error = options.expect_err("a release build does not know the argument");
            assert!(error.contains("--report-release"), "{error}");
        } else {
            let options = options.expect("parses");
            assert!(options.report_release);
            assert_eq!(options.build_kind(), ev3_contract::BuildKind::Release);
            let error = parse(args(&["--report-release"])).expect_err("not on the user's channel");
            assert!(error.contains("--channel"), "{error}");
        }
        let plain = parse(args(&["--channel", "t"])).expect("parses");
        assert_eq!(plain.build_kind(), crate::build_info::build_kind());
        // No spelling of the argument asks for a development build.
        for other in ["--report-development", "--build-kind", "--development"] {
            assert!(parse(args(&["--channel", "t", other])).is_err(), "{other}");
        }
    }

    #[test]
    fn the_users_channel_never_records() {
        let options = parse(args(&["--mode", "record"])).expect("parses");
        let error = options.provider_source().expect_err("refused");
        assert!(error.contains("never records"), "{error}");
        let dir = if cfg!(windows) { "C:\\r" } else { "/r" };
        assert!(parse(args(&["--mode", "record", "--record-dir", dir])).is_err());
        assert_eq!(
            parse(args(&[])).expect("parses").provider_source(),
            Ok(ProviderSource::Hardware { record: false })
        );
        assert!(
            parse(args(&["--mode", "replay"]))
                .expect("parses")
                .provider_source()
                .is_err()
        );
    }

    #[test]
    fn a_test_channel_opens_the_hardware_only_to_record_into_a_named_directory() {
        let dir = if cfg!(windows) { "C:\\r" } else { "/r" };
        let options = parse(args(&[
            "--channel",
            "t",
            "--mode",
            "record",
            "--record-dir",
            dir,
            "--transports",
            "usb,tcp,usb",
        ]))
        .expect("parses");
        assert_eq!(
            options.provider_source(),
            Ok(ProviderSource::Hardware { record: true })
        );
        assert_eq!(options.record_dir, Some(PathBuf::from(dir)));
        assert_eq!(
            options.record_transports,
            Some(vec![Transport::Usb, Transport::Tcp])
        );
        let error = parse(args(&["--channel", "t", "--mode", "record"])).expect_err("no dir");
        assert!(error.contains("--record-dir"), "{error}");
        assert!(
            parse(args(&[
                "--channel",
                "t",
                "--mode",
                "record",
                "--record-dir",
                "rel"
            ]))
            .is_err()
        );
        assert!(parse(args(&["--channel", "t", "--record-dir", dir])).is_err());
        assert!(parse(args(&["--channel", "t", "--transports", "usb"])).is_err());
        assert!(
            parse(args(&[
                "--channel",
                "t",
                "--mode",
                "record",
                "--record-dir",
                dir,
                "--transports",
                "mock",
            ]))
            .is_err()
        );
        assert!(
            parse(args(&["--channel", "t", "--mode", "hardware"]))
                .expect("parses")
                .provider_source()
                .is_err(),
            "a test channel never runs on the hardware unrecorded"
        );
        assert_eq!(
            parse(args(&["--channel", "t"]))
                .expect("parses")
                .provider_source(),
            Ok(ProviderSource::Replay)
        );
    }

    #[test]
    fn strict_replay_is_asked_for_together_with_fixtures() {
        let dir = if cfg!(windows) { "C:\\f" } else { "/f" };
        let options = parse(args(&[
            "--channel",
            "t",
            "--fixtures",
            dir,
            "--replay",
            "strict",
        ]))
        .expect("parses");
        assert!(options.strict_replay);
        let options = parse(args(&["--channel", "t", "--fixtures", dir])).expect("parses");
        assert!(!options.strict_replay, "matched by default");
        assert!(parse(args(&["--channel", "t", "--replay", "strict"])).is_err());
        assert!(
            parse(args(&[
                "--channel",
                "t",
                "--fixtures",
                dir,
                "--replay",
                "loose"
            ]))
            .is_err()
        );
    }

    #[test]
    fn a_relative_state_root_or_unknown_argument_is_refused() {
        assert!(parse(args(&["--channel", "t", "--state-root", "rel"])).is_err());
        assert!(parse(args(&["--verbose"])).is_err());
        assert!(parse(args(&["--mode", "fast"])).is_err());
    }
}
