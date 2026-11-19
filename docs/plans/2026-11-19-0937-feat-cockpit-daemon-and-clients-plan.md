---
title: Cockpit Daemon and Clients - Plan
type: feat
date: 2026-11-19
topic: cockpit-daemon-and-clients
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Cockpit Daemon and Clients - Plan

## Goal Capsule

- **Objective:** Any tool on a user's computer — VS Code, a terminal command, a script, a Claude Code agent, an add-on such as EVƎ C — works with the user's EV3 bricks through one cockpit, and an add-on is written once for all of those environments.
- **Means:** A per-user cockpit daemon that alone holds the bricks and the settings, one typed client contract with one client library, and three clients built on it: the VS Code extension, the `ev3` CLI and the cockpit MCP server (IMPLEMENTATION_PLAN 4.10.2 and 4.10.3).
- **Product authority:** The owner, through the decisions of 19.11.2026 recorded below. The EVƎ C session reviews the protocol draft before it is built.
- **Open blockers:** None.

---

## Product Contract

### Summary

A per-user daemon becomes the only owner of the bricks and of all cockpit settings. One typed contract, published as a package, replaces API v1. One client library implements that contract, and the VS Code extension, the `ev3` CLI with git-style add-on subcommands and the cockpit MCP server all use it. To users the daemon is invisible: they see the cockpit in whatever tool they use.

### Problem Frame

Today only the VS Code extension can talk to a brick. A terminal command, a script or an agent in Claude Code cannot reach one at all, and two VS Code windows would fight over the same brick. An experienced programmer asked to drive the cockpit from Claude Code without VS Code. EVƎ C, the owner's C toolchain for the brick, has to build, upload and run programs from VS Code, from a shell (`build + upload + run`, printing the run's result), from a Claude Code agent and in CI, always on top of the cockpit. With the core now free of `vscode` (4.10.1, `scripts/core-smoke.js` drives a brick from plain Node), what is missing is a process that holds the bricks for every tool and a contract the tools share.

EVƎ C's hardware acceptance on API v1 also exposed what a shared owner must get right from the start: commands that failed during a momentary route loss, no reconnect event (subscriptions ended on every disconnect), a recursive remove that deletes one level, and interfaces copied by hand because none are published.

### Actors

- A1. User in VS Code — works with bricks through the cockpit extension and add-on extensions such as EVƎ C.
- A2. User in a terminal or script — runs `ev3 …` and add-on subcommands such as `ev3 c run`, often repeatedly.
- A3. AI agent — drives bricks through the cockpit MCP server or the CLI on the user's behalf.
- A4. Add-on — a separate package (EVƎ C first) that is a client of the daemon in every environment.
- A5. Daemon — the per-user process that holds the bricks and the settings.

### Key Decisions

