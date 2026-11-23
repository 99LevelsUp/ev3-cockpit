# The native daemon's channel

How a client finds the per-user daemon `ev3-cockpitd`, proves itself, and talks to it. This is the
one written spec both sides follow: the Rust daemon (`daemon/crates/daemon`) and the TypeScript
client (`src/client/locate.ts`, `channel.ts`, `hello.ts`). Cross-language test vectors for the
hello proofs and `channel.json` are in `contract/vectors/channel.json`.

There is one daemon per user, on one channel shared by development and release builds. Automated
test runs start daemons on private test channels with their own state, never on the user's channel.

## State root and channels

The state root is the platform's state directory, then `ev3-cockpit/native/`:

| Platform | State directory |
|---|---|
| Windows | `%LOCALAPPDATA%` |
| macOS | `~/Library/Application Support` |
| Linux | `$XDG_STATE_HOME`, else `~/.local/state` |

The user's channel keeps its files in the state root. A test channel keeps them in
`channels/<name>/` under the root; a name matches `^[a-z0-9][a-z0-9-]{0,31}$`, so it can never leave
its directory. The key is in the root and is shared by every channel.

| File | Where | What |
|---|---|---|
| `key` | root | 32 random bytes, the user's key |
| `daemon.lock` | channel directory | the single-instance lock |
| `channel.json` | channel directory | where the pipe or socket is |
| `settings.json` | channel directory | stored settings |
| `held.json` | channel directory | the bricks held with `ev3 connect`, which the next daemon connects again |
| `ledger.json` | channel directory | unsettled transfers per brick |
| `runs.json` | channel directory | each brick's last `runSeq`, so the next daemon counts on |
| `daemon.log`, `.1`, `.2` | channel directory | the log, rotated at 5 MB, three files kept |

`key`, `daemon.lock`, `channel.json`, `settings.json`, `held.json`, `runs.json` and the temporary
files they are written through are readable and writable by the user alone from the moment they exist. On Windows that
is a protected DACL with a single entry, the user's SID with full access
(`D:P(A;;GA;;;<user SID>)`); on Linux and macOS mode `0600`. On Linux and macOS the directories the
daemon creates get mode `0700` and the log `0600`. On Windows the directories and the log inherit
the permissions of the profile directory they are created in (`%LOCALAPPDATA%` is the user's
alone), or of the test's state root.

## Command line

```text
ev3-cockpitd [--channel <name> [--state-root <dir>] [--report-release]
               [--fixtures <dir> [--replay matched|strict]]
               [--record-dir <dir> [--transports usb,bt,tcp]]]
             [--mode hardware|record|replay]
```

- No `--channel`: the user's channel, in the platform's state root.
- `--channel <name>`: a test channel.
- `--state-root <dir>`: an absolute state root used instead of the platform's. Accepted only
  together with `--channel`, so a test keeps its key and state away from the user's.
- `--fixtures <dir>`: the recording a test channel replays.
- `--replay`: how. `matched` (the default) answers each request with the recorded answer to an
  equal one, whatever the order and message counters; `strict` wants every recorded call in its
  recorded order with its recorded bytes, answering only discovery and presence checks matched,
  since how many of those a daemon makes depends on how long it runs. A strict replay checks at
  its end that every recorded call was made, and exits with code 1 when not.
- `--record-dir <dir>`: with `--mode record`, the absolute path of a directory that does not exist
  yet. The daemon creates it for the user alone (mode `0700`; on Windows a protected DACL granting
  the user full access, inherited by what is created inside) after it took the lock, refuses one
  that exists whoever owns it (exit code 3), and writes `recording.jsonl` there. Before recording
  it registers this computer's name, the user's name, its LAN addresses and its Bluetooth adapter's
  name and address (on Linux from BlueZ; a Bluetooth recording whose adapter address cannot be read
  is refused) with the recorder, which replaces those and every brick address it sees with the
  repository's placeholders as it writes. At its end the daemon checks the recording is complete,
  and exits with code 1 when not.
- `--transports`: the providers a recording uses, of `usb`, `bt` and `tcp`; every one the platform
  has without it. A brick reachable on several transports is joined on all of them, so recording
  one transport needs the others left out.
- `--report-release`: known only to development builds, and accepted only with `--channel`: the
  daemon reports itself as a release build, so a test can meet a release daemon without a second
  build. A release build does not know it and exits with code 64.
