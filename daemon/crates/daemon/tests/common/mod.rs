//! What the process tests share: a private state root, the daemon binary on a test channel, and a
//! minimal client that speaks the framing and the hello.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use ev3_cockpitd::channel::Duplex;
use ev3_cockpitd::codec::JsonRpcCodec;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{ReadHalf, WriteHalf};
use tokio_util::codec::{FramedRead, FramedWrite};

/// The daemon binary: the one cargo built for these tests, or, for test binaries built on one
/// system and run on another, the `ev3-cockpitd` found next to or above the test binary.
pub fn bin() -> &'static Path {
    static BIN: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| {
        let compiled = PathBuf::from(env!("CARGO_BIN_EXE_ev3-cockpitd"));
        if compiled.is_file() {
            return compiled;
        }
        // The compiled-in path may come from another system, whose separators this one does not
        // split, so the name is built rather than taken from it.
        let name = format!("ev3-cockpitd{}", std::env::consts::EXE_SUFFIX);
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.ancestors()
                    .map(|dir| dir.join(&name))
                    .find(|p| p.is_file())
            })
            .unwrap_or(compiled)
    });
    &BIN
}

/// A state root of its own, removed at the end.
pub struct TempRoot(pub PathBuf);

impl TempRoot {
    pub fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-{tag}-{}",
            ev3_cockpitd::hex(&ev3_cockpitd::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("temp root");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn channel_dir(&self, channel: &str) -> PathBuf {
        self.0.join("channels").join(channel)
    }

    pub fn record_file(&self, channel: &str) -> PathBuf {
        self.channel_dir(channel).join("channel.json")
    }

    pub fn key(&self) -> Vec<u8> {
        std::fs::read(self.0.join("key")).expect("key")
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The daemon binary on a test channel.
pub struct Daemon {
    pub child: Child,
    pub record: Value,
}

pub fn spawn(root: &Path, channel: &str) -> Child {
    spawn_with(root, channel, &[])
}

/// The daemon on a test channel with more arguments, such as `--fixtures <dir>`.
pub fn spawn_with(root: &Path, channel: &str, extra: &[&std::ffi::OsStr]) -> Child {
    spawn_binary(bin(), root, channel, extra, &[])
}

/// The daemon binary at `bin` on a test channel, with more arguments and environment variables.
pub fn spawn_binary(
    bin: &Path,
    root: &Path,
    channel: &str,
    extra: &[&std::ffi::OsStr],
    env: &[(&str, &str)],
) -> Child {
    Command::new(bin)
        .args(["--channel", channel, "--state-root"])
        .arg(root)
        .args(extra)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the daemon starts")
}

/// A recorded scenario's directory under `daemon/fixtures/link`.
pub fn fixture(name: &str) -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/link");
    // A test binary built on one system and run on another finds the workspace from its own path.
    let root = if compiled.is_dir() {
        compiled
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.ancestors()
                    .map(|dir| dir.join("fixtures/link"))
                    .find(|dir| dir.is_dir())
            })
            .unwrap_or(compiled)
    };
    std::fs::canonicalize(root.join(name)).expect("the fixture exists")
}

/// Waits until `child` recorded its channel, or returns `None` when it exited first.
pub fn wait_for_record(root: &TempRoot, channel: &str, child: &mut Child) -> Option<Value> {
    let file = root.record_file(channel);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if child.try_wait().expect("try_wait").is_some() {
            return None;
        }
        if let Ok(text) = std::fs::read_to_string(&file)
            && let Ok(record) = serde_json::from_str::<Value>(&text)
            && record["pid"].as_u64() == Some(u64::from(child.id()))
        {
            return Some(record);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("the daemon did not record its channel in time");
}

impl Daemon {
    pub fn start(root: &TempRoot, channel: &str) -> Self {
        Self::start_with(root, channel, &[])
    }

    /// The daemon replaying the recorded scenario `name`.
    pub fn replaying(root: &TempRoot, channel: &str, name: &str) -> Self {
        Self::replaying_with(root, channel, name, &[])
    }

    /// The daemon replaying the recorded scenario `name`, with more arguments.
    pub fn replaying_with(
        root: &TempRoot,
        channel: &str,
        name: &str,
        extra: &[&std::ffi::OsStr],
    ) -> Self {
        let dir = fixture(name);
        let mut args = vec![std::ffi::OsStr::new("--fixtures"), dir.as_os_str()];
        args.extend_from_slice(extra);
        Self::start_with(root, channel, &args)
    }

    pub fn start_with(root: &TempRoot, channel: &str, extra: &[&std::ffi::OsStr]) -> Self {
        Self::start_binary(bin(), root, channel, extra, &[])
    }

    /// The daemon binary at `bin` on a test channel, with more arguments and environment variables.
    pub fn start_binary(
        bin: &Path,
        root: &TempRoot,
        channel: &str,
        extra: &[&std::ffi::OsStr],
        env: &[(&str, &str)],
    ) -> Self {
        let mut child = spawn_binary(bin, root.path(), channel, extra, env);
        let record = wait_for_record(root, channel, &mut child).unwrap_or_else(|| {
            let status = child.wait().expect("wait");
            panic!(
                "the daemon exited at once: {status} {}",
                stderr_of(&mut child)
            )
        });
        Self { child, record }
    }

    pub fn path(&self) -> String {
        self.record["path"].as_str().expect("path").to_string()
    }

    /// Waits for the process to end, up to `timeout`.
    pub fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        wait_exit(&mut self.child, timeout)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn wait_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

pub fn stderr_of(child: &mut Child) -> String {
    use std::io::Read;
    let mut text = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut text);
    }
    text
}

