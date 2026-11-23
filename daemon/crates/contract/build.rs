//! Generates the contract from `contract/` at the repository root: the types from the schema files
//! (through typify), and from the method table the contract version, the method metadata, the
//! dispatch trait, the notification enum, the error families and the settings spec. Everything
//! lands in `OUT_DIR`, so the Rust side can never be stale. The rules the schema must follow are
//! checked by `scripts/generate-contract.mts`, which also writes the TypeScript side.

use std::collections::BTreeMap;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let contract = manifest.join("../../../contract");
    let schema_dir = contract.join("schema");
    let table_file = contract.join("methods.json");
    println!("cargo:rerun-if-changed={}", schema_dir.display());
    println!("cargo:rerun-if-changed={}", table_file.display());

    let definitions = merge_definitions(&schema_dir);
    let table = read_json(&table_file);
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out.join("types.rs"), types(&definitions)).expect("write types.rs");
    fs::write(out.join("methods.rs"), methods(&table, &definitions)).expect("write methods.rs");
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every schema file's definitions in one map; a name defined twice stops the build.
fn merge_definitions(dir: &Path) -> Map<String, Value> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|entry| entry.expect("schema dir entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    let mut merged = Map::new();
    for file in files {
        let schema = read_json(&file);
        let Some(Value::Object(definitions)) = schema.get("definitions") else {
            panic!("{} has no definitions", file.display());
        };
        for (name, definition) in definitions {
            if merged.insert(name.clone(), definition.clone()).is_some() {
                panic!("{name} is defined twice ({})", file.display());
            }
        }
    }
    merged
}

fn types(definitions: &Map<String, Value>) -> String {
    let root = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": definitions,
    });
    let root: schemars::schema::RootSchema =
        serde_json::from_value(root).expect("the merged schema is a JSON schema");
    let mut settings = typify::TypeSpaceSettings::new();
    settings.map_typespace_settings(|s| {
        s.with_map_type(typify::typespace::settings::ContainerType::btree_map())
    });
    let mut space = typify::TypeSpace::new(&settings);
    space
        .add_root_schema(root)
        .unwrap_or_else(|e| panic!("typify: {e}"));
    let tokens = space.to_stream().unwrap_or_else(|e| panic!("typify: {e}"));
    let file: syn::File = syn::parse2(tokens).expect("typify output parses");
    prettyplease::unparse(&file)
}

/// `clearBluetoothList` → `ClearBluetoothList`, `not-removable` → `NotRemovable`.
fn pascal(text: &str) -> String {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            let first = chars.next().map(|c| c.to_ascii_uppercase());
            first.into_iter().chain(chars).collect::<String>()
        })
        .collect()
}

/// `bricks/clearBluetoothList` → `bricks_clear_bluetooth_list`.
fn snake(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    out
}

fn doc(out: &mut String, indent: &str, text: Option<&str>) {
    if let Some(text) = text {
        for line in text.lines() {
            let _ = writeln!(out, "{indent}/// {line}");
        }
    }
}

fn object<'a>(value: &'a Value, what: &str) -> &'a Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{what} is not an object"))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn result_type(entry: &Value) -> String {
    match entry.get("result") {
        Some(Value::String(name)) => name.clone(),
        _ => "()".to_string(),
    }
}

