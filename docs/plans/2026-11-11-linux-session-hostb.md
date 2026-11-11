---
title: Linux session on HOSTB — runbook for the Claude Code session there
date: 2026-11-11
status: ready
---

# Linux session on HOSTB (Ubuntu) — runbook

You are the Claude Code session on the owner's Ubuntu computer (called HOSTB in this repo). This
document is self-contained: you have not seen the Windows sessions that wrote it. The owner is at
the desk with the EV3 bricks. Talk to him in Czech; he answers questions about the hardware.

## Goal

The cockpit has so far run only on Windows. Linux is part of the release (REQUIREMENTS §12), but
nothing on Linux has been tried. Tonight answers four questions, each with a verdict against the
rule written below **before** you run it:

1. Does the project build, and do its unit tests pass, on Linux? (L1)
2. Does the extension activate, and do mock bricks work, in VS Code on Linux? (L2)
3. Does a real brick work over USB on Linux, through every layer? (L3, L4)
4. What does BlueZ on this machine offer, so the Linux Bluetooth backend (IMPLEMENTATION_PLAN
   1.11.11, not built yet) can be designed from facts? (L5, L6)

What is **not** expected to work: Bluetooth inside the cockpit. Its pairing helper is a Windows
program (`native/bt-pairing-helper`, .NET Framework 4.8 + WinRT) and its Bluetooth sockets go
through Winsock; on Linux both must report themselves unavailable, cleanly. That is checked (L3),
not fixed.

## Rules for this session

- **Results go to a branch, never to `master`:** `git switch -c linux-session-2026-11-11`, write
  `docs/plans/linux-session-results/2026-11-11-hostb.md`, commit, `git push -u origin
  linux-session-2026-11-11`. The Windows session folds the results into the plans.
- **The repo is public. Never commit a real MAC address, brick serial, hostname, user name or
  home path.** Bricks are AAA, BBB, CCC; if a MAC must appear, use `00:16:53:F0:0A:0A` (AAA),
  `…F0:0B:0B` (BBB), `…F0:0C:0C` (CCC). This computer is HOSTB. Replace values in pasted logs
  before they go into the results file.
- **The repo's history was rewritten on 11.11.2026.** Clone it fresh; an older clone cannot be
  pulled.
- **Security:** never disable, bypass or weaken any OS, network or program protection. Installing
  a udev rule for the EV3's USB device and using `bluetoothctl` are ordinary configuration; ask
  the owner before any `sudo` command and say exactly what it does. Do not run anything as root
  that the scenario does not name.
- **Beep before every step that needs the owner at a brick** (`printf '\a'`, or `paplay` a system
  sound), so he knows when to watch the brick's display.
- **Stop and ask the owner** when a step needs hardware you do not have, when a result contradicts
  this runbook, or when something hangs for longer than its stated limit. Do not work around it.
- Every result gets a verdict: **holds**, **fails**, or **not run** with the reason.

## Setup

1. Node.js ≥ 20 (`node -v`), npm, git, build tools for native modules (`build-essential`,
   `python3`, `libudev-dev` for `node-hid`/`usb`). Report what is missing; ask before installing.
2. `git clone https://github.com/99LevelsUp/ev3-cockpit && cd ev3-cockpit && npm ci`.
   Record whether `usb`, `node-hid`, `koffi`, `serialport` built or loaded prebuilt binaries
   (they are optional dependencies; a failed one is a result, not a blocker).
3. USB access without root — EV3 is vendor `0694`, product `0005`. Proposed rule (ask first):

   ```
   # /etc/udev/rules.d/70-lego-ev3.rules
   SUBSYSTEM=="usb", ATTRS{idVendor}=="0694", ATTRS{idProduct}=="0005", MODE="0660", TAG+="uaccess"
   KERNEL=="hidraw*", ATTRS{idVendor}=="0694", ATTRS{idProduct}=="0005", MODE="0660", TAG+="uaccess"
   ```

   then `sudo udevadm control --reload && sudo udevadm trigger`, and replug the brick.

## Scenarios

### L1 — build and unit tests

- Run: `npm run compile`, `npm run lint`, `npm run test:unit`.
- **Rule:** compile and lint clean; every unit test passes. A test that fails only on Linux is a
  finding — record its name and message, do not change it.
- `npm run test:host` needs a display; try `xvfb-run -a npm run test:host` if `xvfb` is there.

### L2 — the extension in VS Code, mock bricks

- `npm run build:dev`, then open the folder in VS Code and press F5 ("Run Extension"). In the
  Extension Development Host, mock bricks are on by default when running from source.
- Command palette: "EVƎ Cockpit: Connect a Brick" → pick a mock brick; "List Projects";
  "Show Storage". Output panel → "EVƎ Cockpit".
