//! The `ev3` commands. Each gets its arguments and a connection to the daemon made only when it
//! needs one; texts, `--json` objects and exit codes are the ones `src/cli` defined.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use ev3_channel::paths::Paths;
use serde_json::{Value, json};

use crate::confirm;
use crate::error::{CliError, Result, exit};
use crate::install;
use crate::output::{Outcome, array, js_string, say, strings, table, text};
use crate::telemetry;
use ev3_client::client::{Client, ClientOptions};
use ev3_client::ensure::{EXIT_ANSWER, ask_to_exit};

/// A command as help lists it.
pub struct Spec {
    pub name: &'static str,
    pub usage: &'static str,
    pub summary: &'static str,
    /// Switches it takes, by long name; `recursive` also answers to `-r`.
    pub flags: &'static [&'static str],
}

pub const COMMANDS: &[Spec] = &[
    Spec {
        name: "list",
        usage: "ev3 list",
        summary: "List the bricks the cockpit sees.",
        flags: &[],
    },
    Spec {
        name: "connect",
        usage: "ev3 connect <brick>",
        summary: "Connect a brick and hold it until ev3 disconnect.",
        flags: &[],
    },
    Spec {
        name: "disconnect",
        usage: "ev3 disconnect [brick] [--all]",
        summary: "Let go of a brick held by ev3 connect; --all disconnects it for every client.",
        flags: &["all"],
    },
    Spec {
        name: "info",
        usage: "ev3 info [brick]",
        summary: "Show a brick's name, id and firmware.",
        flags: &[],
    },
    Spec {
        name: "storage",
        usage: "ev3 storage [brick]",
        summary: "Show a brick's free and total storage.",
        flags: &[],
    },
    Spec {
        name: "pair",
        usage: "ev3 pair <brick>",
        summary: "Pair a brick over Bluetooth, looking for it first when it is new (up to 30 s); confirm on the brick.",
        flags: &[],
    },
    Spec {
        name: "forget",
        usage: "ev3 forget <brick>",
        summary: "Unpair a brick on this computer and on the brick; asks first.",
        flags: &[],
    },
    Spec {
        name: "bt-clear",
        usage: "ev3 bt-clear <brick>",
        summary: "Remove the entries from a brick's list of paired devices; shows them and asks first.",
        flags: &[],
    },
    Spec {
        name: "ls",
        usage: "ev3 ls [path] [--brick <brick>]",
        summary: "List a folder on the brick (the projects folder when no path is given).",
        flags: &[],
    },
    Spec {
        name: "get",
        usage: "ev3 get <remote> [local] [--brick <brick>]",
        summary: "Copy a file from the brick to this computer.",
        flags: &[],
    },
    Spec {
        name: "follow",
        usage: "ev3 follow <remote> [offset] [--brick <brick>]",
        summary: "Print a file on the brick as it grows, such as a program's output, from offset (0); ends with Ctrl+C or when the file goes.",
        flags: &[],
    },
    Spec {
        name: "put",
        usage: "ev3 put <local> <remote> [--brick <brick>]",
        summary: "Copy a file from this computer to the brick.",
        flags: &[],
    },
    Spec {
        name: "rm",
        usage: "ev3 rm [-r] <path> [--brick <brick>]",
        summary: "Remove a file, or with -r a folder and everything in it.",
        flags: &["recursive"],
    },
    Spec {
        name: "mkdir",
        usage: "ev3 mkdir <path> [--brick <brick>]",
        summary: "Make a folder on the brick.",
        flags: &[],
    },
    Spec {
        name: "mv",
        usage: "ev3 mv <from> <to> [--brick <brick>]",
        summary: "Move or rename a file on the brick.",
        flags: &[],
    },
    Spec {
        name: "run",
        usage: "ev3 run <path> [--brick <brick>] [--replace]",
        summary: "Start a program on the brick; --replace stops one that runs first.",
        flags: &["replace"],
    },
    Spec {
        name: "program",
        usage: "ev3 program [brick]",
        summary: "Say whether a program runs on the brick.",
        flags: &[],
    },
    Spec {
        name: "stop",
        usage: "ev3 stop [brick]",
        summary: "Stop the program running on the brick.",
        flags: &[],
    },
    Spec {
        name: "estop",
        usage: "ev3 estop [brick]",
        summary: "Emergency stop: stop the brick's program at once, whoever started it.",
        flags: &[],
    },
    Spec {
        name: "telemetry",
        usage: "ev3 telemetry [row...] [--brick <brick>] [--watch] [--list]",
        summary: "Read the brick's telemetry once (every row, or the rows named); --watch prints changes until Ctrl+C; --list names the rows.",
        flags: &["watch", "list"],
    },
    Spec {
        name: "config",
        usage: "ev3 config list | get <key> | set <key> <value>",
        summary: "Read and change the cockpit's settings.",
        flags: &[],
    },
    Spec {
        name: "status",
        usage: "ev3 status",
        summary: "Show the daemon, its clients, the held bricks and who writes to them.",
        flags: &[],
    },
    Spec {
        name: "daemon",
        usage: "ev3 daemon status | restart | log",
        summary: "The cockpit daemon: its status, a restart after a person's yes, its log's path.",
        flags: &[],
    },
    Spec {
        name: "mcp",
        usage: "ev3 mcp",
        summary: "Serve the cockpit's tools to an agent over MCP (stdio).",
        flags: &[],
    },
];

pub fn spec(name: &str) -> Option<&'static Spec> {
    COMMANDS.iter().find(|c| c.name == name)
}

/// The brick's projects folder, where `ev3 ls` looks when no path is given.
const PROJECTS: &str = "/home/root/lms2012/prjs";
const RESTART_COMMAND: &str = "ev3 daemon restart";
/// How long a pairing looks for a brick the daemon does not know yet.
pub const INQUIRY_WAIT: Duration = Duration::from_secs(30);

