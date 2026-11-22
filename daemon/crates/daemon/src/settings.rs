//! The daemon's settings: one JSON file per channel, checked against the contract's settings spec.
//!
//! A setting whose spec says it is not stored (access mode) is never written to the file and never
//! read from it, so editing the file cannot turn access mode `full` on; it lasts as long as the
//! daemon. A dangerous setting changes away from its default only after a person said yes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ev3_contract::{
    AccessMode, ClientKind, ContractError, ErrorCode, SettingScalar, SettingSpec, SettingType,
    SettingValue, setting_specs,
};
use serde_json::Value;

/// The access mode setting's key.
pub const ACCESS_MODE: &str = "accessMode";

/// The settings and the file they persist to.
pub struct SettingsStore {
    file: PathBuf,
    specs: Vec<SettingSpec>,
    values: BTreeMap<String, SettingScalar>,
}

/// Whether two values are the same; numbers compare by value.
pub fn same_scalar(a: &SettingScalar, b: &SettingScalar) -> bool {
    match (a, b) {
        (SettingScalar::Boolean(x), SettingScalar::Boolean(y)) => x == y,
        (SettingScalar::Number(x), SettingScalar::Number(y)) => x == y,
        (SettingScalar::String(x), SettingScalar::String(y)) => x == y,
        _ => false,
    }
}

/// The command a person runs to make a dangerous change.
pub fn person_command(spec: &SettingSpec, value: &SettingScalar) -> String {
    format!("ev3 config set {} {}", spec.cli_key, describe(value))
}

pub(crate) fn describe(value: &SettingScalar) -> String {
    match value {
        SettingScalar::Boolean(b) => b.to_string(),
        SettingScalar::Number(n) => n.to_string(),
        SettingScalar::String(s) => s.clone(),
    }
}

/// What is wrong with `value` for `spec`, or `None` when it fits.
pub fn problem(spec: &SettingSpec, value: &SettingScalar) -> Option<String> {
    let number = match (&spec.type_, value) {
        (SettingType::Boolean, SettingScalar::Boolean(_)) => return None,
        (SettingType::String, SettingScalar::String(text)) => {
            if !spec.enum_.is_empty() && !spec.enum_.iter().any(|allowed| allowed == text) {
                return Some(format!("must be one of {}", spec.enum_.join(", ")));
            }
            return None;
        }
        (SettingType::Number, SettingScalar::Number(n)) => *n,
        (SettingType::Integer, SettingScalar::Number(n)) => {
            if n.fract() != 0.0 {
                return Some("must be a whole number".into());
            }
            *n
        }
        (SettingType::Boolean, _) => return Some("must be true or false".into()),
        (SettingType::String, _) => return Some("must be text".into()),
        (SettingType::Number | SettingType::Integer, _) => {
            return Some("must be a number".into());
        }
    };
    if !number.is_finite() {
        return Some("must be a finite number".into());
    }
    if let Some(min) = spec.minimum
        && number < min
    {
        return Some(format!("must be at least {min}"));
    }
    if let Some(min) = spec.exclusive_minimum
        && number <= min
    {
        return Some(format!("must be greater than {min}"));
    }
    if let Some(max) = spec.maximum
        && number > max
    {
        return Some(format!("must be at most {max}"));
    }
    None
}

impl SettingsStore {
    /// The settings in `file`: a value that is unknown, never stored or does not fit is dropped,
    /// and `warn` is told why.
    pub fn load(file: &Path, mut warn: impl FnMut(String)) -> Self {
        let specs = setting_specs();
        let mut values: BTreeMap<String, SettingScalar> = specs
            .iter()
            .map(|spec| (spec.key.clone(), spec.default.clone()))
            .collect();
        let stored: serde_json::Map<String, Value> = match std::fs::read_to_string(file) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(Value::Object(map)) => map,
                Ok(_) | Err(_) => {
                    warn(format!(
                        "The settings file {} is not a JSON object; using defaults.",
                        file.display()
                    ));
                    serde_json::Map::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
            Err(error) => {
                warn(format!(
                    "The settings file {} could not be read ({error}); using defaults.",
                    file.display()
                ));
                serde_json::Map::new()
            }
        };
        for (key, raw) in stored {
            let Some(spec) = specs.iter().find(|s| s.key == key) else {
                warn(format!(
                    "The settings file names an unknown setting {key}; ignored."
                ));
                continue;
            };
            if !spec.stored {
                warn(format!(
                    "The settings file sets {key}, which is never read from the file; ignored."
                ));
                continue;
            }
            let fits = serde_json::from_value::<SettingScalar>(raw.clone())
                .ok()
                .filter(|value| problem(spec, value).is_none());
            match fits {
                Some(value) => {
                    values.insert(key, value);
                }
                None => warn(format!(
                    "Setting {key} = {raw} does not fit; using its default."
                )),
            }
        }
        Self {
            file: file.to_path_buf(),
            specs,
            values,
        }
    }

