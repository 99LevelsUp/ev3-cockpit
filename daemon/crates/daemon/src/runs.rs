//! The number of the last start the daemon sent to each brick (`runSeq`), kept in `runs.json` in
//! the channel's directory so a daemon that replaces another counts on instead of from 0: a higher
//! `runSeq` is a later run, across daemons too.
//!
//! Each start takes its number and writes it before the start goes to the brick, so a daemon that
//! ends right after sending a start never leaves its successor a number already used. A file that
//! cannot be written is said in the log and the count goes on in memory. At the start a missing
//! file counts from 0; a damaged one is moved aside, said in the log, and counting starts from 0.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// `runs.json`: the last `runSeq` per brick id.
#[derive(Debug, Default, Serialize, Deserialize)]
struct RunsFile {
    bricks: BTreeMap<String, u64>,
}

/// Every brick's last `runSeq`.
pub struct RunSeqs {
    /// Where the numbers are written; `None` keeps them in memory only.
    file: Option<PathBuf>,
    /// Held while a number is taken and written, so the file is written in the order the numbers
    /// were taken.
    seqs: Mutex<BTreeMap<String, u64>>,
}

impl RunSeqs {
    /// The numbers kept at `file`; what kept them from being read goes to `warn`.
    pub fn open(file: Option<PathBuf>, warn: impl FnOnce(String)) -> Self {
        let seqs = file.as_deref().map(|f| read(f, warn)).unwrap_or_default();
        Self {
            file,
            seqs: Mutex::new(seqs),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, u64>> {
        self.seqs.lock().expect("runs lock")
    }

    /// The number of the last start sent to the brick; 0 before any.
    pub fn last(&self, brick_id: &str) -> u64 {
        self.lock().get(brick_id).copied().unwrap_or(0)
    }

    /// Takes the brick's next number and writes it. The number is taken even when the write
    /// fails; the error says why the next daemon may not know it.
    pub fn next(&self, brick_id: &str) -> (u64, Result<(), String>) {
        let mut seqs = self.lock();
        let seq = seqs.entry(brick_id.to_owned()).or_insert(0);
        *seq += 1;
        let seq = *seq;
        let Some(file) = &self.file else {
            return (seq, Ok(()));
        };
        let written = serde_json::to_string_pretty(&RunsFile {
            bricks: seqs.clone(),
        })
        .map_err(|e| e.to_string())
        .and_then(|mut text| {
            text.push('\n');
            crate::fsutil::write_atomic(file, text.as_bytes()).map_err(|e| e.to_string())
        })
        .map_err(|error| {
            format!(
                "The program start numbers could not be written to {} ({error}); a daemon that \
                 replaces this one may count from an older number.",
                file.display()
            )
        });
        (seq, written)
    }
}

/// The numbers in `file`: none when it is missing; when it cannot be read, none, with a warning,
/// and a damaged file is moved aside first so the next write does not hide it.
fn read(file: &Path, warn: impl FnOnce(String)) -> BTreeMap<String, u64> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(error) => {
            warn(format!(
                "The program start numbers in {} could not be read ({error}); every brick counts \
                 from 0.",
                file.display()
            ));
            return BTreeMap::new();
        }
    };
    match serde_json::from_str::<RunsFile>(&text) {
        Ok(runs) => runs.bricks,
        Err(error) => {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            let aside = PathBuf::from(format!("{}.damaged-{millis}", file.display()));
            let moved = match std::fs::rename(file, &aside) {
                Ok(()) => format!("it was moved to {}", aside.display()),
                Err(e) => format!("it could not be moved aside ({e})"),
            };
            warn(format!(
                "The program start numbers in {} could not be read ({error}); {moved}. Every \
                 brick counts from 0.",
                file.display()
            ));
            BTreeMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-runs-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_file_counts_from_zero_without_a_warning() {
        let dir = temp_dir();
        let runs = RunSeqs::open(Some(dir.join("runs.json")), |w| panic!("{w}"));
        assert_eq!(runs.last("001653F00A0A"), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn each_number_is_written_and_the_next_store_counts_on() {
        let dir = temp_dir();
        let file = dir.join("runs.json");
        let runs = RunSeqs::open(Some(file.clone()), |w| panic!("{w}"));
        assert_eq!(runs.next("001653F00A0A").0, 1);
        assert_eq!(runs.next("001653F00A0A").0, 2);
        assert_eq!(runs.next("001653F00B0B").0, 1);
        let again = RunSeqs::open(Some(file), |w| panic!("{w}"));
        assert_eq!(again.last("001653F00A0A"), 2);
        assert_eq!(again.last("001653F00B0B"), 1);
        assert_eq!(again.next("001653F00A0A"), (3, Ok(())));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_file_is_moved_aside_said_and_counting_starts_from_zero() {
        let dir = temp_dir();
        let file = dir.join("runs.json");
        std::fs::write(&file, "{ not json").unwrap();
        let mut warned = Vec::new();
        let runs = RunSeqs::open(Some(file.clone()), |w| warned.push(w));
        assert_eq!(warned.len(), 1, "{warned:?}");
        assert_eq!(runs.last("001653F00A0A"), 0);
        let aside: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("runs.json.damaged-"))
            .collect();
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert_eq!(runs.next("001653F00A0A").0, 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_number_is_taken_even_when_it_cannot_be_written() {
        let dir = temp_dir();
        // A directory where the file should be: the rename onto it fails.
        let file = dir.join("runs.json");
        std::fs::create_dir_all(file.join("in-the-way")).unwrap();
        let runs = RunSeqs::open(Some(file), |_| {});
        let (seq, written) = runs.next("001653F00A0A");
        assert_eq!(seq, 1);
        assert!(written.is_err());
        assert_eq!(runs.last("001653F00A0A"), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
