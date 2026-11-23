//! `dispatch` routes every request of the method table to its trait method with typed
//! parameters, returns the typed result as JSON, and refuses what the table does not allow.
//!
//! Not named dispatch.rs: Windows takes a 32-bit program whose name holds `patch`, `setup`,
//! `install` or `update` for an installer and asks to elevate it, so that test never ran on x86.

mod common;

use std::future::Future;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use common::{contract_json, same};
use ev3_contract::*;
use serde_json::{Value, json};

/// Runs a future that never waits on anything, as every handler here is.
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
    }
}

/// Answers every request with its sample result and records what it was called with.
struct Recorder {
    samples: Value,
    calls: Mutex<Vec<(String, Value)>>,
}

impl Recorder {
    fn answer<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        params: &P,
    ) -> Result<R, ContractError> {
        let params = serde_json::to_value(params).expect("params encode");
        self.calls
            .lock()
            .expect("calls")
            .push((name.to_string(), params));
        Ok(serde_json::from_value(self.samples[name]["result"].clone()).expect("sample result"))
    }
}

macro_rules! recorder_methods {
    ($($name:literal $method:ident $params:ty => $result:ty;)*) => {
        impl Methods for Recorder {
            type Context = ();
            $(
                fn $method(
                    &self,
                    _cx: &(),
                    params: $params,
                ) -> impl Future<Output = Result<$result, ContractError>> + Send {
                    let answer = self.answer($name, &params);
                    async move { answer }
                }
            )*
        }
    };
}
for_each_method!(recorder_methods);

fn recorder() -> Recorder {
    Recorder {
        samples: contract_json("vectors/messages.json")["methods"].clone(),
        calls: Mutex::new(Vec::new()),
    }
}

#[test]
fn every_request_reaches_its_method_and_answers_its_result() {
    let handler = recorder();
    for info in METHODS {
        let sample = &handler.samples[info.name];
        let caller = info.callable_by[0];
        let result = block_on(dispatch(
            &handler,
            &(),
            caller,
            info.name,
            sample["params"].clone(),
        ))
        .unwrap_or_else(|e| panic!("{}: {e}", info.name));
        assert!(
            same(&result, &sample["result"]),
            "{}: answered {result}",
            info.name
        );
        let calls = handler.calls.lock().expect("calls");
        let (called, params) = calls.last().expect("a call");
        assert_eq!(called, info.name);
        assert!(
            same(params, &sample["params"]),
            "{}: got {params}",
            info.name
        );
    }
}

#[test]
fn an_mcp_client_may_not_ask_the_daemon_to_exit() {
    let handler = recorder();
    let info = method_info("daemon/exit").expect("daemon/exit");
    assert!(!info.callable_by.contains(&ClientKind::Mcp));
    assert!(info.stable_core);
    let error = block_on(dispatch(
        &handler,
        &(),
        ClientKind::Mcp,
        "daemon/exit",
        json!({}),
    ))
    .expect_err("refused");
    assert_eq!(error.data.code, ErrorCode::AccessDenied);
    assert_eq!(error.number(), 1000);
    assert!(handler.calls.lock().expect("calls").is_empty());

    block_on(dispatch(
        &handler,
        &(),
        ClientKind::Cli,
        "daemon/exit",
        json!({}),
    ))
    .expect("a terminal may ask");
}

#[test]
fn an_unknown_method_or_bad_params_is_an_invalid_request() {
    let handler = recorder();
    let unknown = block_on(dispatch(
        &handler,
        &(),
        ClientKind::Cli,
        "bricks/borrowAll",
        json!({}),
    ))
    .expect_err("unknown");
    assert_eq!(unknown.data.code, ErrorCode::InvalidRequest);
    assert_eq!(unknown.data.family, ErrorFamily::Request);
    assert_eq!(unknown.number(), 1500);

    let bad = block_on(dispatch(
        &handler,
        &(),
        ClientKind::Cli,
        "files/list",
        json!({ "brick": "AAA" }),
    ))
    .expect_err("path is required");
    assert_eq!(bad.data.code, ErrorCode::InvalidRequest);
    assert!(handler.calls.lock().expect("calls").is_empty());
}

#[test]
fn absent_params_read_as_an_empty_object() {
    let handler = recorder();
    block_on(dispatch(
        &handler,
        &(),
        ClientKind::Vscode,
        "daemon/status",
        Value::Null,
    ))
    .expect("daemon/status without params");
}