- **Rule:** the extension activates; the log shows "EVƎ Cockpit activated"; a mock brick connects
  and both filesystem commands answer. No error notification other than Bluetooth's (L3).

### L3 — Bluetooth reports itself unavailable, cleanly

- In the same host, with a real brick's Bluetooth on: read the log after activation and after
  "Connect a Brick".
- **Rule:** no crash, no unhandled exception, no repeating error every few seconds; the log says
  why Bluetooth cannot be used ("needs the Windows Bluetooth helper; this host is linux", or the
  Winsock loader's refusal). Copy the exact lines (with identifiers replaced).

### L4 — a real brick over USB, every layer

- Beep, ask the owner to plug in one brick (say which) over USB and switch it on.
- `lsusb | grep 0694`; `ls -l /dev/hidraw*`.
- Run: `node scripts/hardware-matrix.js --quick` (no VS Code needed; it prints a table per
  brick × transport and exits non-zero on a failure). Then without `--quick` (filesystem and
  telemetry too).
- **Rule:** the brick is discovered over USB with its name; connect, `info`, the filesystem checks
  and the telemetry checks pass. Record which USB backend ran (libusb or node-hid — the log line
  "USB transport — libusb available…" or the fallback), and any `LIBUSB_ERROR_BUSY` /
  `LIBUSB_ERROR_ACCESS`: on Linux the kernel's `usbhid` driver may hold the interface, and the
  cockpit does not detach it today (a finding, not a fix for tonight). IMPLEMENTATION_PLAN 4.6.16
  asks exactly whether the libusb path works on Linux.
- Then in VS Code (L2's host, mock bricks off: workspace setting `"ev3-cockpit.mockBricks": false`):
  "Connect a Brick" → the real brick; "List Projects". **Rule:** connects over USB and lists files.
- Optional, if a brick has a Wi-Fi dongle on the same network: the same over TCP.

### L5 — BlueZ survey (facts for the Linux Bluetooth backend)

Record, without the MAC addresses:

- `bluetoothctl --version`, `uname -r`, the adapter model (`bluetoothctl show`, `lsusb`/`lspci`).
- Beep; owner switches a brick's Bluetooth on and visible. `bluetoothctl` → `scan on`: is the brick
  seen, by name, how fast? `scan off`.
- Pairing: `bluetoothctl` → `agent KeyboardDisplay`, `default-agent`, `pair <brick>`. Beep first:
  the brick shows a confirmation dialog, then may ask for a PIN; the EV3 PIN is `1234`. Record
  every prompt on both sides and the result; `info <brick>` (Paired, Trusted, UUIDs — is the
  Serial Port `00001101-…` listed?).
- Does the brick list this computer afterwards? (Brick menu: Bluetooth → Connections → Favorites.)

### L6 — an RFCOMM socket to the brick

- Build the packet with the repo's own encoder (after `npm run compile`), never by hand:

  ```
  node -e "const c=require('./out/protocol/ev3Commands.js'),p=require('./out/protocol/ev3Packet.js');const e=c.buildCommand({kind:'info'});console.log(Buffer.from(p.encodeEv3Packet(1,e.type,e.payload)).toString('hex'))"
  ```

- From Python (no extra packages): `s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM,
  socket.BTPROTO_RFCOMM)`, `s.connect((mac, 1))`, `s.send(bytes.fromhex(<the hex above>))`,
  `s.recv(1024)`. Decode the reply with `out/protocol/ev3Packet.js` `decodeEv3Packet` (its type
  should be the direct reply) — the brick's name is in its payload as ASCII.
- **Rule:** the socket opens on channel 1 and the brick answers with its name. Record the time to
  connect, and what happens on a second connect right after closing (the Windows sessions found a
  cooldown matters there).
- Node: does `koffi` load `libc.so.6` and can it call `socket(31 /*AF_BLUETOOTH*/, 1, 3)`? Record
  only whether it returns a descriptor; close it. This decides whether the Linux backend can live
  in the extension or needs a helper process like Windows.

## Results file

`docs/plans/linux-session-results/2026-11-11-hostb.md` on the branch: a header (date, Ubuntu
version, kernel, Node, BlueZ, adapter model — no serials), then one table per scenario: what was
run, the rule, the verdict, the evidence (log lines with identifiers replaced, timings). End with
"Findings" — anything unexpected, each in two sentences — and "Not run" with the reasons.

## Copy-paste prompt for the HOSTB session

> V repu `99LevelsUp/ev3-cockpit` je návod `docs/plans/2026-11-11-linux-session-hostb.md`. Repo
> naklonuj znovu (historie byla 11.11.2026 přepsaná). Přečti celý návod a proveď scénáře L1–L6
> s vlastníkem u kostek. Výsledky zapiš do větve `linux-session-2026-11-11` a pushni ji. Do repa
> nesmí jít žádná skutečná MAC adresa, sériové číslo ani jméno počítače.