/// A brick a pairing looked for and did not hear.
pub fn not_heard(reference: &str) -> CliError {
    CliError::contract(
        "brick_not_found",
        format!(
            "{reference} was not heard over Bluetooth within {} s. Switch the brick on, turn on its Bluetooth and its visibility, keep it near this computer, and try again.",
            INQUIRY_WAIT.as_secs()
        ),
    )
}
/// How long one reading waits for every row to have a value.
const READING_WAIT: Duration = Duration::from_millis(5000);
/// How long a connect runs before a person waiting is told it is under way.
const SLOW_CONNECT: Duration = Duration::from_secs(3);

/// What every command gets.
pub struct Ctx {
    pub json: bool,
    /// `--brick`, when given.
    pub brick: Option<String>,
    /// The words after the command.
    pub args: Vec<String>,
    pub flags: HashSet<String>,
    pub paths: Paths,
    /// This command's client name: `ev3 <command> (terminal)`.
    pub name: String,
    pub usage: &'static str,
    client: Option<Client>,
}

impl Ctx {
    pub fn new(
        json: bool,
        brick: Option<String>,
        args: Vec<String>,
        flags: HashSet<String>,
        paths: Paths,
        spec: &Spec,
    ) -> Self {
        let name = format!("ev3 {} (terminal)", spec.name);
        Self {
            json,
            brick,
            args,
            flags,
            paths,
            name,
            usage: spec.usage,
            client: None,
        }
    }

    /// Connects on first use, starting the daemon when none runs.
    pub async fn client(&mut self) -> Result<&Client> {
        if self.client.is_none() {
            let json = self.json;
            let notice = move |text: &str| {
                if !json {
                    eprintln!("{text}");
                }
            };
            let client = Client::connect(ClientOptions {
                name: self.name.clone(),
                kind: "cli",
                version: install::VERSION,
                build_kind: install::BUILD_KIND,
                daemon: ev3_client::Launch::Carried(install::daemon()),
                paths: &self.paths,
                daemon_args: Vec::new(),
                asker: confirm::can_ask(self.json)
                    .then(|| confirm::terminal_asker(self.name.clone())),
                notice: &notice,
            })
            .await?;
            self.client = Some(client);
        }
        Ok(self.client.as_ref().expect("connected"))
    }

    /// Connects again after the daemon went, starting it when no other client did.
    pub async fn reconnect(&mut self) -> Result<&Client> {
        if let Some(old) = self.client.take() {
            old.shutdown().await;
        }
        self.client().await
    }

    pub async fn close(&mut self) {
        if let Some(client) = self.client.take() {
            client.shutdown().await;
        }
    }

    fn arg(&self, index: usize, what: &str) -> Result<String> {
        match self.args.get(index) {
            Some(value) if !value.is_empty() => Ok(value.clone()),
            _ => Err(CliError::usage(format!("Missing {what}."))),
        }
    }

    fn at_most(&self, count: usize) -> Result<()> {
        if self.args.len() > count {
            return Err(CliError::usage(format!(
                "Too many arguments. Usage: {}",
                self.usage
            )));
        }
        Ok(())
    }

    /// The brick a command names: a positional argument where it takes one, else `--brick`.
    fn brick_ref(&self, index: Option<usize>) -> Result<Option<String>> {
        let positional = index.and_then(|i| self.args.get(i)).cloned();
        if let (Some(p), Some(b)) = (&positional, &self.brick)
            && p != b
        {
            return Err(CliError::usage(format!(
                "The brick is named twice: {p} and --brick {b}."
            )));
        }
        Ok(positional.or_else(|| self.brick.clone()))
    }

    /// The brick a command must name: its first argument, else `--brick`; `what` names it in the
    /// usage error when neither is given.
    fn required_brick(&self, what: &str) -> Result<String> {
        match self.brick_ref(Some(0))? {
            Some(r) => Ok(r),
            None => self.arg(0, what),
        }
    }

    /// Connects the brick for this command alone, unless it is connected already; with none
    /// named, the one connected brick. Answers `(brickId, name)`.
    ///
    /// A brick connected already is used as it is. Asking the daemon to connect it again is what
    /// a person does to bring its lost channels back: the daemon joins every channel the brick has
    /// not connected, the paired Bluetooth one included, and waits for them. Done before every
    /// command it made each one wait for that Bluetooth attempt, about 40 s for a brick held over
    /// TCP with its Bluetooth off (U16, 23.11.2026).
    async fn connected_brick(&mut self, reference: Option<String>) -> Result<(String, String)> {
        let connected =
            |brick: &Value| brick.get("connected").and_then(Value::as_bool) == Some(true);
        let known = match &reference {
            Some(r) => self.client().await?.brick(r).await?.filter(connected),
            None => {
                let list = self
                    .client()
                    .await?
                    .request("bricks/list", json!({}))
                    .await?;
                let mut on = array(&list, "bricks").into_iter().filter(connected);
                match (on.next(), on.next()) {
                    (Some(only), None) => Some(only),
                    _ => None,
                }
            }
        };
        if let Some(brick) = known {
            // Held for this command's length, as it is: joining its other channels could take a
            // minute over Bluetooth, and a brick used without being held is signed out under the
            // command when its last holder lets go (#9).
            let id = text(&brick, "brickId").to_owned();
            self.client()
                .await?
                .request("bricks/connect", json!({ "brick": id, "reuse": true }))
                .await?;
            return Ok((id, text(&brick, "name").to_owned()));
        }
        let params = match reference {
            Some(r) => json!({ "brick": r }),
            None => json!({}),
        };
        let brick = self.connect_brick(params).await?;
        Ok((
            text(&brick, "brickId").to_owned(),
            text(&brick, "name").to_owned(),
        ))
    }