/// Opens the pipe or socket at `path`.
pub async fn open(path: &str) -> std::io::Result<Box<dyn Duplex>> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match ClientOptions::new().open(path) {
                Ok(client) => return Ok(Box::new(client)),
                // ERROR_PIPE_BUSY: the next instance is being created.
                Err(error) if error.raw_os_error() == Some(231) && Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }
    #[cfg(unix)]
    {
        Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
    }
}

/// Who a client says it is in its hello.
#[derive(Debug, Clone, Copy)]
pub struct Hello<'a> {
    pub kind: &'a str,
    pub name: &'a str,
    pub version: &'a str,
    pub build_kind: &'a str,
    pub contract_version: u64,
}

impl Default for Hello<'_> {
    fn default() -> Self {
        Self {
            kind: "cli",
            name: "process test",
            version: "0.0.1",
            build_kind: "development",
            contract_version: u64::from(ev3_contract::CONTRACT_VERSION),
        }
    }
}

/// A raw client: frames out, frames in.
pub struct Client {
    reader: FramedRead<ReadHalf<Box<dyn Duplex>>, JsonRpcCodec>,
    writer: FramedWrite<WriteHalf<Box<dyn Duplex>>, JsonRpcCodec>,
    next_id: u64,
}

impl Client {
    pub async fn connect(path: &str) -> Self {
        let stream = open(path).await.expect("the channel opens");
        let (reader, writer) = tokio::io::split(stream);
        Self {
            reader: FramedRead::new(reader, JsonRpcCodec::default()),
            writer: FramedWrite::new(writer, JsonRpcCodec::default()),
            next_id: 1,
        }
    }

    pub async fn send(&mut self, message: Value) -> bool {
        self.writer.send(message).await.is_ok()
    }

    /// The next message, or `None` once the daemon closed the connection.
    pub async fn next(&mut self) -> Option<Value> {
        match tokio::time::timeout(Duration::from_secs(15), self.reader.next()).await {
            Ok(Some(Ok(message))) => Some(message),
            Ok(_) => None,
            Err(_) => panic!("no message and no close within 15 s"),
        }
    }

    /// Sends a request and returns its response, skipping notifications; `None` on close.
    pub async fn request(&mut self, method: &str, params: Value) -> Option<Value> {
        let id = self.next_id;
        self.next_id += 1;
        if !self
            .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await
        {
            return None;
        }
        loop {
            let message = self.next().await?;
            if message.get("id") == Some(&json!(id)) && message.get("method").is_none() {
                return Some(message);
            }
        }
    }

    /// The hello with `key`; the `hello/finish` result.
    pub async fn hello(&mut self, key: &[u8], kind: &str) -> Value {
        self.hello_as(key, kind, "process test").await
    }

    /// Sends a request without waiting for its answer; returns its id.
    pub async fn send_request(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        assert!(
            self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
                .await,
            "sent"
        );
        id
    }

    /// The next message for which `wanted` holds, skipping the rest; `None` on close.
    pub async fn next_matching(&mut self, wanted: impl Fn(&Value) -> bool) -> Option<Value> {
        loop {
            let message = self.next().await?;
            if wanted(&message) {
                return Some(message);
            }
        }
    }

    /// The answer to the request `id`, skipping everything else.
    pub async fn answer_to(&mut self, id: u64) -> Option<Value> {
        self.next_matching(|m| m.get("id") == Some(&json!(id)) && m.get("method").is_none())
            .await
    }

    /// The next question the daemon puts to this client.
    pub async fn question(&mut self) -> Option<Value> {
        self.next_matching(|m| m["method"] == "question/ask").await
    }

    /// Answers a request the daemon sent.
    pub async fn reply(&mut self, request: &Value, result: Value) {
        assert!(
            self.send(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
                .await,
            "replied"
        );
    }

    /// The hello with `key`, as a development client of `kind` named `name`, version 0.0.1.
    pub async fn hello_as(&mut self, key: &[u8], kind: &str, name: &str) -> Value {
        self.hello_from(
            key,
            Hello {
                kind,
                name,
                ..Hello::default()
            },
        )
        .await
    }

    /// Waits up to `timeout` for a message for which `wanted` holds, skipping the rest; `None`
    /// when none came in time or the daemon closed the connection.
    pub async fn within(
        &mut self,
        timeout: Duration,
        wanted: impl Fn(&Value) -> bool,
    ) -> Option<Value> {
        tokio::time::timeout(timeout, async {
            loop {
                match self.reader.next().await {
                    Some(Ok(message)) if wanted(&message) => return Some(message),
                    Some(Ok(_)) => {}
                    _ => return None,
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    /// The hello with `key`, as the client `hello` describes.
    pub async fn hello_from(&mut self, key: &[u8], hello: Hello<'_>) -> Value {
        let nonce = ev3_cockpitd::hex(&ev3_cockpitd::random_bytes::<32>());
        let challenge = self
            .request(
                "hello/start",
                json!({
                    "clientNonce": nonce, "clientName": hello.name, "clientKind": hello.kind,
                    "version": hello.version, "contractVersion": hello.contract_version,
                    "buildKind": hello.build_kind,
                }),
            )
            .await
            .expect("hello/start answered");
        let daemon_nonce = challenge["result"]["daemonNonce"].as_str().expect("nonce");
        assert_eq!(
            challenge["result"]["daemonProof"].as_str(),
            Some(ev3_contract::hello::daemon_proof(key, &nonce, daemon_nonce).as_str()),
            "the daemon proves it holds the key"
        );
        let proof = ev3_contract::hello::client_proof(key, &nonce, daemon_nonce);
        let accepted = self
            .request("hello/finish", json!({ "clientProof": proof }))
            .await
            .expect("hello/finish answered");
        accepted["result"].clone()
    }
}
