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
- **Hosts:** the matrix below. The recording scripts (`scripts/*.mts`) need Node ≥ 22.18; they
  run on HOSTA only.
- **VS Code is deferred** (owner, 23.11.2026): until the whole backend works through `ev3` and
  `ev3 mcp`, the rounds drive the daemon with `ev3` and `ev3 mcp` only; F1 and `api-check` wait.

## Host matrix

The cockpit has to run everywhere it ships. HOSTA, HOSTB and the RPi5 are this round's hosts;
the rest run once the backend is complete.

| Host | System | Processor | Package | When |
|---|---|---|---|---|
| HOSTA | Windows 11 | x64 | win32-x64 | now |
| HOSTB | Ubuntu 26.04 | x64 | linux-x64 | now |
| RPi5 | Raspberry Pi OS 64-bit | arm64 | linux-arm64 | now |
| RPi2 | Raspberry Pi OS 32-bit | armv7 | none yet (a linux-arm target) | later |
| a laptop | antiX 64-bit | x64 | linux-x64 | later |
| a tablet | Windows 32-bit | x86 | win32-ia32 | later |
| a PC | antiX 32-bit | x86 | linux-ia32 | later |
| a PC | a minimal 32-bit Linux (planned) | x86 | linux-ia32 | later |
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

| Check | HOSTA | HOSTB | RPi5 |
|---|---|---|---|
| F2 USB | passed, AAA, BBB, CCC (23.11.) | | passed, CCC, from the pre-release npm packages (23.11.) |
| F2 Bluetooth | passed, BBB and CCC with Wi-Fi off (23.11.) | passed, CCC, paired without sudo or the bluetooth group (23.11.) | passed, CCC (23.11.) |
| F2 TCP (AAA) | passed after the fixes below; 45–255 ms a step (23.11.) | | |
| pairing, forget, list clearing | passed, CCC (23.11.) | | pairing passed, CCC, without the bluetooth group (23.11.) |
| `ev3 mcp` agent | passed, BBB over USB: 16 tool calls and a refused path outside the root (23.11.) | | |
| deploy-brick-off recorded | done, CCC (23.11.) | — | — |
| cable-pull recorded | done, CCC (23.11.) | — | — |
| F1, `api-check`, VS Code update | deferred with VS Code | — | — |

## Findings, 23.11.2026

- **Bluetooth beside Wi-Fi on HOSTA.** Its Realtek 8822CE is one card for Wi-Fi and Bluetooth.
  With Wi-Fi on, CCC over Bluetooth failed 6 of 15 steps (each 20–40 s, WSA 10060 and 10051);
  with Wi-Fi off, the same brick and pairing minutes later passed all 15 (60–250 ms a step).
  Not something the daemon can fix; its message could say so on Windows.
- **A broken pairing on the brick.** CCC listed six paired devices and no longer answered this
  computer (WSA 10051, no question on the display when pairing). `ev3 forget`, `ev3 bt-clear`
  over USB and `ev3 pair` brought it back.
- **A failing Bluetooth command takes 30–40 s** before it gives up; too long for a person. The
  limits are measured (a 15 s connect, one Bluetooth queue), so `ev3` now says after 3 s that it
  is connecting instead of staying silent.
- **`ev3 telemetry` without rows waited its full 5 s**: 40 of 69 rows (empty sensor ports, absent
  daisy-chain layers) never get a value. Fixed: a reading no longer waits for rows the brick
  cannot have now; 1.1 s on AAA after the fix.
- **An owner-run scenario beeped twice** (start notice and instruction); fixed, one beep now.
- **A held brick waits for every channel on each command.** `connect_again` joins every channel
  a signed-in brick has not connected, the paired Bluetooth one included, and waits for them. AAA
  held over TCP with its Bluetooth switched off made every `ev3` command wait about 40 s for the
  Bluetooth attempt to fail; on HOSTA that attempt also starved the Wi-Fi the TCP link ran over,
  and the link dropped (10054). In one connection, without those attempts, the file round trip
  over TCP passed in about a second. Fixed in `ev3`: a command uses a connected brick as it is;
  the TCP round on AAA then passed all 15 steps.
- **A join over Bluetooth makes a brick ask to pair.** On the RPi5, a brick connected over USB
  showed a pairing question by itself: the sign-in tried Bluetooth too, and the brick no longer
  knew that computer. The owner refused it. Not reproduced yet; issue #3.
- The Windows message for a brick that did not answer now says what helped here (Wi-Fi off on a
  shared card; forget and pair again for WSA 10051).