    /// Asks the daemon to connect a brick. A person waiting is told when it takes longer than a
    /// moment: over Bluetooth a connect can take tens of seconds before it succeeds or fails (a
    /// connect is 15 s at most on Windows, behind the other Bluetooth operations it queues after),
    /// and a silent terminal for that long reads as hung (U16, 23.11.2026).
    async fn connect_brick(&mut self, params: Value) -> Result<Value> {
        let json = self.json;
        let named = params
            .get("brick")
            .and_then(Value::as_str)
            .map_or_else(|| "the brick".to_owned(), str::to_owned);
        let client = self.client().await?;
        let request = client.request("bricks/connect", params);
        tokio::pin!(request);
        tokio::select! {
            result = &mut request => return Ok(result?),
            () = tokio::time::sleep(SLOW_CONNECT) => {}
        }
        if !json {
            eprintln!(
                "Connecting {named}; over Bluetooth this can take up to a minute before it succeeds or fails."
            );
        }
        Ok(request.await?)
    }

    /// The brick a stop reaches: a connected brick is stopped as it is, never signed in again;
    /// only one not connected at all is connected for the stop.
    async fn stop_target(&mut self, reference: Option<String>) -> Result<(Option<String>, String)> {
        let Some(reference) = reference else {
            self.client().await?;
            return Ok((None, "the brick".into()));
        };
        if let Some(known) = self.client().await?.brick(&reference).await?
            && known.get("connected").and_then(Value::as_bool) == Some(true)
        {
            return Ok((
                Some(text(&known, "brickId").to_owned()),
                text(&known, "name").to_owned(),
            ));
        }
        let (id, name) = self.connected_brick(Some(reference)).await?;
        Ok((Some(id), name))
    }

    fn local_path(&self, file: &str) -> PathBuf {
        let cwd = std::env::current_dir().unwrap_or_default();
        absolute_path(&cwd, Path::new(file))
    }
}