- `--mode`: `hardware` by default on the user's channel, `replay` on a test channel. A daemon on a
  test channel opens real hardware only in `record` mode, each provider wrapped by the recorder; the
  user's channel runs on the hardware and neither records nor runs on recordings. Any other
  combination is refused (exit code 3). Recording and replay run without the session heartbeat: a
  recorded exchange answers once, and a heartbeat would put exchanges between the scenario's that
  no replay makes in the same places.

### The build kind

The build kind is fixed when the binary is compiled. A build is `release` only when the release
packaging sets the environment variable `EV3_COCKPIT_RELEASE_BUILD=1` for the compile (read by the
daemon crate's `build.rs`, which turns it into the cfg `ev3_release_build`); every other build,
debug or optimised, is `development`. No environment variable, argument or setting read at run time
makes a release build report `development`.

| Exit code | Meaning |
|---|---|
| 0 | a clean end: idle, asked to exit, the key changed, or a signal |
| 1 | something failed that the daemon could not work around |
| 2 | another daemon holds this channel's lock |
| 3 | refused to run: elevated or root, a pipe or socket name someone else holds, a socket directory others can reach, a channel and mode that must not run together, or a recording directory that exists |
| 64 | the command line was not understood |

## Order of start

1. Refuse to run elevated (Windows: an elevated token) or as root (Linux: a real or effective user id
   of 0).
2. Check the channel and mode.
3. Take the lock. Nothing else is touched before it.
4. Read the key, or create it.
5. Draw the channel name, open the pipe or socket.
6. Write `channel.json`.

On Windows the daemon also restricts run-time DLL loads to System32 (`SetDefaultDllDirectories`
with `LOAD_LIBRARY_SEARCH_SYSTEM32`) before anything else. Its static imports are restricted the
same way by the link flag `/DEPENDENTLOADFLAG:0x800`, so a DLL planted beside the executable under
an imported name is never loaded.

## The key

- Only the daemon creates it. A client never creates, changes or deletes it.
- Creation: 32 bytes from the operating system's random source are written to a temporary file in
  the same directory, created owner-only, flushed, then hard-linked to `key`. A link never replaces
  an existing file: when two daemons start at once, the one whose link fails reads the other's key.
  The temporary file is removed either way.
- Readers retry a short or missing read (the client: 5 times, 20 ms apart). A key that stays
  shorter or longer than 32 bytes is refused.
- On Linux and macOS the daemon refuses a key that is a link, belongs to another user, or can be
  read by others.
- The daemon reads the key again on every new connection. When it changed or went away, the daemon
  closes that connection unanswered, releases the hardware it holds and exits.
- No message the daemon or a client shows ever tells a person to delete the key.

## The lock

The daemon takes an exclusive OS lock on `daemon.lock` before anything else and holds it for its
whole life. A daemon that cannot take it exits with code 2.

- **Windows.** The daemon opens `daemon.lock` for reading and writing with share mode 0 and keeps
  that handle open for its whole life, then locks the first byte with `LockFileEx`
  (`LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY`). A client's probe holds the file for a
  moment, so the daemon retries the share-none open for about one second on
  `ERROR_SHARING_VIOLATION` before it concludes another daemon holds it. The file is never made
  read-only: a client reads a refused open as "alive".
- **Linux and macOS.** An exclusive `flock` (`LOCK_EX | LOCK_NB`) on `daemon.lock`, opened with
  `O_NOFOLLOW`. The file is never removed, not even on a clean exit: a removed lock file would let
  two later daemons lock two different files.

### The client's liveness test

A client never takes the lock. It judges `channel.json` like this:

- No `channel.json`: no daemon.
- **Windows:** the client opens `daemon.lock` for writing without creating or truncating it.
  - The open fails with a sharing violation (`EBUSY` in Node) or `EPERM`: a daemon holds it.
    The client connects to the recorded pipe.
  - The open succeeds: no daemon holds the lock. While it still has the file open, so that no
    daemon can take the lock meanwhile, the client deletes `channel.json`, but only if its content
    is unchanged since it was read. Then it closes the file and reports no daemon.
  - The file is missing: no daemon; the record is deleted the same way.
- **Linux and macOS:** the record's `pid` must be alive (`kill(pid, 0)`, where `EPERM` counts as
  alive). The client then checks the socket's directory (below) and connects. A dead pid, or a
  connect that fails with `ENOENT` or `ECONNREFUSED`, makes the record stale; it is deleted only if
  unchanged.

