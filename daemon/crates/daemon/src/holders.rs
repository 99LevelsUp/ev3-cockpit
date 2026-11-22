//! Who holds each brick. A brick stays connected while it has at least one holder: a client that
//! connected it, or the hold `ev3 connect` leaves. It is signed out when its last holder goes.
//! Each VS Code window is a holder of its own.
//!
//! A disconnect drops only the caller's hold; "for everyone" clears them all. The holds
//! `ev3 connect` leaves are the user's explicit intent: they keep the daemon alive with no client,
//! are written to `held.json` whenever they change, and the next daemon connects those bricks
//! again at its start.
//!
//! The sets never sign a brick out themselves: each change returns the bricks that lost their last
//! holder, and the caller signs them out.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use ev3_contract::{BrickHolder, BrickHolderKind};
use serde::{Deserialize, Serialize};

/// One holder of one brick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    /// A connected client, until it disconnects the brick or goes.
    Client { connection: u64, name: String },
    /// The hold `ev3 connect` leaves: past every client, and past the daemon.
    Hold,
}

impl Holder {
    fn to_contract(&self) -> BrickHolder {
        match self {
            Self::Client { name, .. } => BrickHolder {
                client: Some(name.clone()),
                kind: BrickHolderKind::Client,
            },
            Self::Hold => BrickHolder {
                client: None,
                kind: BrickHolderKind::Hold,
            },
        }
    }
}

/// How a holder is named in `stillHeldBy`.
pub fn holder_name(holder: &BrickHolder) -> String {
    match (&holder.kind, &holder.client) {
        (BrickHolderKind::Client, Some(name)) => name.clone(),
        (BrickHolderKind::Client, None) => "a client".into(),
        (BrickHolderKind::Hold, _) => "ev3 connect".into(),
        (BrickHolderKind::Remembered, _) => "remembered".into(),
    }
}

/// `held.json`: the bricks `ev3 connect` holds.
#[derive(Debug, Default, Serialize, Deserialize)]
struct HeldFile {
    bricks: Vec<String>,
}