/// `path` made absolute against `cwd`, with `.` and `..` resolved by their letters, as a person
/// reads the path they typed. The daemon checks the path it is given on its own.
pub fn absolute_path(cwd: &Path, path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in cwd.join(path).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never above the root: `/..` is `/`.
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// The file name a path on the brick ends with, or `None` when it names a folder or nothing.
pub fn remote_file_name(remote: &str) -> Option<&str> {
    remote
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
}

/// Who holds a brick, as a person reads it.
pub fn holder_name(holder: &Value) -> String {
    match holder.get("kind").and_then(Value::as_str) {
        Some("hold") => "ev3 connect".into(),
        Some("remembered") => "remembered".into(),
        _ => holder
            .get("client")
            .and_then(Value::as_str)
            .unwrap_or("a client")
            .to_owned(),
    }
}

fn brick_line(brick: &Value) -> Vec<String> {
    let flag = |key: &str| brick.get(key).and_then(Value::as_bool) == Some(true);
    let state = if flag("reconnecting") {
        "reconnecting"
    } else if flag("connected") {
        "connected"
    } else {
        "available"
    };
    let holders: Vec<String> = array(brick, "holders").iter().map(holder_name).collect();
    let links: Vec<String> = array(brick, "channels")
        .iter()
        .map(|c| text(c, "transport").to_owned())
        .collect();
    vec![
        text(brick, "name").to_owned(),
        text(brick, "brickId").to_owned(),
        state.into(),
        links.join(","),
        if holders.is_empty() {
            String::new()
        } else {
            format!("held by {}", holders.join(", "))
        },
    ]
}

/// Runs command `name`.
pub async fn run(name: &str, ctx: &mut Ctx) -> Result<Outcome> {
    match name {
        "list" => list(ctx).await,
        "connect" => connect(ctx).await,
        "disconnect" => disconnect(ctx).await,
        "info" => info(ctx).await,
        "storage" => storage(ctx).await,
        "pair" => pair(ctx).await,
        "forget" => forget(ctx).await,
        "bt-clear" => bt_clear(ctx).await,
        "ls" => ls(ctx).await,
        "get" => get(ctx).await,
        "follow" => follow(ctx).await,
        "put" => put(ctx).await,
        "rm" => rm(ctx).await,
        "mkdir" => mkdir(ctx).await,
        "mv" => mv(ctx).await,
        "run" => run_program(ctx).await,
        "program" => program(ctx).await,
        "stop" => stop(ctx, "programs/stop").await,
        "estop" => stop(ctx, "programs/emergencyStop").await,
        "telemetry" => telemetry_command(ctx).await,
        "config" => config(ctx).await,
        "status" => {
            ctx.at_most(0)?;
            status(ctx).await
        }
        "daemon" => daemon(ctx).await,
        other => Err(CliError::usage(format!("There is no command {other}."))),
    }
}

// --- bricks ---------------------------------------------------------------------------------

async fn list(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(0)?;
    let result = ctx
        .client()
        .await?
        .request("bricks/list", json!({ "waitForDiscovery": true }))
        .await?;
    let bricks = array(&result, "bricks");
    let human = if bricks.is_empty() {
        vec!["No bricks found.".to_owned()]
    } else {
        let mut rows = vec![
            ["NAME", "ID", "STATE", "LINKS", "HOLDERS"]
                .map(String::from)
                .to_vec(),
        ];
        rows.extend(bricks.iter().map(brick_line));
        table(&rows)
    };
    Ok(Outcome::new(Value::Array(bricks), human))
}

async fn connect(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.required_brick("the brick to connect")?;
    let brick = ctx
        .connect_brick(json!({ "brick": reference, "hold": true }))
        .await?;
    let name = text(&brick, "name").to_owned();
    Ok(Outcome::new(
        brick,
        format!("Connected {name}; it stays connected until ev3 disconnect {name}."),
    ))
}

async fn disconnect(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.brick_ref(Some(0))?;
    let mut params = serde_json::Map::new();
    if let Some(r) = &reference {
        params.insert("brick".into(), json!(r));
    }
    if ctx.flags.contains("all") {
        params.insert("forEveryone".into(), json!(true));
    } else {
        params.insert("releaseHold".into(), json!(true));
    }
    let result = ctx
        .client()
        .await?
        .request("bricks/disconnect", Value::Object(params))
        .await?;
    let name = reference.unwrap_or_else(|| "The brick".into());
    let still = strings(&result, "stillHeldBy");
    let human = if still.is_empty() {
        format!("Disconnected {name}.")
    } else {
        let verb = if still.len() == 1 { "holds" } else { "hold" };
        format!(
            "{name} stays connected: {} still {verb} it.",
            still.join(", ")
        )
    };
    Ok(Outcome::new(result, human))
}

async fn info(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.brick_ref(Some(0))?;
    let (id, _) = ctx.connected_brick(reference).await?;
    let result = ctx
        .client()
        .await?
        .request("bricks/info", json!({ "brick": id }))
        .await?;
    let mut rows = vec![
        vec!["Name".to_owned(), text(&result, "name").to_owned()],
        vec!["Id".to_owned(), text(&result, "brickId").to_owned()],
    ];
    if !text(&result, "firmwareVersion").is_empty() {
        rows.push(vec![
            "Firmware".into(),
            text(&result, "firmwareVersion").into(),
        ]);
    }
    if !text(&result, "osVersion").is_empty() {
        rows.push(vec!["OS".into(), text(&result, "osVersion").into()]);
    }
    Ok(Outcome::new(result, table(&rows)))
}

async fn storage(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.brick_ref(Some(0))?;
    let (id, name) = ctx.connected_brick(reference).await?;
    let result = ctx
        .client()
        .await?
        .request("bricks/storage", json!({ "brick": id }))
        .await?;
    let human = format!(
        "{name}: {} KB free of {} KB.",
        js_string(&result["freeKb"]),
        js_string(&result["totalKb"])
    );
    Ok(Outcome::new(result, human))
}

async fn pair(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.required_brick("the brick to pair")?;
    let json = ctx.json;
    let client = ctx.client().await?;
    if client.brick(&reference).await?.is_none() {
        if !json {
            eprintln!("Looking for {reference} over Bluetooth; keep it on and visible.");
        }
        if !client.find_by_inquiry(&reference, INQUIRY_WAIT).await? {
            return Err(not_heard(&reference));
        }
    }
    if !json {
        eprintln!("Pairing {reference}: confirm the pairing on the brick when it asks.");
    }
    let result = client
        .request("bricks/pair", json!({ "brick": reference }))
        .await?;
    // A pairing cancelled on the brick or here is no error.
    let (human, code) = match text(&result, "outcome") {
        "paired" => (format!("Paired {reference}."), exit::OK),
        "cancelled" => (format!("Pairing {reference} was cancelled."), exit::OK),
        other => {
            let message = result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the brick did not confirm the pairing.");
            (
                format!("Not paired: {message}"),
                if other == "failed" {
                    exit::FAILURE
                } else {
                    exit::OK
                },
            )
        }
    };
    Ok(Outcome::new(result, human).with_exit(code))
}

async fn forget(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.required_brick("the brick to forget")?;
    let result = ctx
        .client()
        .await?
        .request("bricks/forget", json!({ "brick": reference }))
        .await?;
    let mut human = vec![format!("Forgot {reference}.")];
    human.extend(
        strings(&result, "lines")
            .into_iter()
            .map(|l| format!("  {l}")),
    );
    Ok(Outcome::new(result, human))
}

async fn bt_clear(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.required_brick("the brick whose Bluetooth list to clear")?;
    let result = ctx
        .client()
        .await?
        .request("bricks/clearBluetoothList", json!({ "brick": reference }))
        .await?;
    let removed = strings(&result, "removed");
    let kept = strings(&result, "kept");
    let human = if removed.is_empty() && kept.is_empty() {
        let skipped = result.get("report").and_then(|r| r.get("skipped"));
        let why = match skipped {
            Some(s) => {
                let detail = text(s, "detail");
                format!(
                    ": {}{}",
                    text(s, "reason"),
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!(" ({detail})")
                    }
                )
            }
            None => String::new(),
        };
        vec![format!(
            "Nothing was removed from {reference}'s Bluetooth list{why}."
        )]
    } else {
        let mut lines = Vec::new();
        if !removed.is_empty() {
            lines.push(format!("Removed from {reference}'s Bluetooth list:"));
            lines.extend(removed.iter().map(|n| format!("  {n}")));
        }
        if !kept.is_empty() {
            lines.push("Still on the list:".into());
            lines.extend(kept.iter().map(|n| format!("  {n}")));
        }
        lines
    };
    Ok(Outcome::new(result, human))
}

// --- files ----------------------------------------------------------------------------------

async fn ls(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let folder = ctx.args.first().cloned().unwrap_or_else(|| PROJECTS.into());
    let (id, _) = ctx.connected_brick(ctx.brick.clone()).await?;
    let result = ctx
        .client()
        .await?
        .request("files/list", json!({ "brick": id, "path": folder }))
        .await?;
    let entries = array(&result, "entries");
    let human = if entries.is_empty() {
        vec![format!("{folder} is empty.")]
    } else {
        table(
            &entries
                .iter()
                .map(|e| {
                    let name = text(e, "name");
                    vec![
                        if text(e, "kind") == "directory" {
                            format!("{name}/")
                        } else {
                            name.to_owned()
                        },
                        e.get("bytes")
                            .map(|b| format!("{} B", js_string(b)))
                            .unwrap_or_default(),
                    ]
                })
                .collect::<Vec<_>>(),
        )
    };
    Ok(Outcome::new(Value::Array(entries), human))
}

