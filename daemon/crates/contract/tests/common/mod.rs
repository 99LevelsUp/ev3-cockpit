//! What the contract tests share: the files under `contract/` and JSON compared by value.

#![allow(dead_code)]

use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// A file under `contract/` at the repository root.
pub fn contract_json(relative: &str) -> Value {
    let path = contract_dir().join(relative);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The same JSON, numbers compared by value: Rust writes a number the schema types as `number`
/// from an `f64`, so 1024 comes back as 1024.0.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Decodes `message` as `T` and checks that encoding it again gives the same JSON.
pub fn round_trip<T: Serialize + DeserializeOwned>(what: &str, message: &Value) -> T {
    let typed: T = serde_json::from_value(message.clone())
        .unwrap_or_else(|e| panic!("{what} does not decode: {e}\n{message}"));
    let again = serde_json::to_value(&typed).expect("encodes");
    assert!(
        same(message, &again),
        "{what} changed on the way through Rust:\n  sent {message}\n  got  {again}"
    );
    typed
}

/// `contract/` at the repository root: from the crate's compiled-in path, or, for a test binary
/// built on one system and run on another, the nearest `contract/` above the test binary.
fn contract_dir() -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contract");
    if compiled.is_dir() {
        return compiled;
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.ancestors()
                .map(|dir| dir.join("contract"))
                .find(|dir| dir.join("methods.json").is_file())
        })
        .unwrap_or(compiled)
}