    /// Every setting with its value.
    pub fn list(&self) -> Vec<SettingValue> {
        self.specs.iter().map(|spec| self.entry(spec)).collect()
    }

    /// The access mode now.
    pub fn access_mode(&self) -> AccessMode {
        match self.values.get(ACCESS_MODE) {
            Some(SettingScalar::String(mode)) if mode == "full" => AccessMode::Full,
            _ => AccessMode::Safe,
        }
    }

    /// The spec a key names, spelled as the setting's key or its CLI key.
    pub fn spec(&self, spelled: &str) -> Option<&SettingSpec> {
        self.specs
            .iter()
            .find(|spec| spec.key == spelled || spec.cli_key == spelled)
    }

    /// A number setting's value, by its key.
    pub fn number(&self, key: &str) -> Option<f64> {
        match self.values.get(key) {
            Some(SettingScalar::Number(n)) => Some(*n),
            _ => None,
        }
    }

    /// A true-or-false setting's value, by its key.
    pub fn flag(&self, key: &str) -> Option<bool> {
        match self.values.get(key) {
            Some(SettingScalar::Boolean(b)) => Some(*b),
            _ => None,
        }
    }

    /// Checks a change without making it: the spec when the change needs a person's yes, `None`
    /// when it can be made at once, or why it cannot be made at all.
    pub fn needs_person(
        &self,
        spelled: &str,
        value: &SettingScalar,
    ) -> Result<Option<SettingSpec>, ContractError> {
        let Some(spec) = self.spec(spelled) else {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                format!("There is no setting {spelled}."),
            ));
        };
        if let Some(problem) = problem(spec, value) {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                format!("Setting {} {problem}.", spec.cli_key),
            ));
        }
        Ok((spec.dangerous && !same_scalar(value, &spec.default)).then(|| spec.clone()))
    }

    /// Changes a setting. A dangerous one changes away from its default only with
    /// `confirmed_by_person`; otherwise the refusal names the command a person can run.
    pub fn set(
        &mut self,
        spelled: &str,
        value: SettingScalar,
        caller: ClientKind,
        confirmed_by_person: bool,
    ) -> Result<SettingValue, ContractError> {
        let Some(spec) = self.spec(spelled).cloned() else {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                format!("There is no setting {spelled}."),
            ));
        };
        if let Some(problem) = problem(&spec, &value) {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                format!("Setting {} {problem}.", spec.cli_key),
            ));
        }
        if spec.dangerous && !same_scalar(&value, &spec.default) && !confirmed_by_person {
            let command = person_command(&spec, &value);
            let message = if matches!(caller, ClientKind::Vscode | ClientKind::Cli) {
                format!(
                    "Changing {} needs your confirmation: run {command} in an interactive terminal, or use EVƎ: Settings in VS Code.",
                    spec.cli_key
                )
            } else {
                format!(
                    "{} can be changed only by a person: run {command} in a terminal, or use EVƎ: Settings in VS Code.",
                    spec.cli_key
                )
            };
            let mut error = ContractError::new(ErrorCode::NeedsPerson, message);
            error.data.command = Some(command);
            return Err(error);
        }
        let previous = self.values.insert(spec.key.clone(), value);
        if spec.stored
            && let Err(error) = self.save()
        {
            if let Some(previous) = previous {
                self.values.insert(spec.key.clone(), previous);
            }
            return Err(ContractError::new(
                ErrorCode::Internal,
                format!(
                    "The settings file {} could not be written ({error}).",
                    self.file.display()
                ),
            ));
        }
        Ok(self.entry(&spec))
    }

    fn entry(&self, spec: &SettingSpec) -> SettingValue {
        SettingValue {
            spec: spec.clone(),
            value: self
                .values
                .get(&spec.key)
                .cloned()
                .unwrap_or_else(|| spec.default.clone()),
        }
    }

    /// Writes the stored settings that differ from their defaults; never a setting whose spec
    /// says it is not stored.
    fn save(&self) -> std::io::Result<()> {
        let mut stored = serde_json::Map::new();
        for spec in self.specs.iter().filter(|spec| spec.stored) {
            if let Some(value) = self.values.get(&spec.key)
                && !same_scalar(value, &spec.default)
            {
                stored.insert(
                    spec.key.clone(),
                    serde_json::to_value(value).map_err(std::io::Error::other)?,
                );
            }
        }
        let mut text =
            serde_json::to_string_pretty(&Value::Object(stored)).map_err(std::io::Error::other)?;
        text.push('\n');
        if let Some(dir) = self.file.parent() {
            crate::fsutil::create_private_dir_all(dir)?;
        }
        crate::fsutil::write_atomic(&self.file, text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-settings-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        (dir.clone(), dir.join("settings.json"))
    }

    fn number(n: f64) -> SettingScalar {
        SettingScalar::Number(n)
    }

    fn text(s: &str) -> SettingScalar {
        SettingScalar::String(s.into())
    }

    #[test]
    fn access_mode_full_is_never_written_to_the_file() {
        let (dir, file) = temp_file();
        let mut store = SettingsStore::load(&file, |_| {});
        store
            .set(ACCESS_MODE, text("full"), ClientKind::Cli, true)
            .expect("a person said yes");
        assert_eq!(store.access_mode(), AccessMode::Full);
        store
            .set(
                "transfer.tcp-packet-bytes",
                number(512.0),
                ClientKind::Cli,
                false,
            )
            .expect("a stored setting");
        let written = std::fs::read_to_string(&file).expect("written");
        assert!(!written.contains("accessMode"), "{written}");
        assert!(!written.contains("full"), "{written}");
        assert!(
            written.contains("\"transfer.tcpPacketBytes\": 512"),
            "{written}"
        );
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn access_mode_in_the_file_is_ignored() {
        let (dir, file) = temp_file();
        std::fs::write(&file, r#"{"accessMode":"full","rememberBricks":"auto"}"#).expect("write");
        let mut warnings = Vec::new();
        let store = SettingsStore::load(&file, |w| warnings.push(w));
        assert_eq!(store.access_mode(), AccessMode::Safe);
        assert!(
            warnings.iter().any(|w| w.contains("accessMode")),
            "{warnings:?}"
        );
        let remember = store
            .list()
            .into_iter()
            .find(|s| s.spec.key == "rememberBricks")
            .expect("rememberBricks");
        assert!(same_scalar(&remember.value, &text("auto")));
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_dangerous_change_without_a_person_names_the_command() {
        let (dir, file) = temp_file();
        let mut store = SettingsStore::load(&file, |_| {});
        for caller in [ClientKind::Mcp, ClientKind::Addon, ClientKind::Cli] {
            let error = store
                .set("access-mode", text("full"), caller, false)
                .expect_err("refused");
            assert_eq!(error.data.code, ErrorCode::NeedsPerson);
            assert_eq!(
                error.data.command.as_deref(),
                Some("ev3 config set access-mode full")
            );
        }
        assert_eq!(store.access_mode(), AccessMode::Safe);
        store
            .set(ACCESS_MODE, text("safe"), ClientKind::Mcp, false)
            .expect("back to the default needs nobody");
        assert!(!file.exists(), "nothing stored changed");
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn values_outside_the_spec_are_refused_and_dropped() {
        let (dir, file) = temp_file();
        let mut store = SettingsStore::load(&file, |_| {});
        let refused = [
            ("transfer.tcpPacketBytes", number(63.0)),
            ("transfer.tcpPacketBytes", number(65536.0)),
            ("transfer.tcpPacketBytes", number(100.5)),
            ("telemetry.throttle.step", number(1.0)),
            ("rememberBricks", text("sometimes")),
            ("telemetry.throttle.enabled", number(1.0)),
            ("noSuchSetting", number(1.0)),
        ];
        for (key, value) in refused {
            let error = store
                .set(key, value, ClientKind::Cli, false)
                .expect_err(key);
            assert_eq!(error.data.code, ErrorCode::InvalidRequest, "{key}");
        }
        store
            .set(
                "telemetry.throttle.step",
                number(1.01),
                ClientKind::Cli,
                false,
            )
            .expect("just over the exclusive minimum");
        std::fs::write(&file, r#"{"transfer.btPacketBytes": 10, "bogus": 1}"#).expect("write");
        let mut warnings = Vec::new();
        let store = SettingsStore::load(&file, |w| warnings.push(w));
        let bt = store
            .list()
            .into_iter()
            .find(|s| s.spec.key == "transfer.btPacketBytes")
            .expect("bt");
        assert!(same_scalar(&bt.value, &number(1024.0)));
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        std::fs::remove_dir_all(dir).expect("clean");
    }
}