async fn get(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(2)?;
    let remote = ctx.arg(0, "the file on the brick")?;
    let local = match ctx.args.get(1) {
        Some(local) => ctx.local_path(local),
        None => {
            let Some(name) = remote_file_name(&remote) else {
                return Err(CliError::usage(format!(
                    "{remote} names no file on the brick; give the file, or the local path to save it to."
                )));
            };
            ctx.local_path(name)
        }
    };
    let (id, _) = ctx.connected_brick(ctx.brick.clone()).await?;
    let mut result = ctx
        .client()
        .await?
        .request(
            "files/read",
            json!({ "brick": id, "path": remote, "toLocalPath": local }),
        )
        .await?;
    let bytes = js_string(&result["bytes"]);
    if let Some(object) = result.as_object_mut() {
        object.insert("localPath".into(), json!(local));
    }
    Ok(Outcome::new(
        result,
        format!("Copied {remote} to {} ({bytes} bytes).", local.display()),
    ))
}

/// Prints a file as it grows: its bytes as they are to stdout, or with `--json` one object per
/// growth (`offset`, `data` in base64) and one for the end (`ended`). Ends with Ctrl+C, when the
/// daemon ends the follow, or when nobody reads the output any more.
async fn follow(ctx: &mut Ctx) -> Result<Outcome> {
    use std::io::Write;
    ctx.at_most(2)?;
    let remote = ctx.arg(0, "the file on the brick")?;
    let from = match ctx.args.get(1) {
        Some(offset) => Some(offset.parse::<u64>().map_err(|_| {
            CliError::usage(format!(
                "{offset} is not an offset in bytes. Usage: {}",
                ctx.usage
            ))
        })?),
        None => None,
    };
    let (id, name) = ctx.connected_brick(ctx.brick.clone()).await?;
    let json = ctx.json;
    let client = ctx.client().await?;
    let mut follow = client.follow_file(&id, &remote, from).await?;
    if !json {
        eprintln!(
            "Following {remote} on {name} ({} bytes now); Ctrl+C stops.",
            follow.size
        );
    }
    let stop = interrupted();
    tokio::pin!(stop);
    let mut ended = None;
    loop {
        let event = tokio::select! {
            () = &mut stop => break,
            event = follow.next() => event,
        };
        let Some(event) = event else {
            return Err(CliError::unavailable(
                "The connection to the cockpit daemon closed while the file was followed.",
            ));
        };
        let heard = match event {
            ev3_client::FileEvent::Appended { offset, data } if json => say(
                &json!({ "offset": offset, "data": ev3_contract::base64::encode(&data) })
                    .to_string(),
            ),
            ev3_client::FileEvent::Appended { data, .. } => {
                let mut out = std::io::stdout().lock();
                out.write_all(&data).and_then(|()| out.flush()).is_ok()
            }
            ev3_client::FileEvent::Ended(reason) => {
                ended = Some(reason);
                break;
            }
        };
        if !heard {
            break;
        }
    }
    let reached = follow.reached();
    drop(follow);
    let reason = ended.map(|r| r.to_string());
    if json && let Some(reason) = &reason {
        say(&json!({ "ended": reason, "reached": reached }).to_string());
    } else if let Some(reason) = &reason {
        eprintln!("The follow ended: {reason}, at {reached} bytes.");
    }
    let mut outcome = Outcome::new(
        json!({ "brickId": id, "reached": reached, "ended": reason }),
        Vec::new(),
    );
    outcome.streamed = true;
    Ok(outcome)
}

async fn put(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(2)?;
    let local = ctx.local_path(&ctx.arg(0, "the file to copy")?);
    let remote = ctx.arg(1, "the path on the brick")?;
    if !local.exists() {
        return Err(CliError::Other(format!(
            "There is no file {}.",
            local.display()
        )));
    }
    let (id, _) = ctx.connected_brick(ctx.brick.clone()).await?;
    let result = ctx
        .client()
        .await?
        .request(
            "files/write",
            json!({ "brick": id, "path": remote, "fromLocalPath": local }),
        )
        .await?;
    let bytes = js_string(&result["bytes"]);
    Ok(Outcome::new(
        result,
        format!("Copied {} to {remote} ({bytes} bytes).", local.display()),
    ))
}

async fn rm(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let target = ctx.arg(0, "the path to remove")?;
    let (id, _) = ctx.connected_brick(ctx.brick.clone()).await?;
    let recursive = ctx.flags.contains("recursive");
    let result = ctx
        .client()
        .await?
        .request(
            "files/remove",
            json!({ "brick": id, "path": target, "recursive": recursive }),
        )
        .await?;
    let left = strings(&result, "leftBehind");
    let human = if left.is_empty() {
        vec![format!("Removed {target}.")]
    } else {
        let mut lines = vec![format!("Removed {target}, except:")];
        lines.extend(left.iter().map(|p| format!("  {p}")));
        lines
    };
    Ok(Outcome::new(result, human))
}

async fn mkdir(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let folder = ctx.arg(0, "the folder to make")?;
    let (id, _) = ctx.connected_brick(ctx.brick.clone()).await?;
    ctx.client()
        .await?
        .request(
            "files/makeDirectory",
            json!({ "brick": id, "path": folder }),
        )
        .await?;
    Ok(Outcome::new(
        json!({ "path": folder }),
        format!("Made {folder}."),
    ))
}

async fn mv(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(2)?;
    let from = ctx.arg(0, "the path to move")?;
    let to = ctx.arg(1, "where to move it")?;
    let (id, _) = ctx.connected_brick(ctx.brick.clone()).await?;
    ctx.client()
        .await?
        .request("files/move", json!({ "brick": id, "from": from, "to": to }))
        .await?;
    Ok(Outcome::new(
        json!({ "from": from, "to": to }),
        format!("Moved {from} to {to}."),
    ))
}

// --- programs -------------------------------------------------------------------------------

fn state_line(name: &str, state: &Value) -> String {
    if state.get("running").and_then(Value::as_bool) == Some(true) {
        return format!("A program runs on {name}.");
    }
    let by = text(state, "stoppedBy");
    if by.is_empty() {
        format!("No program runs on {name}.")
    } else {
        format!("No program runs on {name} (stopped by {by}).")
    }
}

