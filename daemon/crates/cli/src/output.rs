//! What `ev3` prints and how it exits.
//!
//! People get plain lines; programs pass `--json` and get the result object on stdout, or
//! `{ "error": { code, message, ... } }` on stdout when the command failed. A daemon that could not
//! be started adds `failure`. The exit code tells a script what happened without reading either:
//!
//! | code | meaning |
//! |---|---|
//! | 0 | done |
//! | 1 | failed; the message says why (a person who said no ends here too) |
//! | 2 | the command line is wrong, or names a setting the cockpit does not have |
//! | 3 | another client is writing to the brick; the message names it |
//! | 4 | a program start whose answer was lost: do not start it again, check first |
//! | 5 | a person has to run and confirm this in a terminal |
//! | 6 | the cockpit daemon could not be reached or started |
//! | 7 | Windows Smart App Control blocks the cockpit's daemon |
//! | 8 | this installation's daemon cannot be started safely |
//! | 9 | the running daemon speaks another contract than this command |

use std::io::Write;

use serde_json::Value;

use crate::error::{CliError, exit};

/// The exit codes as the help text lists them.
pub const EXIT_CODE_HELP: [&str; 4] = [
    "Exit codes: 0 done, 1 failed, 2 wrong command line, 3 the brick is busy, 4 a start that may or may not have happened,",
    "5 a person has to run and confirm it in a terminal, 6 the cockpit daemon could not be reached or started,",
    "7 Windows Smart App Control blocks the cockpit's daemon, 8 the daemon of this installation is missing, does not",
    "match its recorded SHA-256 or its folder is not yours alone, 9 the running daemon speaks another contract.",
];

/// What a command produced: the object `--json` prints, the lines a person reads, how it ends.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub value: Value,
    pub human: Vec<String>,
    pub exit_code: u8,
    /// The command wrote its output as it went: nothing more is printed.
    pub streamed: bool,
}

impl Outcome {
    pub fn new(value: Value, human: impl IntoLines) -> Self {
        Self {
            value,
            human: human.into_lines(),
            exit_code: exit::OK,
            streamed: false,
        }
    }

    pub fn with_exit(mut self, code: u8) -> Self {
        self.exit_code = code;
        self
    }
}

/// One line or several.
pub trait IntoLines {
    fn into_lines(self) -> Vec<String>;
}

impl IntoLines for String {
    fn into_lines(self) -> Vec<String> {
        vec![self]
    }
}

impl IntoLines for &str {
    fn into_lines(self) -> Vec<String> {
        vec![self.to_owned()]
    }
}

impl IntoLines for Vec<String> {
    fn into_lines(self) -> Vec<String> {
        self
    }
}

/// JSON as `JSON.stringify(value, null, 2)` writes it.
pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
}

/// Writes `line` to stdout; `false` once nobody reads it any more. A closed pipe is no failure of
/// the command: `ev3 help | head -3` ends quietly, where `println!` would panic.
pub fn say(line: &str) -> bool {
    writeln!(std::io::stdout().lock(), "{line}").is_ok()
}

pub fn print_result(json: bool, outcome: &Outcome) {
    if outcome.streamed {
        return;
    }
    let mut out = std::io::stdout().lock();
    if json {
        let _ = writeln!(out, "{}", pretty(&outcome.value));
        return;
    }
    for line in &outcome.human {
        let _ = writeln!(out, "{line}");
    }
}

/// Prints a failure and returns the exit code it maps to.
pub fn print_error(json: bool, error: &CliError) -> u8 {
    if json {
        let _ = writeln!(
            std::io::stdout().lock(),
            "{}",
            pretty(&serde_json::json!({ "error": error.json() }))
        );
        return error.exit_code();
    }
    let mut err = std::io::stderr().lock();
    let message = error.message();
    let _ = writeln!(err, "ev3: {message}");
    if let CliError::Contract { code, data, .. } = error {
        if let Some(holder) = data.get("holder").and_then(Value::as_str)
            && !message.contains(holder)
        {
            let _ = writeln!(err, "Held by: {holder}");
        }
        for candidate in data
            .get("candidates")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let _ = writeln!(
                err,
                "  {}  (id {})",
                text(candidate, "name"),
                text(candidate, "brickId")
            );
        }
        if code == "needs_person"
            && let Some(command) = data.get("command").and_then(Value::as_str)
            && !message.contains(command)
        {
            let _ = writeln!(err, "A person can run: {command}");
        }
    }
    if matches!(error, CliError::Usage(_)) {
        let _ = writeln!(err, "Run ev3 help for the commands.");
    }
    error.exit_code()
}

/// Columns padded to their widest cell (in characters), the last one unpadded.
pub fn table(rows: &[Vec<String>]) -> Vec<String> {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            let len = cell.chars().count();
            if widths.len() <= i {
                widths.push(len);
            } else {
                widths[i] = widths[i].max(len);
            }
        }
    }
    rows.iter()
        .map(|row| {
            let cells: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(i, cell)| {
                    if i + 1 == row.len() {
                        cell.clone()
                    } else {
                        let pad = widths[i] - cell.chars().count();
                        format!("{cell}{}", " ".repeat(pad))
                    }
                })
                .collect();
            cells.join("  ").trim_end().to_owned()
        })
        .collect()
}

/// A string property of a JSON object, or "".
/// The array under `key`, or none.
pub fn array(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The array under `key`, each item as [`js_string`] shows it.
pub fn strings(value: &Value, key: &str) -> Vec<String> {
    array(value, key).iter().map(js_string).collect()
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A JSON value as JavaScript's `String(value)` shows it.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// A number as JavaScript prints it: no `.0` on a whole number.
pub fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_table_pads_every_column_but_the_last() {
        let rows = vec![
            vec!["NAME".into(), "ID".into(), "".into()],
            vec!["CCC".into(), "usb:1".into(), "held".into()],
        ];
        assert_eq!(table(&rows), vec!["NAME  ID", "CCC   usb:1  held"]);
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        assert_eq!(js_number(8.0), "8");
        assert_eq!(js_number(7.9), "7.9");
        assert_eq!(js_number(-0.25), "-0.25");
    }
}