A stale record's path is never contacted. A pipe or socket someone created under an earlier
daemon's name is therefore never spoken to.

## `channel.json`

```json
{"path":"\\\\.\\pipe\\ev3-cockpit-0f1e2d3c4b5a6978","pid":4242}
```

- `path`: the full named pipe path on Windows, the full socket path on Linux and macOS. `pid`: the
  daemon's process id. A reader ignores properties it does not know.
- Only the lock holder writes it, and only after its pipe or socket listens.
- Written atomically: an owner-only temporary file in the same directory, then a rename over the
  old record. A reader sees the old record or the new one, never a part; on Linux an unreadable
  record counts as stale.
- The daemon checks every 2 seconds that the record is still its own and writes it again if it
  disappeared.
- Removed on a clean exit, only if it is still the daemon's own.
- The daemon's own writer produces exactly the compact form above, keys in that order.

## The channel name

The daemon draws 16 random bytes at each start and computes

```text
hash = HMAC-SHA256(key, label || "\n" || nonce16)
label = "ev3-cockpit/channel"              for the user's channel
label = "ev3-cockpit/channel/<name>"       for test channel <name>
```

| Platform | Path |
|---|---|
| Windows | `\\.\pipe\ev3-cockpit-<first 8 bytes of hash, lowercase hex>` |
| Linux, macOS | `<socket dir>/daemon-<first 5 bytes of hash, lowercase hex>.sock` |

Nobody without the key can predict a name, and every start has a new one. Clients never compute
the name; they read it from `channel.json`.

### Windows: the pipe