async fn run_program(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let program = ctx.arg(0, "the program to run")?;
    let (id, name) = ctx.connected_brick(ctx.brick.clone()).await?;
    let mut params = json!({ "brick": id, "path": program });
    if ctx.flags.contains("replace") {
        params["replace"] = json!(true);
    }
    let result = ctx.client().await?.request("programs/run", params).await?;
    match text(&result, "outcome") {
        "uncertain" => {
            let human = format!(
                "The brick's answer to the start was lost: {program} may be running. Do not run it again; check its state first with ev3 program {name}."
            );
            Ok(Outcome::new(result, human).with_exit(exit::UNCERTAIN))
        }
        "started" => Ok(Outcome::new(
            result,
            format!("Started {program} on {name}."),
        )),
        _ => Ok(Outcome::new(
            result,
            format!(
                "Started {program} on {name}, but it was not seen running; it may have ended at once."
            ),
        )),
    }
}

async fn program(ctx: &mut Ctx) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.brick_ref(Some(0))?;
    let (id, name) = ctx.connected_brick(reference).await?;
    let state = ctx
        .client()
        .await?
        .request("programs/status", json!({ "brick": id }))
        .await?;
    let human = state_line(&name, &state);
    Ok(Outcome::new(state, human))
}

async fn stop(ctx: &mut Ctx, method: &str) -> Result<Outcome> {
    ctx.at_most(1)?;
    let reference = ctx.brick_ref(Some(0))?;
    let (brick, name) = ctx.stop_target(reference).await?;
    let params = brick.map_or_else(|| json!({}), |b| json!({ "brick": b }));
    let state = ctx.client().await?.request(method, params).await?;
    let human = state_line(&name, &state);
    Ok(Outcome::new(state, human))
}

// --- telemetry ------------------------------------------------------------------------------

async fn telemetry_command(ctx: &mut Ctx) -> Result<Outcome> {
    if ctx.flags.contains("list") {
        if !ctx.args.is_empty() || ctx.flags.contains("watch") {
            return Err(CliError::usage(format!(
                "--list takes nothing else. Usage: {}",
                ctx.usage
            )));
        }
        let result = ctx
            .client()
            .await?
            .request("telemetry/rows", json!({}))
            .await?;
        let rows = array(&result, "rows");
        let human: Vec<String> = rows.iter().map(telemetry::row_line).collect();
        return Ok(Outcome::new(Value::Array(rows), human));
    }
    let (id, name) = ctx.connected_brick(ctx.brick.clone()).await?;
    let rows = ctx.args.clone();
    let json = ctx.json;
    if ctx.flags.contains("watch") {
        if !json {
            eprintln!("Reading {name}; Ctrl+C stops.");
        }
        let client = ctx.client().await?;
        let brick_id = id.clone();
        let updates = telemetry::watch(&client.endpoint, &id, &rows, interrupted(), |values| {
            if json {
                return say(&json!({ "brickId": brick_id, "values": values }).to_string());
            }
            let time = clock();
            values
                .iter()
                .all(|value| say(&format!("{time}  {}", telemetry::value_line(value))))
        })
        .await?;
        let mut outcome = Outcome::new(json!({ "brickId": id, "updates": updates }), Vec::new());
        outcome.streamed = true;
        return Ok(outcome);
    }
    let reading =
        telemetry::read_once(&ctx.client().await?.endpoint, &id, &rows, READING_WAIT).await?;
    let mut human: Vec<String> = array(&reading, "values")
        .iter()
        .map(telemetry::value_line)
        .collect();
    let missing = strings(&reading, "missing");
    if !missing.is_empty() {
        human.push(format!("No value yet for {}.", missing.join(", ")));
    }
    let unavailable = strings(&reading, "unavailable");
    if !unavailable.is_empty() {
        human.push(if rows.is_empty() {
            format!(
                "{} more rows have no value with nothing on their ports or no daisy chain.",
                unavailable.len()
            )
        } else {
            format!(
                "No value for {}: nothing on the port, or no daisy chain that deep.",
                unavailable.join(", ")
            )
        });
    }
    Ok(Outcome::new(reading, human))
}

/// Resolves at the first Ctrl+C; a second one ends the process with 130.
async fn interrupted() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            std::process::exit(130);
        }
    });
}

/// The local time of day, `HH:MM:SS`.
fn clock() -> String {
    crate::clock::local(crate::clock::now_ms()).time()
}

// --- config ---------------------------------------------------------------------------------

/// The contract's settings, read once.
fn setting_specs() -> &'static [Value] {
    static SPECS: LazyLock<Vec<Value>> = LazyLock::new(|| {
        serde_json::from_str(ev3_contract::SETTING_SPECS_JSON).unwrap_or_default()
    });
    &SPECS
}

/// The setting a key names, by its CLI spelling or its contract key; a usage error for any other.
pub fn setting_spec(spelled: &str) -> Result<Value> {
    let specs = setting_specs();
    specs
        .iter()
        .find(|s| text(s, "cliKey") == spelled || text(s, "key") == spelled)
        .cloned()
        .ok_or_else(|| {
            let keys: Vec<&str> = specs.iter().map(|s| text(s, "cliKey")).collect();
            CliError::usage(format!(
                "There is no setting {spelled}. The settings are: {}.",
                keys.join(", ")
            ))
        })
}

/// A value as the setting's type reads it; the daemon checks the limits.
pub fn parse_setting_value(spec: &Value, input: &str) -> Result<Value> {
    let key = text(spec, "cliKey");
    match text(spec, "type") {
        "boolean" => match input {
            "true" => Ok(json!(true)),
            "false" => Ok(json!(false)),
            _ => Err(CliError::usage(format!("{key} is true or false."))),
        },
        kind @ ("number" | "integer") => {
            let value: f64 = input
                .trim()
                .parse()
                .ok()
                .filter(|v: &f64| v.is_finite() && !input.trim().is_empty())
                .ok_or_else(|| CliError::usage(format!("{key} is a number.")))?;
            if kind == "integer" {
                if value.fract() != 0.0 {
                    return Err(CliError::usage(format!("{key} is a whole number.")));
                }
                return Ok(json!(value as i64));
            }
            Ok(json!(value))
        }
        _ => {
            let allowed = strings(spec, "enum");
            if !allowed.is_empty() && !allowed.iter().any(|a| a == input) {
                return Err(CliError::usage(format!(
                    "{key} is one of {}.",
                    allowed.join(", ")
                )));
            }
            Ok(json!(input))
        }
    }
}