fn methods(table: &Value, definitions: &Map<String, Value>) -> String {
    let mut out = String::new();
    let version = table["contractVersion"]
        .as_u64()
        .expect("contractVersion is an integer");
    let _ = writeln!(
        out,
        "/// The contract version: raised only by a breaking change to the contract.\npub const CONTRACT_VERSION: u32 = {version};\n"
    );

    for (name, entry) in object(&table["hello"], "hello") {
        doc(&mut out, "", text(entry, "doc"));
        let _ = writeln!(
            out,
            "pub const {}: &str = {name:?};\n",
            snake(name).to_ascii_uppercase()
        );
    }
    for (name, entry) in object(&table["clientRequests"], "clientRequests") {
        doc(&mut out, "", text(entry, "doc"));
        let _ = writeln!(
            out,
            "pub const {}: &str = {name:?};\n",
            snake(name).to_ascii_uppercase()
        );
    }

    let requests = object(&table["methods"], "methods");
    out.push_str("/// Every request a client may send, as the method table describes it.\npub const METHODS: &[MethodInfo] = &[\n");
    for (name, entry) in requests {
        let flag = |key: &str| entry.get(key).and_then(Value::as_bool).unwrap_or(false);
        let kinds: Vec<String> = entry["callableBy"]
            .as_array()
            .expect("callableBy is an array")
            .iter()
            .map(|kind| {
                format!(
                    "ClientKind::{}",
                    pascal(kind.as_str().expect("client kind"))
                )
            })
            .collect();
        let _ = writeln!(
            out,
            "    MethodInfo {{ name: {name:?}, leased: {}, needs_person: {}, stable_core: {}, callable_by: &[{}] }},",
            flag("leased"),
            flag("needsPerson"),
            flag("stableCore"),
            kinds.join(", ")
        );
    }
    out.push_str("];\n\n");

    // The dispatch trait.
    out.push_str("/// The daemon's side of every request. `dispatch` decodes a request, checks that the caller's kind may send it and calls the matching method.\npub trait Methods: Sync {\n    /// What the daemon passes along with each request: the connection, its client, cancellation.\n    type Context: Sync;\n");
    for (name, entry) in requests {
        let params = entry["params"].as_str().expect("params names a type");
        out.push('\n');
        doc(&mut out, "    ", text(entry, "doc"));
        let _ = writeln!(
            out,
            "    fn {}(&self, cx: &Self::Context, params: {params}) -> impl ::std::future::Future<Output = Result<{}, ContractError>> + Send;",
            snake(name),
            result_type(entry)
        );
    }
    out.push_str("}\n\n");

    out.push_str("/// Runs one request on `handler`: the method must exist, `caller`'s kind must be allowed to send it, and its parameters must decode.\npub async fn dispatch<H: Methods>(handler: &H, cx: &H::Context, caller: ClientKind, method: &str, params: ::serde_json::Value) -> Result<::serde_json::Value, ContractError> {\n    let Some(info) = method_info(method) else {\n        return Err(ContractError::new(ErrorCode::InvalidRequest, format!(\"The daemon has no method {method}.\")));\n    };\n    if !info.callable_by.contains(&caller) {\n        return Err(ContractError::new(ErrorCode::AccessDenied, format!(\"A client of kind {caller} may not call {method}.\")));\n    }\n    match method {\n");
    for name in requests.keys() {
        let _ = writeln!(
            out,
            "        {name:?} => encode(handler.{}(cx, decode(method, params)?).await?),",
            snake(name)
        );
    }
    out.push_str("        _ => Err(ContractError::new(ErrorCode::InvalidRequest, format!(\"The daemon has no method {method}.\"))),\n    }\n}\n\n");

    // Every request with its types, for code that needs them all.
    out.push_str("/// Calls `$callback!` with every request as `\"name\" method_fn Params => Result;`.\n#[macro_export]\nmacro_rules! for_each_method {\n    ($callback:ident) => {\n        $callback! {\n");
    for (name, entry) in requests {
        let _ = writeln!(
            out,
            "            {name:?} {} {} => {};",
            snake(name),
            entry["params"].as_str().expect("params"),
            result_type(entry)
        );
    }
    out.push_str("        }\n    };\n}\n\n");

    // Notifications.
    let notifications = object(&table["notifications"], "notifications");
    out.push_str("/// Every notification the daemon sends.\n#[derive(Clone, Debug)]\npub enum Notification {\n");
    for (name, entry) in notifications {
        doc(&mut out, "    ", text(entry, "doc"));
        let _ = writeln!(
            out,
            "    {}({}),",
            pascal(name),
            entry["payload"].as_str().expect("payload")
        );
    }
    out.push_str("}\n\nimpl Notification {\n    /// The JSON-RPC method name.\n    pub fn method(&self) -> &'static str {\n        match self {\n");
    for name in notifications.keys() {
        let _ = writeln!(out, "            Self::{}(_) => {name:?},", pascal(name));
    }
    out.push_str("        }\n    }\n\n    /// The JSON-RPC params.\n    pub fn params(&self) -> Result<::serde_json::Value, ::serde_json::Error> {\n        match self {\n");
    for name in notifications.keys() {
        let _ = writeln!(
            out,
            "            Self::{}(payload) => ::serde_json::to_value(payload),",
            pascal(name)
        );
    }
    out.push_str("        }\n    }\n\n    /// A notification by its method name, or `None` for a name the contract does not have.\n    pub fn parse(method: &str, params: ::serde_json::Value) -> Option<Result<Self, ::serde_json::Error>> {\n        Some(match method {\n");
    for name in notifications.keys() {
        let _ = writeln!(
            out,
            "            {name:?} => ::serde_json::from_value(params).map(Self::{}),",
            pascal(name)
        );
    }
    out.push_str("            _ => return None,\n        })\n    }\n}\n\n");

    // Error families.
    let families = object(&table["errorFamilies"], "errorFamilies");
    out.push_str("impl ErrorFamily {\n    /// The JSON-RPC error code that names the family.\n    pub fn number(&self) -> i64 {\n        match self {\n");
    for (name, entry) in families {
        let _ = writeln!(
            out,
            "            Self::{} => {},",
            pascal(name),
            entry["number"].as_i64().expect("family number")
        );
    }
    out.push_str("        }\n    }\n}\n\nimpl ErrorCode {\n    /// The family the code belongs to.\n    pub fn family(&self) -> ErrorFamily {\n        match self {\n");
    for (code, entry) in object(&table["errors"], "errors") {
        let _ = writeln!(
            out,
            "            Self::{} => ErrorFamily::{},",
            pascal(code),
            pascal(entry["family"].as_str().expect("family"))
        );
    }
    out.push_str("        }\n    }\n}\n\n");

    // Stable-core strings read as enums: an unknown value reads as the property's fallback.
    let mut readers: Vec<(String, String)> = Vec::new();
    for definition in definitions.values() {
        let Some(Value::Object(properties)) = definition.get("properties") else {
            continue;
        };
        for property in properties.values() {
            if let (Some(name), Some(fallback)) = (
                text(property, "x-readAs"),
                text(property, "x-unknownReadsAs"),
            ) && !readers.iter().any(|(known, _)| known == name)
            {
                readers.push((name.to_string(), fallback.to_string()));
            }
        }
    }
    for (name, fallback) in readers {
        let _ = writeln!(
            out,
            "impl {name} {{\n    /// Reads a stable-core string as a {name}; a value this version does not know reads as `{fallback}`.\n    pub fn read_open(value: &str) -> Self {{\n        value.parse().unwrap_or(Self::{})\n    }}\n}}\n",
            pascal(&fallback)
        );
    }

    let specs = setting_specs(definitions);
    let _ = writeln!(
        out,
        "/// Every setting with its rules, as the Settings definition gives them, in JSON.\npub const SETTING_SPECS_JSON: &str = {:?};",
        serde_json::to_string(&specs).expect("setting specs")
    );
    out
}

/// The setting specs from the Settings definition: one per property, in the schema's order.
fn setting_specs(definitions: &Map<String, Value>) -> Vec<Value> {
    let settings = &definitions["Settings"]["properties"];
    object(settings, "Settings.properties")
        .iter()
        .map(|(key, rule)| {
            let mut spec = BTreeMap::new();
            spec.insert("key", json!(key));
            spec.insert("cliKey", rule["x-cliKey"].clone());
            spec.insert("type", rule["type"].clone());
            spec.insert("default", rule["default"].clone());
            for name in ["minimum", "exclusiveMinimum", "maximum", "enum"] {
                if let Some(value) = rule.get(name) {
                    spec.insert(name, value.clone());
                }
            }
            spec.insert("description", rule["description"].clone());
            spec.insert("dangerous", rule["x-dangerous"].clone());
            spec.insert(
                "stored",
                json!(
                    rule.get("x-stored")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                ),
            );
            json!(spec)
        })
        .collect()
}