- **The daemon comes before more EVƎ C work.** EVƎ C has to run in every environment the cockpit runs in, and its CLI needs the daemon. (session-settled: user-directed — chosen over continuing EVƎ C on API v1 first: EVƎ C must run in all environments, not only VS Code)
- **Add-ons are separate clients of the daemon, not plugins inside it.** Governs R16, R27. (session-settled: user-approved — chosen over plugins loaded by the daemon: a failing add-on must not take down brick management)
- **One `ev3` command; add-ons are git-style subcommands.** Governs R27. (session-settled: user-directed — chosen over a separate `ev3c` command: one entry point; EVƎ C changes its spec)
- **Each package has its own MCP server, and an add-on's never duplicates the cockpit's tools.** Governs R28. (session-settled: user-approved — chosen over one aggregated MCP server)
- **One daemon per user, started by the first client that needs it.** Governs R1, R2. (session-settled: user-approved — chosen over a system service)
- **The daemon ends with its last client and its last held brick; terminal use holds a brick explicitly with `ev3 connect`.** Governs R3, R5, R6. (session-settled: user-directed — chosen over an idle timeout and over keeping bricks for 60 s after each CLI command: holding is explicit and predictable)
- **Remembering bricks across daemon restarts is a setting, `wait` by default.** Governs R8. (session-settled: user-directed — chosen over always reconnecting: one user with one brick wants `auto`, users sharing bricks want to pick each time)
- **One repo publishes VSIX and npm packages with the same version; if a client and the daemon differ, the newest wins with a warning.** Governs R11, R31. (session-settled: user-directed — chosen over side-by-side daemons per version: the daemon holds the only hardware connection)
- **A newer client waits until the daemon is idle before replacing it.** Governs R11. (session-settled: user-approved — chosen over asking the user and over replacing at once: no running operation or connection is cut)
- **The daemon holds all settings; VS Code and the CLI change any of them, MCP servers cannot change dangerous ones.** Governs R22, R23. (session-settled: user-directed — chosen over allowing only a human at the CLI to switch to full mode and over letting every client change everything: an agent must never widen its own rights)
- **Reader/writer concurrency with a write lease.** Governs R20. (session-settled: user-approved — chosen over serialising all clients and over silent interleaving)
- **OS consent is asked in the name of whoever starts the daemon.** Governs R24. (session-settled: user-approved — chosen over a separate consent step)
- **Clients are TypeScript/Node only for now.** Governs R17. (session-settled: user-approved — chosen over a language-neutral schema from the start: every known client is TypeScript; a schema can be generated later)
- **The daemon is reachable only locally, by the same user.** Governs R14. (session-settled: user-approved — chosen over network access now or designed in for later: remote bricks are reached over SSH, as with HOSTD and the Mac)
- **One contract everywhere; API v1 is removed without a transition shim.** Governs R15, R16. (session-settled: user-directed — chosen over keeping API v1 as a shim and over every add-on speaking the raw protocol: EVƎ C is the owner's own project and needs no compatibility period)
- **No in-process fallback when the daemon cannot start.** Governs R10. (session-settled: user-approved — chosen over running the core inside the extension as today: one path to build and test)
- **JSON-RPC 2.0 in the style of LSP.** Governs R13. (session-settled: user-approved — chosen over HTTP over a socket, where events, cancellation and leases fit badly, and over MCP as the daemon's protocol, which is built for model tools rather than a typed API)
- **The daemon, the client library, the VS Code extension, the CLI and the MCP server are one body of work.** (session-settled: user-directed — chosen over the CLI now and the MCP server later)

### Requirements

**Daemon and lifecycle**

- R1. One daemon per user is the only process that holds bricks; every client works through it.
- R2. A client that finds no daemon starts one; two clients starting at the same moment end up with one daemon.
- R3. The daemon runs while at least one client is connected or at least one brick is held through `ev3 connect`, and exits once neither is true.
- R4. The daemon notices a client's departure even when the client crashes or is killed, without any message from it.
- R5. A brick a client connected is released when that client leaves, unless the brick is held through `ev3 connect`.
- R6. `ev3 connect <brick>` holds the brick past the command until `ev3 disconnect <brick>`; a command run without a held brick connects only for its own run.
- R7. While it runs, the daemon does what the cockpit does today: discovery, presence, telemetry of connected bricks, pairing, forgetting, programs and files.
- R8. A setting decides what happens to remembered bricks — those connected when the last long-lived client (the VS Code extension, an MCP server) left or the last held brick was disconnected: `auto` connects them as soon as the daemon sees them while a long-lived client is connected or a brick is held, also after a computer restart, and each belongs to that client as if it had connected it; `wait`, the default, remembers them and connects them only on Connect.
- R9. No client makes the user aware of the daemon as a separate thing to install, start or manage.
- R10. When the daemon cannot start, the client says so with the reason and the path of the daemon's log; the extension does not fall back to running the core itself.
- R33. The daemon keeps each brick's unsettled transfers (firmware slots to close, partial files to delete) in its per-user state, and the next daemon settles them before that brick's next transfer.
- R34. The extension in development or test mode, and any run with simulated bricks, starts its own daemon instance on its own channel; it never reaches the user's daemon, and no version replacement crosses between the two.

**Versions**

- R11. On connecting, a client built in this repo (the VS Code extension, the CLI, the cockpit MCP server) and the daemon compare versions: a newer client works with the older daemon, shows a "new version available" notice offering a restart, and replaces the daemon once it is idle — no write lease, no operation in progress, no brick connected; when the daemon is newer, the client shows the same kind of notice recommending an update.
- R35. An add-on carries no daemon: it compares only the contract version, never replaces the daemon, warns only when the daemon's contract cannot serve it, and when no daemon runs it starts the one installed with the cockpit, or tells the user to install the cockpit.

**Protocol and contract**

- R12. Clients and the daemon talk over a per-user local channel: a named pipe on Windows, a unix socket on Linux and macOS.
- R13. Messages are JSON-RPC 2.0 in the style of LSP: requests with responses, server-pushed events, cancellation of a running request, and progress.
- R14. Only processes of the same user on the same computer can connect; the daemon listens on no network port.
- R15. One typed contract, published as a package that add-ons import, replaces API v1; API v1 is removed, and EVƎ C and `scripts/api-check` move to the new contract.
- R16. One client library implements the contract over the protocol, and the VS Code extension, the CLI, the MCP servers and add-ons all use it.
- R17. Clients are TypeScript/Node.
- R18. Beyond what API v1 offers, the contract carries an explicit reconnect event, program-state events delivered to every subscribed client, cancellation of operations, and progress for uploads.
- R19. Subscriptions to program state, presence and telemetry survive a brick's reconnect and a daemon replacement without the client subscribing again.

**Concurrency and robustness**

- R20. Reads run concurrently; a mutating operation on a brick runs under a write lease, a second writer gets `brick_busy` naming the holder, and the lease ends with the operation or when its client leaves. Stopping a program and emergency stop are never refused by a lease: they run at once from any client, and the lease holder gets a program-state event naming who stopped it.
- R21. A momentary loss of a brick's route never fails an operation by itself: a command not yet sent waits for the route within the operation's time budget; a command whose reply was lost is not sent again — a file transfer restarts from its first chunk, and a program start is reported as uncertain rather than started again; once the budget is spent, the operation fails with its reason.

**Settings, access and consent**

- R22. The daemon holds every cockpit setting; the VS Code extension and `ev3 config` read and change all of them, access mode `full` included.
- R23. An MCP server, the cockpit's or an add-on's, cannot change a dangerous setting — access mode `full` and anything that widens rights or allows deleting outside `/home/root/lms2012/prjs` — and shows the user the exact command to run instead.
- R24. OS consent (Bluetooth and local network on macOS, BlueZ access and udev on Linux, Bluetooth on Windows) is asked in the name of whoever starts the daemon.

**Clients**

- R25. The VS Code extension becomes a client of the daemon: its commands and their behaviour stay as they are, and its settings view reads and writes the daemon's settings.
- R26. The `ev3` CLI covers: listing bricks, connect and disconnect (holding), brick info, files (list, read, write, remove), running and stopping a program, `config get|set`, daemon status including held bricks and lease holders, `daemon restart` (replaces the daemon on the user's command even though brick connections are cut; clients reconnect), and the path of the daemon's log; every command offers `--json` and exits non-zero on failure.
- R27. `ev3 <name> …` runs an installed add-on executable named `ev3-<name>`, found only in the directories on PATH — never the current working directory, on every OS — and run by its absolute path; add-ons get no other hook into the CLI.
- R28. The cockpit MCP server exposes the cockpit's operations to an agent as a thin layer over the client library.
- R29. A recursive remove deletes the whole tree on the brick, or reports what it left behind.

**Diagnostics and distribution**

- R30. The daemon writes a leveled, timestamped log file at a documented per-user path, with the client's name on each line, every notification shown to a user, and every failed brick command.
- R31. One repo builds the VSIX and the npm packages at the same version; publishing to the Marketplace or npmjs happens only on the owner's command.
- R32. Started from VS Code, the daemon runs on VS Code's own Node, so a VS Code user installs nothing else; started from the CLI, it runs on the system Node.

### Key Flows

- F1. VS Code session
  - **Trigger:** A1 opens VS Code.
  - **Steps:** The extension finds no daemon and starts one; the daemon discovers bricks as the cockpit does today; A1 connects a brick and works with it; A1 closes VS Code; the daemon releases the brick and, with no other client and no held brick, exits.
  - **Covered by:** R2, R3, R5, R7, R25
- F2. Repeated runs from a terminal or an agent
  - **Trigger:** A2 or A3 wants to run a program several times.
  - **Steps:** `ev3 connect CCC` starts the daemon and holds CCC; each `ev3 c run` connects to the daemon, takes a write lease, uploads and runs, prints the result and leaves; CCC stays connected between runs; `ev3 disconnect CCC` releases it and the daemon exits.
  - **Covered by:** R3, R6, R20, R26, R27
- F3. VS Code and a terminal on the same brick
  - **Trigger:** A1 has VS Code open on CCC while A2 runs `ev3 c run` on CCC.
  - **Steps:** Both are clients of the same daemon; reads from both proceed; the run's upload takes the write lease; a write from VS Code during it gets `brick_busy` naming the run; program-state events reach both.
  - **Covered by:** R1, R18, R20
- F4. A newer client meets an older daemon
  - **Trigger:** A2 updates the CLI while VS Code keeps the older daemon busy.
  - **Steps:** The CLI connects, sees the older daemon, works with it and shows that a new version is available; once the daemon is idle, or when A2 runs `ev3 daemon restart`, it is replaced by the newer one; clients reconnect and their subscriptions continue.
  - **Covered by:** R11, R19

### Acceptance Examples

- AE1. **Covers R4, R5.** Given VS Code is the only client and has CCC connected, when the VS Code process is killed, the daemon releases CCC and exits.
- AE2. **Covers R5, R6.** Given CCC is held through `ev3 connect` and VS Code also uses it, when VS Code closes, CCC stays connected and the daemon keeps running.
- AE3. **Covers R8.** Given the setting is `auto` and the user was signed in to CCC, when the computer restarts and the user opens VS Code, CCC connects as soon as the daemon sees it. Given `wait` instead, CCC is listed but stays disconnected until Connect.
- AE4. **Covers R20.** Given a run from the terminal holds the write lease on CCC, when VS Code tries to upload a file to CCC, the upload fails with `brick_busy` naming the terminal client, and reading CCC's files from VS Code still works.
- AE5. **Covers R23.** Given an agent asks the cockpit MCP server to switch to access mode `full`, the server refuses and replies with the exact `ev3 config set access-mode full` command for the user to run.
- AE6. **Covers R11, R26.** Given the daemon has CCC connected, when a newer CLI connects, the CLI works with the older daemon and shows that a new version is available; after CCC is disconnected and nothing runs, or right away on `ev3 daemon restart`, the newer daemon takes over.
- AE9. **Covers R20.** Given a run from the terminal holds the write lease on CCC and its program is running, when A1 presses Stop in VS Code, the program stops at once and the terminal run reports that VS Code stopped it.
- AE10. **Covers R21.** Given the reply to a chunk of an upload is lost when CCC's route drops, the daemon does not send that chunk again; once the route is back, the upload starts over from its first chunk.
- AE7. **Covers R21.** Given CCC's only channel drops for a moment during an upload, the upload continues once the route is back instead of failing with "no connected channel".
- AE8. **Covers R10.** Given the daemon cannot start, VS Code shows why and where its log is, and does not connect to bricks by itself.

### Success Criteria

- EVƎ C's `ev3 c run` works from a terminal and from a Claude Code agent while VS Code is open on the same brick, without either side failing on the other's activity.
- The VS Code extension behaves as before from the user's point of view: same commands, same results, and its settings view shows and changes the same settings, now stored by the daemon.
- Hardware runs pass on Windows and Linux over USB, Bluetooth and TCP through the daemon; macOS is covered by the GitHub macOS build and its unit tests, since the borrowed Mac has been returned.

### Scope Boundaries

**Deferred for later**

- Network access to the daemon; remote bricks are reached over SSH.
- Clients in languages other than TypeScript, and a language-neutral schema for them.
- Releasing bricks of a client that stays open but unused, and a time limit for bricks held through `ev3 connect`.
- Installing an add-on's MCP server together with the cockpit's (a Claude Code plugin bundling both).
- The Phase 5 UI.
- Publishing to the Marketplace and npmjs, and signing and notarising the macOS helper.
- Carrying existing VS Code setting values over to the daemon, and any backward compatibility: the cockpit is in alpha, so old values may be dropped.

**Outside this product's identity**

- A system-wide or multi-user daemon, or one running as an OS service.
- Add-ons as plugins loaded inside the daemon.

### Dependencies / Assumptions

- The native modules (`usb`, `node-hid`, `@serialport/bindings-cpp`, `koffi`, all N-API) and the Bluetooth helpers load when the daemon runs on VS Code's own Node on all three systems. Unverified; planning checks it first.
- The protocol research came mostly from the researcher's memory; only the Node `net` documentation on pipes and sockets was checked. Planning verifies the library's pipe and socket support and the default access rights of a Windows named pipe before relying on them.
- The borrowed Mac is gone; macOS changes are verified by the GitHub macOS workflow (`.github/workflows/vsix-macos.yml`) and unit tests only.
- EVƎ C moves to the new contract and the `ev3 c …` command form; its core already talks to the brick through one interface, so the move is one adapter.

### Outstanding Questions

**Deferred to Planning**

- Whether access is limited by the channel's rights alone or also by a per-session token, given how Windows sets a named pipe's default rights.
- How large a file can be before it is chunked, and whether file contents travel as base64.
- The exact list of dangerous settings, the CLI's command names and output shapes, and the log's path and rotation.
- How the extension's settings view maps onto the daemon's settings.
- How subscriptions persist across a daemon replacement (held by the daemon per client, or renewed by the client library).

### Sources / Research

- `IMPLEMENTATION_PLAN.md` 4.10.1, 4.10.1m, 4.10.2, 4.10.3; `docs/plans/2026-11-18-1008-refactor-core-without-vscode-plan.md` (deferrals to 4.10.2).
- `src/core/api/cockpitApi.ts` (API v1: `apiVersion` 1, `registerConsumer`, events without a reconnect event), `docs/api-for-consumers.md`, `src/vscode/extension.ts` (settings read from `ev3-cockpit` configuration), `scripts/api-check/`, `scripts/core-smoke.js`.
- EVƎ C's requirements, from its session on 19.11.2026; its plan in the ev3-c repo: `docs/plans/2026-11-18-1038-feat-program-run-contract-plan.md`.
- Prior art for the daemon's shape: adb (auto-start, version check, kill-server), Watchman and gpg-agent (per-user socket, single instance), LSP (JSON-RPC, cancellation, progress, capabilities).

---

## Deferred / Open Questions

Review items left for the author; they do not block implementation.

### From 2026-11-19 review

- **An agent with a shell can switch to full access mode by itself** — Key Decisions (settings and access), R22 (VS Code and `ev3 config` change every setting), R23 (MCP servers cannot change dangerous settings), AE5 (MCP refusal shows the command) (P1, product-lens, security-lens, adversarial, confidence 75)

  An agent in Claude Code can run `ev3 config set access-mode full` exactly as a person would, and then delete files on the brick outside the projects folder; the daemon cannot tell who typed the command, so today only the MCP path is guarded and the decision's promise that an agent never widens its own rights does not hold. Two outcomes were weighed: dangerous settings changed outside VS Code require an interactive confirmation in a real terminal that an agent cannot give (refused without a terminal or with `--json`), or the promise is narrowed to the MCP path and relies on Claude Code asking before it runs a command.