/// Reads the bricks a previous daemon held; a missing file holds none, and an unreadable one is
/// reported through `warn` and holds none.
pub fn read_held(file: &Path, warn: impl FnOnce(String)) -> Vec<String> {
    match std::fs::read_to_string(file) {
        Ok(text) => match serde_json::from_str::<HeldFile>(&text) {
            Ok(held) => held.bricks,
            Err(error) => {
                warn(format!(
                    "The held bricks in {} could not be read ({error}); none are connected again.",
                    file.display()
                ));
                Vec::new()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            warn(format!(
                "The held bricks in {} could not be read ({error}); none are connected again.",
                file.display()
            ));
            Vec::new()
        }
    }
}

/// Every brick's holders.
pub struct HolderSets {
    sets: Mutex<BTreeMap<String, Vec<Holder>>>,
    /// Where the holds are written; `None` keeps them in memory only.
    file: Option<PathBuf>,
    /// The holds last written, so an unchanged set is not written again.
    written: Mutex<Option<Vec<String>>>,
}

impl HolderSets {
    pub fn new(file: Option<PathBuf>) -> Self {
        Self {
            sets: Mutex::new(BTreeMap::new()),
            file,
            written: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, Vec<Holder>>> {
        self.sets.lock().expect("holders lock")
    }

    /// Adds a holder; one hold per brick however many times it is added.
    pub fn add(&self, brick_id: &str, holder: Holder) -> Result<(), String> {
        {
            let mut sets = self.lock();
            let set = sets.entry(brick_id.to_owned()).or_default();
            if !set.contains(&holder) {
                set.push(holder);
            }
        }
        self.save()
    }

    /// Drops one holder; returns whether the brick lost its last holder and is to be signed out.
    pub fn drop_holder(&self, brick_id: &str, holder: &Holder) -> bool {
        let released = {
            let mut sets = self.lock();
            let Some(set) = sets.get_mut(brick_id) else {
                return false;
            };
            set.retain(|h| h != holder);
            let empty = set.is_empty();
            if empty {
                sets.remove(brick_id);
            }
            empty
        };
        let _ = self.save();
        released
    }

    /// Drops every holder of a brick; returns whether it had any.
    pub fn drop_all(&self, brick_id: &str) -> bool {
        let had = self.lock().remove(brick_id).is_some();
        let _ = self.save();
        had
    }

    /// A client left: every brick it held loses that hold; returns those it held alone.
    pub fn client_left(&self, connection: u64) -> Vec<String> {
        let released = {
            let mut sets = self.lock();
            let mut released = Vec::new();
            sets.retain(|brick, set| {
                let before = set.len();
                set.retain(
                    |h| !matches!(h, Holder::Client { connection: c, .. } if *c == connection),
                );
                if set.is_empty() && before > 0 {
                    released.push(brick.clone());
                    false
                } else {
                    true
                }
            });
            released
        };
        let _ = self.save();
        released
    }

    /// A brick went away by itself (forgotten): its holders go without a sign-out.
    pub fn forget(&self, brick_id: &str) {
        self.lock().remove(brick_id);
        let _ = self.save();
    }

    pub fn holders_of(&self, brick_id: &str) -> Vec<BrickHolder> {
        self.lock()
            .get(brick_id)
            .map(|set| set.iter().map(Holder::to_contract).collect())
            .unwrap_or_default()
    }

    pub fn is_held(&self, brick_id: &str) -> bool {
        self.lock().get(brick_id).is_some_and(|set| !set.is_empty())
    }

    /// The bricks `ev3 connect` holds: they keep the daemon alive with no client.
    pub fn holds(&self) -> Vec<String> {
        self.lock()
            .iter()
            .filter(|(_, set)| set.contains(&Holder::Hold))
            .map(|(brick, _)| brick.clone())
            .collect()
    }

    pub fn held_bricks(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// Writes the holds to `held.json` when they changed since the last write.
    fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let holds = self.holds();
        let mut written = self.written.lock().expect("held file lock");
        if written.as_ref() == Some(&holds) {
            return Ok(());
        }
        let mut text = serde_json::to_string_pretty(&HeldFile {
            bricks: holds.clone(),
        })
        .map_err(|e| e.to_string())?;
        text.push('\n');
        crate::fsutil::write_atomic(file, text.as_bytes())
            .map_err(|error| format!("{} could not be written ({error}).", file.display()))?;
        *written = Some(holds);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(connection: u64, name: &str) -> Holder {
        Holder::Client {
            connection,
            name: name.into(),
        }
    }

    #[test]
    fn a_brick_stays_while_either_client_holds_it_and_goes_with_the_last() {
        let holders = HolderSets::new(None);
        holders.add("CCC", window(1, "VS Code (window A)")).unwrap();
        holders.add("CCC", window(2, "VS Code (window B)")).unwrap();
        assert!(holders.client_left(1).is_empty());
        let still = holders.holders_of("CCC");
        assert_eq!(still.len(), 1);
        assert_eq!(still[0].kind, BrickHolderKind::Client);
        assert_eq!(still[0].client.as_deref(), Some("VS Code (window B)"));
        assert_eq!(holders.client_left(2), ["CCC"]);
        assert!(!holders.is_held("CCC"));
    }

    #[test]
    fn a_disconnect_drops_only_the_callers_hold() {
        let holders = HolderSets::new(None);
        holders.add("CCC", window(1, "VS Code")).unwrap();
        holders.add("CCC", Holder::Hold).unwrap();
        assert!(!holders.drop_holder("CCC", &window(1, "VS Code")));
        assert_eq!(
            holders
                .holders_of("CCC")
                .iter()
                .map(holder_name)
                .collect::<Vec<_>>(),
            ["ev3 connect"]
        );
        assert_eq!(holders.holds(), ["CCC"]);
        assert!(holders.drop_all("CCC"));
        assert!(holders.holds().is_empty());
    }

    #[test]
    fn one_hold_per_brick_however_often_it_is_added() {
        let holders = HolderSets::new(None);
        holders.add("CCC", Holder::Hold).unwrap();
        holders.add("CCC", Holder::Hold).unwrap();
        holders.add("BBB", Holder::Hold).unwrap();
        assert_eq!(holders.holds().len(), 2);
    }

    #[test]
    fn the_holds_are_written_to_held_json_and_read_back() {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-held-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("held.json");
        let holders = HolderSets::new(Some(file.clone()));
        holders.add("001653F00A0A", Holder::Hold).unwrap();
        holders.add("001653F00B0B", window(1, "VS Code")).unwrap();
        assert_eq!(read_held(&file, |w| panic!("{w}")), ["001653F00A0A"]);
        holders.drop_holder("001653F00A0A", &Holder::Hold);
        assert!(read_held(&file, |w| panic!("{w}")).is_empty());
        std::fs::write(&file, "not json").unwrap();
        let mut warned = Vec::new();
        assert!(read_held(&file, |w| warned.push(w)).is_empty());
        assert_eq!(warned.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