async fn config(ctx: &mut Ctx) -> Result<Outcome> {
    let sub = ctx.args.first().cloned().unwrap_or_else(|| "list".into());
    match sub.as_str() {
        "list" => {
            if ctx.args.len() > 1 {
                return Err(CliError::usage(
                    "Too many arguments. Usage: ev3 config list",
                ));
            }
            let result = ctx
                .client()
                .await?
                .request("settings/list", json!({}))
                .await?;
            let settings = array(&result, "settings");
            let rows: Vec<Vec<String>> = settings
                .iter()
                .map(|s| {
                    let spec = &s["spec"];
                    let value = js_string(&s["value"]);
                    let default = js_string(&spec["default"]);
                    vec![
                        text(spec, "cliKey").to_owned(),
                        value.clone(),
                        if s["value"] == spec["default"] {
                            String::new()
                        } else {
                            format!("(default {default})")
                        },
                    ]
                })
                .collect();
            Ok(Outcome::new(Value::Array(settings), table(&rows)))
        }
        "get" => {
            if ctx.args.len() > 2 {
                return Err(CliError::usage(
                    "Too many arguments. Usage: ev3 config get <key>",
                ));
            }
            let spec = setting_spec(&ctx.arg(1, "the setting")?)?;
            let result = ctx
                .client()
                .await?
                .request("settings/list", json!({}))
                .await?;
            let setting = array(&result, "settings")
                .into_iter()
                .find(|s| text(&s["spec"], "key") == text(&spec, "key"))
                .ok_or_else(|| CliError::Other(format!(
                    "The cockpit daemon does not have the setting {}; update the older of the two.",
                    text(&spec, "cliKey")
                )))?;
            let human = js_string(&setting["value"]);
            Ok(Outcome::new(setting, human))
        }
        "set" => {
            if ctx.args.len() > 3 {
                return Err(CliError::usage(
                    "Too many arguments. Usage: ev3 config set <key> <value>",
                ));
            }
            let spec = setting_spec(&ctx.arg(1, "the setting")?)?;
            let value = parse_setting_value(&spec, &ctx.arg(2, "the value")?)?;
            let result = ctx
                .client()
                .await?
                .request(
                    "settings/set",
                    json!({ "key": text(&spec, "key"), "value": value }),
                )
                .await?;
            let human = format!(
                "{} = {}",
                text(&spec, "cliKey"),
                js_string(&result["value"])
            );
            Ok(Outcome::new(result, human))
        }
        other => Err(CliError::usage(format!(
            "ev3 config has no {other}. Usage: {}",
            ctx.usage
        ))),
    }
}

// --- the daemon -----------------------------------------------------------------------------

fn status_lines(status: &Value) -> Vec<String> {
    let mut kind = if text(status, "buildKind") == "development" {
        "development build".to_owned()
    } else {
        "release".to_owned()
    };
    if text(status, "mode") == "replay" {
        kind.push_str(", replaying recordings");
    }
    let bricks = array(status, "bricks");
    // The brick a client shows, by its name where the daemon holds it.
    let shown = |id: &str| -> String {
        bricks
            .iter()
            .find(|b| text(b, "brickId") == id)
            .map_or_else(|| id.to_owned(), |b| text(b, "name").to_owned())
    };
    let clients: Vec<String> = array(status, "clients")
        .iter()
        .map(|c| match c.get("shows").and_then(Value::as_str) {
            Some(id) => format!(
                "{} ({}, shows {})",
                text(c, "name"),
                text(c, "kind"),
                shown(id)
            ),
            None => format!("{} ({})", text(c, "name"), text(c, "kind")),
        })
        .collect();
    let mut lines = vec![
        format!(
            "Cockpit daemon {} ({kind}, contract {}, pid {}), running since {}",
            text(status, "version"),
            js_string(&status["contractVersion"]),
            js_string(&status["pid"]),
            match status["startedAt"].as_i64() {
                Some(ms) => crate::clock::local(ms).date_time(),
                None => js_string(&status["startedAt"]),
            },
        ),
        format!("Channel: {}", text(status, "channel")),
        format!(
            "Clients: {}",
            if clients.is_empty() {
                "none".into()
            } else {
                clients.join(", ")
            }
        ),
    ];
    if bricks.is_empty() {
        lines.push("Held bricks: none".into());
    } else {
        lines.push("Held bricks:".into());
        lines.extend(table(
            &bricks
                .iter()
                .map(|b| {
                    let holders: Vec<String> =
                        array(b, "holders").iter().map(holder_name).collect();
                    let lease = text(b, "leaseHolder");
                    vec![
                        format!("  {}", text(b, "name")),
                        text(b, "brickId").to_owned(),
                        format!("held by {}", holders.join(", ")),
                        if !lease.is_empty() {
                            format!("{lease} is writing to it")
                        } else if b.get("reconnecting").and_then(Value::as_bool) == Some(true) {
                            "connecting again".into()
                        } else {
                            String::new()
                        },
                    ]
                })
                .collect::<Vec<_>>(),
        ));
    }
    lines.push(format!("Log: {}", text(status, "logPath")));
    lines
}

async fn status(ctx: &mut Ctx) -> Result<Outcome> {
    let result = ctx
        .client()
        .await?
        .request("daemon/status", json!({}))
        .await?;
    let human = status_lines(&result);
    Ok(Outcome::new(result, human))
}