- The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`. When a pipe of that name
  already exists, someone else holds the name: the daemon says so and exits with code 3.
- Every instance gets the owner-only DACL and `PIPE_REJECT_REMOTE_CLIENTS`.
- One instance always listens: when a client connects, the next instance is created before the
  connected one is handed out, so the name is never free for someone else to take.

### Linux and macOS: the socket

- The socket directory is `$XDG_RUNTIME_DIR/ev3-cockpit/`, else `run/` in the state root, never a
  shared directory such as `/tmp`.
- The daemon creates it with mode `0700` and refuses it (exit code 3) unless it is a plain
  directory, not a link, owned by the user, with no group or other permissions. Clients run the
  same check before they connect.
- The socket path must fit in `sun_path`: at most 107 bytes on Linux, 103 on macOS.
- The socket itself gets mode `0600` and is removed on a clean exit.

## Messages

JSON-RPC 2.0, framed as `vscode-jsonrpc` and LSP frame it: header lines `Name: value` ending in an
empty line, one of them `Content-Length` (any case; other headers are ignored), then that many
bytes of UTF-8 JSON.

- A declared length over 1 MiB (1 048 576 bytes), or a header block over 8 KiB, closes the
  connection before the body is read. A body that is not JSON closes it too.
- Requests run concurrently. `$/cancelRequest` with `{"id": <id>}` cancels a running request; it
  is still answered, with the contract error `cancelled`.
- Progress: a request that wants progress carries a token in `params.__progressToken`; the daemon
  removes it from the parameters and sends `$/progress` with `{"token": <token>, "value": ...}`.
- The daemon may send requests to a client (`question/ask`); the client answers them like any
  JSON-RPC response.
- An error is `{"code": <family number>, "message": <text ready to show>, "data": <ErrorData>}`.
  A client decides on `data.code`; `contract/methods.json` lists the codes and their families.
- When the daemon itself ends a connection, for example after answering `daemon/exit`, it first
  writes every queued answer, then waits up to 250 ms for the client to close its side.

## The hello

Nothing but the hello is answered until the client has proved it holds the key. Any other message
first, a malformed hello, a wrong proof, or a hello not finished within 10 seconds closes the
connection unanswered.

1. The client sends `hello/start`:
   `{clientNonce, clientName, clientKind, version, contractVersion, buildKind}`. `clientNonce` is
   fresh, lowercase hex, at least 32 digits; `clientName` is 1 to 200 characters.
2. The daemon answers `{daemonNonce, daemonProof}`, where `daemonProof` is the lowercase hex
   HMAC-SHA256 with the key over `"daemon\n<clientNonce>\n<daemonNonce>"`. A client that cannot
   verify it is talking to something else; it closes and sends nothing more.
3. The client sends `hello/finish` with `{clientProof}`, the same HMAC over
   `"client\n<clientNonce>\n<daemonNonce>"`. The daemon compares it in constant time and closes
   the connection on a mismatch.
4. The daemon answers
   `{version, contractVersion, buildKind, buildId, mode, pid, instanceId, state?, transports?}`:
   - `buildKind` is fixed when the binary is built;
   - `buildId` is the SHA-256 of the daemon's executable, computed at start;
   - `mode` is `hardware` or `replay`;
   - `state` is `serving`, or `exiting` once the daemon is about to end.

The daemon never refuses a hello for its contract version: a client on another version reads the
daemon's from the answer and decides for itself. Of the methods, a client whose `contractVersion`
differs from the daemon's is served only the stable core, `daemon/exit`, which must reach any
daemon; every other request is answered with `invalid_request` naming both versions, and the
daemon logs the mismatch. A `clientKind` the daemon does not know reads as `mcp`, the least
privileged. A `buildKind` it does not know reads as `release`.

Client kinds and build kinds are what the client says. The key proves only that the client runs
as the user: the trust boundary is the user account. A process that can read the key can claim
to be `vscode` and answer its own question, or claim a development build. Client kinds keep
honest clients, and agents driving them, from actions a person must take; they are not a
defence against another program of the same user, which could read the cockpit's files itself.

## The daemon's life

- It exits 10 seconds after its last connection closed while nothing keeps it (no brick held).
  The time also counts from the start, so a daemon nobody connects to ends too.
- It ends when the key changes, or on Ctrl+C / `SIGTERM`.
- A clean end releases the hardware, removes `channel.json` if it is still its own, and on Linux
  the socket, then releases the lock. The holds left with `ev3 connect` stay in `held.json`, and the
  next daemon connects those bricks again at its start without any client asking.

### `daemon/exit`

The daemon judges an exit request from the asking client's hello (`clientKind`, `buildKind`,
`version`), never from the request:

| Daemon | Asking `vscode` or `cli` client | What the request is |
|---|---|---|
| release | release, newer `version` | a replacement |
| release | release, equal or older `version` | a restart |
| release | development, any `version` | a replacement |
| development | any | a restart |

An `addon` client's request is always a restart: its version and build kind are the add-on's, and
it carries no daemon of its own.

- Versions compare as the clients compare them: the first three parts split at `.`, `+` and `-`,
  each read by its leading digits, missing parts as 0.
- A **replacement** asks nobody: installing a newer release or building a development build is the
  person's own act.
- A **restart** runs only after a person said yes to a `restart` question naming the asking client,
  put to that client if it has a person at it (`vscode`, `cli`), else to the VS Code window or the
  terminal that connected last. No, silence for 60 s, or nobody to ask refuses it.
- An `mcp` client may not send `daemon/exit` at all (`access_denied`).
- Either way the daemon ends only once no write is in progress: a leased operation (files,
  programs, shell, a forget or a clear of a Bluetooth list), a pairing, or a write the runtime
  reports. It waits at most 60 s. Once none runs it starts no new leased write (`daemon_unavailable`)
  and ends right after the answer.
- The answer comes when that is decided, so a request may take up to two minutes: 60 s for the
  person, then up to 60 s for a write. `{"accepted": true}` means the daemon is ending;
  `{"accepted": false, "reason": ...}` means it keeps running, with the reason ready to show (the
  restart declined or unanswered, nobody to ask, or a write still running after 60 s).

## Local paths

Every file method that takes a local path a client names, to read from or to write to, runs it
through one check. The daemon refuses a path that resolves, through links and junctions, into the
cockpit's own state root (the platform's and a test's), the directory of its executable, or its
socket directory, whoever the client is.

- A relative path is refused.
- A path that does not exist yet resolves through its deepest existing ancestor.
- After that ancestor, `..` or a link whose target is missing is refused.
- On Windows the OS removes `..` from a path by its letters before it follows anything, and the
  check resolves the path the same way.
- The file is checked again once it is open, by the final path of its handle, so a link made
  between the check and the open is caught. A new file is created only after its folder passed
  that check.
- A file with more than one name (a hard link) is refused when one of its names lies in those
  directories, and when the daemon cannot make sure none does.

The check is on the file the path finally reaches. It is not a defence against another process
of the same user swapping folders while the daemon opens a file: such a process can reach the
cockpit's files directly (see the trust boundary under the hello). Links inside the cockpit's
directories that lead back out, a local share naming the same volume, alternate data streams
and special files are not covered either.
