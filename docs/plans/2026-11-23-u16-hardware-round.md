# U16 hardware round — runbook

The step-by-step order for the hardware sign-off (U16 of
`2026-11-20-1845-refactor-native-daemon-plan.md`). The owner does every step at the brick; the
agent gives one instruction at a time, says beforehand what to watch or measure, beeps before a
brick action and reads the daemon log itself. Results go into the checklist at the end, with
bricks named AAA/BBB/CCC only.

## Before the round

- **Build under test:** the master tip's CI artifacts (`native-daemon.yml`: the npm platform
  packages carry `ev3` and `ev3-cockpitd`) or a local `npm run daemon:build` on HOSTA. Write the
  version (`ev3 --version`) and the commit into the checklist.
- **Hosts:** HOSTA (Windows x64, VS Code), HOSTD (Debian x64 over ssh), the RPi5 (Linux arm64).
  The recording scripts (`scripts/*.mts`) need Node ≥ 22.18; they run on HOSTA only.
- **Bricks:** AAA (Wi-Fi dongle, the TCP brick), BBB, CCC; all charged, on the main menu, no
  `CockpitFixture` folder in the projects folder.
- **No stray processes:** on each host, list processes by command line and confirm no other
  `ev3-cockpitd`, no `node … scripts/` probe and no old Node daemon runs. Stop one only after its
  PID and command line are confirmed.
- **Log:** `ev3 daemon log` prints the log's path; the agent tails it during each step.

## F1 — VS Code on HOSTA

One transport at a time: USB (CCC), Bluetooth (BBB), TCP (AAA).

1. Open the EVƎ view. **Watch:** the brick appears with its name and the transport letter; note
   how many seconds after VS Code starts.
2. Connect. **Watch:** the connected mark, battery and firmware shown.
3. Files: make a folder, upload a small file, open it, rename it, delete the folder.
4. Deploy and run a program; stop it from VS Code. **Watch:** the run state in the view changes
   within a second of the brick's display.
5. Telemetry: open the brick's telemetry for a minute. **Watch:** values change; no stall longer
   than about 2 s (estimate).
6. Bluetooth only: forget BBB, pair it again from VS Code (confirm on the brick), connect.
7. Close VS Code. **Measure:** the daemon process ends about 10 s after the last client leaves.

## F2 — `ev3` and `ev3 mcp`

On HOSTA in PowerShell and in Git Bash; on HOSTD and the RPi5 in a shell over ssh (USB and
Bluetooth where the host has the brick; TCP to AAA from any host on its network).

1. `ev3 list`, `ev3 connect <brick>`, `ev3 info`, `ev3 storage`.
2. `ev3 mkdir`, `ev3 put`, `ev3 ls`, `ev3 get`, `ev3 mv`, `ev3 rm -r`.
3. `ev3 run <program>`, `ev3 program`, `ev3 stop`; `ev3 estop` while a motor turns.
4. `ev3 telemetry --watch` for 30 s, then Ctrl+C. **Watch:** it ends at once, exit code 0.
5. Bluetooth: `ev3 forget <brick>` (asks first), `ev3 pair <brick>` (confirm on the brick).
6. `ev3 status` and `ev3 daemon status`: the clients, held bricks and which brick VS Code shows.
7. `ev3 mcp` from an agent session (Claude Code) against CCC while VS Code is open on HOSTA:
   list, info, a file round trip, a program run. **Watch:** VS Code shows the agent as a client.

## `api-check`

On HOSTA, one brick per transport: `npm run compile`, then
`code --extensionDevelopmentPath=<repo>/scripts/api-check`. Answer its questions at the brick;
it writes `~/ev3-api-check.txt`, which the agent reads.

## Recordings (HOSTA, CCC on USB)

1. **deploy-brick-off** (never recorded):
   `node scripts/hardware-scenario.mts deploy-brick-off --daemon <ev3-cockpitd> --brick CCC --out <dir> --transport usb --owner-present`.
   After the beep, pull CCC's battery within eight seconds. **Watch:** the script prints that the
   USB channel is no longer connected. Then put the battery back, switch CCC on and run the
   `remove-folder` scenario into a scratch directory.
2. **cable-pull** (re-record; the earlier recording was lost):
   `node scripts/cable-pull-probe.mts --daemon <ev3-cockpitd> --brick CCC --out <dir>`. Three beeps:
   pull the USB cable; one long beep: plug it back in. **Measure:** nothing by hand — the probe
   prints how long the daemon took to notice the loss and to bring CCC back.
3. Search each `recording.jsonl` for identifiers (MAC addresses, host names, user paths) and
   replace them with the placeholders before it goes into `daemon/fixtures/service/`.

## VS Code update on Windows

With the daemon running (an `ev3 connect` holds a brick), install a VS Code update. **Watch:** the
update finishes without a "file in use" error; the daemon keeps running from its own copy.

## Checklist

| Check | HOSTA | HOSTD | RPi5 |
|---|---|---|---|
| F1 USB / BT / TCP | | — | — |
| F2 USB | | | |
| F2 Bluetooth | | | |
| F2 TCP (AAA) | | | |
| `ev3 mcp` agent | | — | — |
| `api-check` | | — | — |
| deploy-brick-off recorded | | — | — |
| cable-pull recorded | | — | — |
| VS Code update while running | | — | — |
