//! Asking the person at the terminal.
//!
//! The daemon decides what needs a person's yes (forgetting a brick, clearing its Bluetooth list,
//! switching access mode to `full`, a restart) and asks this terminal when the request is its own.
//! A person is there only when both stdin and stdout are a terminal and the output is not `--json`.
//! A pipe, a script and an agent's shell tool are not a terminal: there `ev3` answers nothing, so
//! the daemon refuses the action and names the command a person can run.

use std::io::{IsTerminal, Write};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::client::Asker;

/// A person can be asked here.
pub fn can_ask(json: bool) -> bool {
    !json && std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Whether a line a person typed is a yes: only `y` or `yes`, any case.
pub fn is_yes(line: &str) -> bool {
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

/// The asker for this terminal; `own_name` is this command's client name, so a question another
/// client asked says who.
pub fn terminal_asker(own_name: String) -> Asker {
    Arc::new(
        move |question: Value, mut withdrawn: broadcast::Receiver<String>| {
            let own_name = own_name.clone();
            Box::pin(async move {
                let id = question
                    .get("questionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let mut details: Vec<String> = question
                    .get("details")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|d| d.as_str().map(str::to_owned))
                    .collect();
                if let Some(requester) = question.get("requester") {
                    let name = requester.get("name").and_then(Value::as_str).unwrap_or("");
                    if name != own_name {
                        let kind = requester.get("kind").and_then(Value::as_str).unwrap_or("");
                        details.push(format!("Asked for {name} ({kind})."));
                    }
                }
                let text = question
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                {
                    let mut err = std::io::stderr().lock();
                    for detail in &details {
                        let _ = writeln!(err, "  {detail}");
                    }
                    let _ = write!(err, "{text} [y/N] ");
                    let _ = err.flush();
                }
                let read = tokio::task::spawn_blocking(|| {
                    let mut line = String::new();
                    match std::io::stdin().read_line(&mut line) {
                        Ok(0) | Err(_) => None,
                        Ok(_) => Some(line),
                    }
                });
                let answer = tokio::select! {
                    line = read => match line.ok().flatten() {
                        Some(line) if is_yes(&line) => "yes",
                        _ => "no",
                    },
                    () = async {
                        while let Ok(gone) = withdrawn.recv().await {
                            if gone == id { return; }
                        }
                        std::future::pending::<()>().await;
                    } => {
                        let _ = writeln!(std::io::stderr(), "\nThe question was withdrawn.");
                        "keep"
                    }
                };
                json!({ "answer": answer })
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_y_or_yes_is_a_yes() {
        for yes in ["y", "Y", "yes", " YES \n"] {
            assert!(is_yes(yes), "{yes:?}");
        }
        for no in ["", "n", "no", "ye", "yes please", "ano"] {
            assert!(!is_yes(no), "{no:?}");
        }
    }
}
