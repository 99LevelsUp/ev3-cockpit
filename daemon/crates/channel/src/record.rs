//! `channel.json`, the record of where the daemon listens: `{"path": ..., "pid": ...}`.
//!
//! Only the daemon holding the channel's lock writes it (`ev3_cockpitd::channel::record_text`);
//! clients read it and connect only to the path it names, never to a name they compute.

/// A usable channel record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelRecord {
    /// The full named pipe path on Windows, the full socket path on Linux and macOS.
    pub path: String,
    /// The daemon's process id.
    pub pid: u32,
}

/// The record in `text`, or `None` when it is not a usable one. Unknown properties are ignored.
pub fn parse_record(text: &str) -> Option<ChannelRecord> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let path = object.get("path")?.as_str().filter(|p| !p.is_empty())?;
    let pid = object.get("pid")?.as_u64().filter(|&pid| pid > 0)?;
    Some(ChannelRecord {
        path: path.to_owned(),
        pid: u32::try_from(pid).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_record_with_a_path_and_a_positive_pid_is_usable() {
        assert_eq!(
            parse_record(r#"{"path":"\\\\.\\pipe\\ev3-cockpit-0f","pid":4242,"more":1}"#),
            Some(ChannelRecord {
                path: r"\\.\pipe\ev3-cockpit-0f".into(),
                pid: 4242
            })
        );
        for text in [
            "",
            "[]",
            r#"{"path":"","pid":1}"#,
            r#"{"path":"x","pid":0}"#,
            r#"{"path":"x","pid":-1}"#,
            r#"{"path":"x","pid":1.5}"#,
            r#"{"path":"x"}"#,
            r#"{"pid":1}"#,
        ] {
            assert_eq!(parse_record(text), None, "{text}");
        }
    }
}
