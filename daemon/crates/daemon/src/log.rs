//! The daemon's log file: one line per event, with the time, the level and, when a client caused
//! it, the client's name. It rotates by size, 5 MB per file, three files kept: `daemon.log` the
//! newest, then `daemon.log.1` and `daemon.log.2`.
//!
//! A log that cannot be written never stops the daemon.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Bytes per log file before it rotates.
pub const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Files kept, the current one included.
pub const LOG_FILES: u32 = 3;

/// How serious a line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn word(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

struct Inner {
    file: Option<File>,
    size: u64,
}

/// The log.
pub struct Log {
    path: PathBuf,
    max_bytes: u64,
    files: u32,
    inner: Mutex<Inner>,
}

impl Log {
    /// The log at `path`, rotating at [`LOG_MAX_BYTES`] and keeping [`LOG_FILES`].
    pub fn open(path: &Path) -> Self {
        Self::with_limits(path, LOG_MAX_BYTES, LOG_FILES)
    }

    /// The log at `path` with other limits, for tests.
    pub fn with_limits(path: &Path, max_bytes: u64, files: u32) -> Self {
        let (file, size) = open_append(path);
        Self {
            path: path.to_path_buf(),
            max_bytes,
            files: files.max(1),
            inner: Mutex::new(Inner { file, size }),
        }
    }

    /// The current log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes one line. A client's name and the message are the client's own text in part, so a
    /// line break or another control character in them is written escaped: no client writes a line
    /// of the log that seems to come from the daemon.
    pub fn write(&self, level: Level, client: Option<&str>, message: &str) {
        let who = client
            .map(|c| format!(" [{}]", one_line(c)))
            .unwrap_or_default();
        let line = format!(
            "{} {}{who} {}\n",
            timestamp(SystemTime::now()),
            level.word(),
            one_line(message)
        );
        let bytes = line.len() as u64;
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.size > 0 && inner.size + bytes > self.max_bytes {
            inner.file = None;
            self.rotate();
            let (file, size) = open_append(&self.path);
            inner.file = file;
            inner.size = size;
        }
        if let Some(file) = inner.file.as_mut()
            && file.write_all(line.as_bytes()).is_ok()
        {
            inner.size += bytes;
        }
    }

    pub fn info(&self, message: &str) {
        self.write(Level::Info, None, message);
    }

    pub fn warn(&self, message: &str) {
        self.write(Level::Warn, None, message);
    }

    pub fn error(&self, message: &str) {
        self.write(Level::Error, None, message);
    }

    fn rotate(&self) {
        let name = |i: u32| {
            if i == 0 {
                self.path.clone()
            } else {
                PathBuf::from(format!("{}.{i}", self.path.display()))
            }
        };
        let _ = std::fs::remove_file(name(self.files - 1));
        for i in (1..self.files).rev() {
            let _ = std::fs::rename(name(i - 1), name(i));
        }
        if self.files == 1 {
            let _ = std::fs::remove_file(name(0));
        }
    }
}

fn open_append(path: &Path) -> (Option<File>, u64) {
    if let Some(dir) = path.parent() {
        let _ = crate::fsutil::create_private_dir_all(dir);
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(file) => {
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            (Some(file), size)
        }
        Err(_) => (None, 0),
    }
}

/// `2026-11-21T09:30:00.123Z`.
pub fn timestamp(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = ev3_channel::civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// Text for one log line: a line break as `\n`, a carriage return as `\r`, any other control
/// character but a tab as `\u{..}`.
fn one_line(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.chars().any(|c| c.is_control() && c != '\t') {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push('\t'),
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", u32::from(c))),
            c => out.push(c),
        }
    }
    std::borrow::Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_line_break_in_a_client_name_or_message_cannot_forge_a_log_line() {
        assert_eq!(one_line("EVƎ C (VS Code)"), "EVƎ C (VS Code)");
        assert_eq!(
            one_line("x\n2026-11-22T00:00:00.000Z ERROR forged\r"),
            "x\\n2026-11-22T00:00:00.000Z ERROR forged\\r"
        );
        assert_eq!(one_line("a\u{1b}[31mb\tc"), "a\\u{1b}[31mb\tc");

        let dir = std::env::temp_dir().join(format!(
            "ev3d-log-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let log = Log::open(&dir.join("daemon.log"));
        log.write(
            Level::Info,
            Some("evil\nINFO [daemon] fake"),
            "Connected.\nERROR fake",
        );
        let text = std::fs::read_to_string(dir.join("daemon.log")).expect("log");
        assert_eq!(text.lines().count(), 1, "{text}");
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn timestamps_are_utc_iso_8601() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let time = UNIX_EPOCH + Duration::from_millis(1_795_253_400_123);
        assert_eq!(timestamp(time), "2026-11-21T09:30:00.123Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(timestamp(leap), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_log_rotates_by_size_and_keeps_three_files() {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-log-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        let path = dir.join("daemon.log");
        let log = Log::with_limits(&path, 200, 3);
        for i in 0..40 {
            log.write(
                Level::Info,
                Some("cli"),
                &format!("line {i:02} with some padding text"),
            );
        }
        let rotated = |i: u32| PathBuf::from(format!("{}.{i}", path.display()));
        assert!(path.exists() && rotated(1).exists() && rotated(2).exists());
        assert!(!rotated(3).exists());
        for file in [path.clone(), rotated(1), rotated(2)] {
            let size = std::fs::metadata(&file).expect("stat").len();
            assert!(size <= 200, "{} has {size} bytes", file.display());
        }
        let newest = std::fs::read_to_string(&path).expect("read");
        assert!(newest.contains("line 39"), "{newest}");
        assert!(newest.contains("INFO [cli] line"), "{newest}");
        drop(log);
        std::fs::remove_dir_all(dir).expect("clean");
    }
}
