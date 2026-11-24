# Security

## Reporting a vulnerability

Report it privately: on GitHub, open the repository's **Security** tab and choose **Report a
vulnerability**. Please do not open a public issue for it.

Say what is affected (the daemon, `ev3`, `ev3 mcp`, the VS Code extension or an add-on), the
version (`ev3 --version`, `ev3 daemon status`), the operating system, and how to reproduce it. A
report is acknowledged within a week; this is a small project with one maintainer, so a fix may
take longer, and you will hear how it goes.

## Supported versions

The project is in preview. Only the latest version on `master` and the latest release are
supported; a fix lands there.

## Scope

In scope:

- **The daemon** (`ev3-cockpitd`): its per-user channel (pipe or socket) and the key both sides
  prove in the hello, the state directory, the confinement of the local paths it reads and
  writes, the access modes (`safe`, `full`) and the questions only a person may answer.
- **`ev3` and `ev3 mcp`**: what an agent can reach through the MCP tools, the confinement to the
  roots the agent host declares, and the add-ons' tools `ev3 mcp` passes through.
- **The VS Code extension** and the client libraries, as far as they talk to the daemon.
- **The release artifacts**: their build provenance attestations and checksums.

Out of scope:

- **A process of the same user.** Any process running as the user can read the user's key and
  act as a client of the daemon; the trust boundary is the user account (see
  [docs/channel.md](docs/channel.md)), so this is not a vulnerability. A report that crosses from one user to another, or from an agent limited to
  `ev3 mcp` to more than its tools allow, is in scope.
- **The EV3 brick's firmware** and its protocols; report those to the firmware's maintainers.
- **Physical access** to the brick or the computer.

## What the cockpit does to protect a brick

Writes, removals and runs are limited to the brick's projects folder and SD card in `safe` mode
(the default); `full` mode is switched on only after a person says yes, and lasts until the
daemon ends. Forgetting a brick, clearing its Bluetooth list and restarting the daemon always ask
a person first.