async fn daemon(ctx: &mut Ctx) -> Result<Outcome> {
    let sub = ctx.args.first().cloned().unwrap_or_else(|| "status".into());
    ctx.at_most(1)?;
    match sub.as_str() {
        "status" => status(ctx).await,
        "restart" => restart(ctx).await,
        // Reads no daemon: the path is wanted most when the daemon cannot start.
        "log" => {
            let file = ctx.paths.log.clone();
            Ok(Outcome::new(
                json!({ "logPath": file }),
                file.display().to_string(),
            ))
        }
        other => Err(CliError::usage(format!(
            "ev3 daemon has no {other}. Usage: {}",
            ctx.usage
        ))),
    }
}

async fn restart(ctx: &mut Ctx) -> Result<Outcome> {
    let before = ctx.client().await?.daemon.pid;
    let answer = ask_to_exit(&ctx.client().await?.endpoint, EXIT_ANSWER).await;
    if answer.get("accepted").and_then(Value::as_bool) != Some(true) {
        let reason = answer
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("The cockpit daemon did not accept the restart.")
            .to_owned();
        // Nobody here could say yes: the same refusal as every other action that needs a person.
        if !confirm::can_ask(ctx.json) {
            return Err(CliError::needs_person(
                format!(
                    "{reason} A person has to run {RESTART_COMMAND} in an interactive terminal and confirm it."
                ),
                RESTART_COMMAND,
            ));
        }
        return Ok(Outcome::new(answer, reason).with_exit(exit::FAILURE));
    }
    let next = ctx.reconnect().await?.daemon.pid;
    let mut value = answer;
    if let Some(object) = value.as_object_mut() {
        object.insert("pid".into(), json!(next));
        object.insert("previousPid".into(), json!(before));
    }
    Ok(Outcome::new(
        value,
        format!("Restarted the cockpit daemon: pid {next} (was {before})."),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_names_the_brick_each_client_shows() {
        let status = json!({
            "version": "1.2.3", "contractVersion": 2, "pid": 7, "channel": "user",
            "logPath": "daemon.log",
            "clients": [
                { "name": "VS Code", "kind": "vscode", "shows": "0016530f0c0c" },
                { "name": "VS Code", "kind": "vscode", "shows": "0016530f0b0b" },
                { "name": "ev3", "kind": "cli" },
            ],
            "bricks": [{ "name": "CCC", "brickId": "0016530f0c0c", "holders": [] }],
        });
        let lines = status_lines(&status);
        let clients = lines
            .iter()
            .find(|l| l.starts_with("Clients: "))
            .expect("clients line");
        assert_eq!(
            clients,
            "Clients: VS Code (vscode, shows CCC), VS Code (vscode, shows 0016530f0b0b), ev3 (cli)"
        );
    }

    #[test]
    fn a_local_path_is_absolute_with_dot_and_dot_dot_resolved() {
        let cwd = if cfg!(windows) {
            PathBuf::from(r"C:\work\proj")
        } else {
            PathBuf::from("/work/proj")
        };
        let expect = |s: &str| {
            if cfg!(windows) {
                PathBuf::from(format!(r"C:\{}", s.replace('/', r"\")))
            } else {
                PathBuf::from(format!("/{s}"))
            }
        };
        assert_eq!(
            absolute_path(&cwd, Path::new("./a.rbf")),
            expect("work/proj/a.rbf")
        );
        assert_eq!(
            absolute_path(&cwd, Path::new("../x/./b.rbf")),
            expect("work/x/b.rbf")
        );
        assert_eq!(
            absolute_path(&cwd, Path::new("../../../../c.rbf")),
            expect("c.rbf")
        );
    }

    #[test]
    fn the_default_local_name_is_the_remote_files_name() {
        assert_eq!(
            remote_file_name("/home/root/lms2012/prjs/Demo/Demo.rbf"),
            Some("Demo.rbf")
        );
        assert_eq!(
            remote_file_name("/home/root/lms2012/prjs/Demo/"),
            Some("Demo")
        );
        assert_eq!(remote_file_name("Demo.rbf"), Some("Demo.rbf"));
        assert_eq!(remote_file_name("/"), None);
        assert_eq!(remote_file_name(""), None);
        assert_eq!(remote_file_name("/x/.."), None);
    }

    #[test]
    fn settings_are_named_by_their_cli_key_or_their_contract_key() {
        let spec = setting_spec("access-mode").expect("cli key");
        assert_eq!(text(&spec, "key"), "accessMode");
        assert_eq!(setting_spec("accessMode").expect("contract key"), spec);
        assert!(matches!(setting_spec("nope"), Err(CliError::Usage(_))));
    }

    #[test]
    fn a_value_is_read_as_its_settings_type() {
        let boolean = json!({ "cliKey": "b", "type": "boolean" });
        assert_eq!(
            parse_setting_value(&boolean, "true").expect("bool"),
            json!(true)
        );
        assert!(parse_setting_value(&boolean, "yes").is_err());
        let integer = json!({ "cliKey": "i", "type": "integer" });
        assert_eq!(parse_setting_value(&integer, "3").expect("int"), json!(3));
        assert!(parse_setting_value(&integer, "3.5").is_err());
        assert!(parse_setting_value(&integer, "").is_err());
        let choice = json!({ "cliKey": "e", "type": "string", "enum": ["safe", "full"] });
        assert_eq!(
            parse_setting_value(&choice, "full").expect("enum"),
            json!("full")
        );
        assert!(parse_setting_value(&choice, "wide").is_err());
    }

    #[test]
    fn a_brick_line_says_its_state_links_and_holders() {
        let brick = json!({
            "name": "CCC", "brickId": "usb:x", "connected": true,
            "channels": [{ "transport": "usb" }, { "transport": "bt" }],
            "holders": [{ "kind": "hold" }, { "kind": "client", "client": "VS Code" }],
        });
        assert_eq!(
            brick_line(&brick),
            vec![
                "CCC",
                "usb:x",
                "connected",
                "usb,bt",
                "held by ev3 connect, VS Code"
            ]
        );
    }
}
