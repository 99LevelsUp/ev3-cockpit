# Step 1: close the historical gaps, using what the communication lab found

**Status, 29.10.2026:** approved by the owner. **U1 done** (the 03–10.09 work landed in themed
commits, reviewed, eight confirmed findings fixed or deferred — #2 goes with D2). **U2 done**
(plan and code agree; 2.8.11 and 2.8.16 closed). **U4.4 and U4.5 measured** on psk1 (see U4).
Open: U3, U4.1–U4.3. D1 and D3 still to confirm; D2 decided; D4 done as proposed.
Lab-side corrections are out of scope: the lab is an auxiliary project (owner, 29.10.2026).

**Inputs read:** `ev3-lab-communication` at `f5d5458` (`results/REPORT.md` §Rozhodnutí,
`docs/findings/win32-bt-2026-10.md`, `docs/findings/win32-otos-usb-tcp-2026-10.md`,
`REQUIREMENTS.md` §1.5), this repo's working tree, `IMPLEMENTATION_PLAN.md`, MemPalace diary
of 28.10.2026. The lab's conclusions are treated as recommendations; §2 says where this plan
agrees and where it departs.

---

## 1. What "historical gaps" means here

Four things, in order of how much they cost if left alone:

1. **Eight weeks of work that was never committed.** 33 paths (23 modified, 10 untracked),
   written 03.09–10.09.2026. Two themes:
   - **03–04.09** — WinRT pairing helper wired into the extension (`btPairingHelper.ts`,
     `native/`, the *Connect a Brick over Bluetooth* command), scan mode, the three brick
     setting commands (`brick:setName`, `brick:setBluetooth`, `brick:setBluetoothVisible`),
     ordering removed from discovery, `bt-scenario-matrix.js`, `brick-settings-probe.js`.
   - **10.09** — telemetry loop and service (`brickTelemetry.ts`, `telemetryService.ts`,
     `telemetryConstants.ts`), `TransportCapabilities.supportsTelemetryFrames`, frames routed
     through the per-brick `CommandQueue`, `telemetry-queue-probe.js`.

   Gate on the working tree, 29.10.2026: `compile` clean, `lint` clean, **418/418 unit**,
   **4/4 extension-host** — the full `test:ci` passes.
2. **The plan no longer describes the code.** Header says *Version 2026-08-20*; §2 says 379
   unit tests and that 2.8.18 is "not yet wired" (it is wired, see `extension.ts:244`);
   4.6.1 is unchecked although `FileTransferService` sends `CONTINUE_DOWNLOAD` /
   `CONTINUE_UPLOAD`. §2 itself warns that it drifts — it did again.
3. **Open BT threads the lab has now answered** (2.8.11, 2.8.16) still read as unexplained,
   and code comments still justify behaviour with numbers the lab has since contradicted.
4. **Behaviour that goes against the lab's evidence** — two concrete cases in §3.

## 2. Own reading of the lab

### 2.1 The formal verdict and what it actually means

`REPORT.md` calls every channel on every platform *nerozhodnutelné*. That is true under its
rule 8, which counts **every** scenario the catalogue lists as measurable — including ones the
lab has not written yet (S4.2–S4.5, S5.2–S5.6, S6, S7). It is not a statement that the data
disagree.

What the data do support, for **Windows**:

| Channel | Lab data | Cockpit today | Reading |
|---|---|---|---|
| USB | libusb and node-hid both PASS 36/36 series, two hosts, identical; libusb 1024 B frame, node-hid 64 B; node-hid returns a generic USB string as the name on AAA/BBB (S1.9 `NAME_MISMATCH`) | libusb preferred, HID fallback | **Confirmed.** See D1 for why the lab's provisional node-hid > libusb order is not adopted. |
| BT data | Winsock RFCOMM (T-BT-1) and SPP (T-BT-2): link 52/105 on psk1 (Realtek), **101/105 on otos (Intel)**; p50 26–33 ms on Intel; SPP transfers nothing on psk1, works on Intel | Winsock preferred, SPP fallback | **Confirmed.** Winsock stays first: it works on both adapters, SPP on one. |
| BT pairing | WinRT `DeviceInformationCustomPairing` via net48 helper (T-BT-5): 3/3 first try on Intel, 3–7 s; flaky on Realtek | same helper | **Confirmed.** |
| BT discovery | bthprops cache (T-BT-3) and DeviceWatcher (T-BT-6): PASS, but **unstable on psk1** (0–3 of 3 bricks, S1.5 all-found 12/19 and 10/19); 3/3 in every pass on otos; live inquiry slow and incomplete | bthprops cache for discovery, watcher for the picker scan | **Confirmed as the right mechanisms**, not as reliable on every adapter. |
| TCP | net socket (T-TCP-4) PASS on win32 and Pi 5, p50 15–19 ms; beacon discovery PASS | same | **Confirmed.** |

So for choosing the technology per channel on Windows the lab is conclusive enough, and it
agrees with every choice the cockpit already made. Nothing needs rewriting.

What the lab **has not validated** and the cockpit must therefore measure itself (or accept
that nobody has): file operations other than the basic ones (S4.2–S4.5), throughput (S5.2–S5.3),
recovery mid-operation (S6), several bricks at once (S7), and anything Bluetooth on Linux (no
candidate written). For USB, S4.2 (copy/move) is already answered by the cockpit's own hardware
run (4.6.15).

### 2.2 The 50 % Bluetooth connect rate is the host, not the code

The cockpit's 40–47 % open rate (2.8.14) and the 5.12–5.19 s failures (2.8.16) were all
measured on psk1 with its Realtek adapter. The lab reproduced exactly that number there and got
96 % with the same package on an Intel adapter; Windows' event log on psk1 shows `BTHUSB` ID 3
(adapter stopped answering HCI commands) during the worst pass. The 5.12 s figure is the
default HCI page timeout.

That closes 2.8.11 and 2.8.16 as "host adapter property", with two caveats kept honest:

- The lab measured **its own reimplementation**, not `BtWinsockAdapter`. The same result on the
  cockpit's adapter is likely but unmeasured — U4 checks it.
- Which property of the Realtek setup causes it (power management `Enable = True`, driver,
  firmware) is still unknown.

### 2.3 Cooldowns: what the evidence does and does not say

- Longer waiting does not help anywhere: cockpit sweep 15 s → 67 %, 30 s → 17 %, 60 s → 17 %
  (one brick, n = 6 per step); lab on psk1, first attempt after idle 1/5 against 24/42 after a
  recent success.
- "Longer idle **hurts**" is a psk1-only finding. On Intel, gaps ≥ 90 s went 11/11.
- **"Retry immediately" has never been measured.** The lab's own runner waits ≥ 10 s after
  success and ≥ 30 s after failure, like the cockpit. The shortest spacing on record is the
  cockpit's 2 s round-robin from 27.08 (~50 %, SPP, psk1).
- EV3 Lab (LEGO) waits 5 s before a reconnect and holds one connection for the whole session.

So the current `INTER_CONNECTION_COOLDOWN_MS = 15000` and exponential
`ERROR_RECOVERY_COOLDOWN_MS = 30000` are not supported by data, but the right value is not
known either. This plan measures before it changes them (U3.2).

### 2.4 Claims in this repo the lab did not confirm

- *"Windows carries exactly one RFCOMM channel"* (`extension.ts:84`, DESIGN §3.3) — the lab
  has no S7 cells for Bluetooth, so this remains the cockpit's own measurement from the old
  testlab, not a lab result. It matters more than it looks: a BT session holds the queue's
  only slot for its whole life (`btTransportProvider.ts:168`, released in `disconnect`), so
  today the cockpit can never hold two Bluetooth bricks at once, and a pairing attempt waits
  out `QUEUE_ACQUIRE_TIMEOUT_MS` and fails while any BT brick is connected. The firmware side
  does not force this — page scan is off only on the brick that already has a link (lab
  `win32-bt-2026-10.md` §7.3). Measured in U4.
- `maxPacketBytes` for BT and TCP: the lab records `MAX_PACKET_UNKNOWN` (structural — neither
  link can report it). The cockpit already handles this by falling back to the firmware's
  1024-byte buffer (`fs/brickFilesystem.ts:50`, `telemetry/brickTelemetry.ts:82`). Not a
  defect; 4.6.4 stays open only for "the largest the firmware accepts", which is a measurement.

## 3. Behaviour that contradicts the lab

1. **The picker's scan is not serialized with Bluetooth connects.** `scanForBricks`
   (`extension.ts:252`) starts a live inquiry through the helper without touching `btQueue`,
   so it can run while an RFCOMM session is open or a connect is in flight. The lab's
   recommendation, independent of host: never run host inquiry beside a data connection.
   **This is a precautionary rule, not a measured defect**: the lab measured inquiry *before*
   a connect (harmless on Intel, suspect on Realtek, `win32-bt-2026-10.md` §8.5/2); inquiry
   *during* an open session has been measured by nobody. (Pairing *is* serialized —
   `BtClassicDiscovery` takes the queue — the scan is not.)
2. **The comment that justifies the BT pacing** (`extension.ts:84–99`) cites "about 10 s after
   a clean close and 30 s or more after a failure" as measured fact. The lab's data say the
   long recovery does not help; the comment should say what is known and what is not.

## 4. Step 1 — units

Scope rule: **below the `TransportProvider` contract, Windows only.** Nothing above it moves.

### U1. Land the uncommitted work

- Run `ce-code-review` over the whole diff first — it has never been reviewed as a unit, and
  `review_fixes_need_own_audit` applies to anything it turns up.
- Split into commits by theme, not one bulk commit:
  1. `feat(bt)`: pairing helper wired into the extension, scan mode, connect-by-name command
     (`native/`, `btPairingHelper.ts` + test, `btClassicDiscovery.ts` + test, `extension.ts`,
     `package.json`, `.gitignore`, `.vscodeignore`, `bt-scenario-matrix.js`).
  2. `feat(protocol)`: brick setting commands (`ev3Commands.ts`, `ev3Packet.ts`,
     `ev3Responses.ts`, the contract union, `ev3Protocol.test.ts`, `brick-settings-probe.js`).
  3. `refactor(discovery)`: ordering removed from the aggregator (`presenceAggregator.ts` +
     test, DESIGN hunk).
  4. `feat(telemetry)`: loop, service, constants, `supportsTelemetryFrames`, frames through the
     command queue (telemetry files, provider capability lines, mock, the remaining tests,
     `telemetry-queue-probe.js`, DESIGN/plan hunks).

  `IMPLEMENTATION_PLAN.md`, `DESIGN.md` and `contracts/transport.ts` carry hunks of several
  themes; they are split with patch files (`git apply --cached`), not `git add -p`.
- Themes are assigned by reading each hunk, not by file mtime: `extension.ts` and
  `mockTransportProvider.ts` were last touched 10.09 but may carry 03–04.09 hunks (the mock may
  serve `brick:setName`), and new `BrickCommand` members break any exhaustive switch that does
  not get them in the same commit.
- Gate: `npm run test:ci` and `npx aislop scan` on the final tree, then **each resulting SHA
  checked in a temporary `git worktree`** (linked `node_modules`) with compile, lint and unit
  tests — `test:ci` in the working tree only proves the end state, not the intermediate commits.
- Before `git add native/`: `git status --porcelain --untracked-files=all native/` must show
  only the helper's sources, never `native/bin/` DLLs.
- **Commit only after the owner says so** (standing rule for this repo).

### U2. Make the plan describe the code again

- `IMPLEMENTATION_PLAN.md` header, §2 and §3: current test counts, 2.8.18 status (wired; still
  open: two-path discovery, bounded retry around inquiry, scan serialization), Phase 3 status.
- Walk every checkbox in Phases 1–4 against the code, not against the summary; known so far:
  4.6.1 is done and unchecked.
- Close 2.8.11 and 2.8.16 with §2.2's evidence and its two caveats, linking the lab findings
  by repo and commit.
- Add a short "Lab conclusions" subsection (DESIGN §4.1 or the plan) — the table in §2.1, the
  list of what the lab did not validate, D1.
- Fix the `extension.ts:84–99` comment (§3.2).

### U3. Bring Bluetooth in line with the evidence

1. **Serialize the scan.** Live inquiry must not start while a BT connect is in flight or a
   BT session is open. Simply taking the queue's slot is not enough on its own: a session holds
   that slot for its whole life (§2.4), so the picker would hang until the acquire timeout
   whenever any BT brick is connected. Likely shape: while the radio is busy, the picker lists
   only what the cache path knows and says why; live inquiry runs only when the radio is free.
   The final shape depends on U4's answer about two simultaneous sessions. Test that fails
   without the change: a scan started while the fake queue is held must not reach the helper.
2. **Measure, then set the cooldowns.** Run the lab's proposed *gap after close* scenario
   through the cockpit's own stack (`scripts/bt-cooldown-sweep.js` extended): connect, close,
   wait X ∈ {0, 2, 5, 15, 30} s, connect; n ≥ 10 per value; on **both** hosts (psk1, otos);
   and the same after a failed connect. Then set `INTER_CONNECTION_COOLDOWN_MS` and the error
   recovery policy from the numbers, and decide whether the exponential growth stays. No value
   changes before the data exist.

   **Run on psk1 only** (owner: the second host is not available, and the cockpit ships first;
   psk1's Realtek adapter is the hard case). `scripts/bt-gap-sweep.js`: per brick a chain of
   open → `info` → close, each preceded by a gap drawn in shuffled order from {0, 2, 5, 15,
   30} s, 8 per gap per brick, queue cooldowns at zero, bricks one after another.
   **Decision rule, fixed before the run (29.10.2026):** after a clean close the gap becomes
   the shortest one whose open rate is no more than 10 percentage points below the 15 s rate;
   after a failure, the same against 30 s. Pooled over the three bricks, reported per brick.

   **Already measured, 29.10.2026, and it changes U3.1** (`scripts/bt-radio-probe.js`, psk1,
   CCC and BBB): two Bluetooth sessions to two bricks held at once, 115/115 replies each with
   no interference; a 30 s live inquiry beside both sessions left them at 100 % with unchanged
   round trips. "One RFCOMM connection per host" does not hold, and neither does the need to
   keep the scan away from open sessions. The queue only has to serialise *opening*, and a
   session must not hold its slot while it lives.
3. **Hold the link.** Verify, don't assume, that nothing in the session runtime closes and
   reopens a healthy BT session (heartbeat failures, transport guard); EV3 Lab's one connect
   per session is the pattern the lab endorses.
4. **Finish 2.8.18's missing core.** Two-path discovery: check already-paired by a direct read
   (`FromPairingState(true)` / `FromBluetoothAddressAsync`) before starting the unpaired-only
   inquiry watcher, which cannot see a brick the host remembers; and a bounded retry around
   the inquiry step (one 15 s window missed CCC more than once). Lives in the helper and
   `btPairingHelper.ts`, below the contract.

Every change in U3 gets a test that fails without it, checked by reverting the fix with a
reverse patch (`verify_the_test_discriminates`). Watch the mock: it implements `recover()`, the
real transports do not (`mock_diverges_where_product_breaks`).

### U4. (Hardware) Measurements, as lab scenarios carried on a flash disk

otos has no repo and no agent (owner, 29.10.2026). The route is the lab's own M2 cycle:
write the scenarios in `ev3-lab-communication`, `npm run export -- --cil=win-x64`, the owner
runs the package on otos and brings the results back, `npm run import`. Every scenario also runs
on psk1 first, here, so the two adapters are compared like for like.

The lab does not share code with the cockpit, so it cannot measure `BtWinsockAdapter` itself.
Running the cockpit's `bt-backend-comparison.js` on otos is **dropped**: T-BT-1 is the same
stack (koffi → ws2_32 AF_BTH), and a cockpit-only package would be new tooling for one answer.

Scenarios, all catalogued in the lab already and unmeasured:

1. **S7.1 on Bluetooth** — two RFCOMM sessions to two bricks at once. The catalogue excludes it
   on win32 as a "fact"; the exclusion becomes the hypothesis under test. If Windows carries
   both, the cockpit's ceiling becomes "one connect *attempt* at a time" (serialize opening, not
   holding), which unblocks several BT bricks and simplifies U3.1.
2. **Gap after close** (lab `win32-bt-2026-10.md` §7.5/1b) — connect, close, wait
   X ∈ {0, 2, 5, 15, 30} s, connect, n ≥ 10 per value; and the same after a failed connect.
   Feeds D3.
3. **Second connect after pairing**, 22–29 s after closing the first (§8.5/4) — the cockpit's
   command does pair → connect, so a reconnect shortly after is exactly that pattern.
4. **S7.2 / S9.9 — USB and Bluetooth open to the same brick at once.** The input D2's model
   needs (§6): does the firmware tolerate two live links, and what happens to replies.
   **Measured on psk1 29.10.2026, through the cockpit's own providers** (owner's go;
   `scripts/dual-channel-probe.js`, libusb + Winsock RFCOMM behind `BtConnectionQueue`, `info`
   commands only, each link counting in its own message range):

   | brick (fw) | USB alone | alternating USB/BT | concurrent, both in flight | USB closed, BT alone | USB back beside BT | USB alone afterwards |
   |---|---|---|---|---|---|---|
   | AAA (V1.10E) | 50/50 | 50/50 + 50/50 | 50/50 + 50/50 | 15/15 | 15/15 + 15/15 | 5/5 |
   | BBB (V1.10E) | 50/50 | 50/50 + 50/50 | 50/50 + 50/50 | 15/15 | 15/15 + 15/15 | 5/5 |
   | CCC (V1.09H) | 50/50 | 50/50 + 50/50 | 50/50 + 50/50 | 15/15 | 15/15 + 15/15 | 5/5 |

   No freeze, no reply delivered to the wrong link, every brick answered USB alone afterwards.
   USB round trip is unaffected by the open Bluetooth link (p50 6–8 ms, p95 ≤ 20 ms); Bluetooth
   slows when both are in flight (p50 56–72 → 92–107 ms, p95 ≤ 211 ms), which reads as the brick
   serving one request at a time. USB reopened beside a live Bluetooth link in 21–59 ms.

   **What this does not cover:** a physical cable pull (phase 5 closes USB in software),
   system commands — file transfer — on both links at once, telemetry at full rate on both,
   and anything longer than about a minute per brick. So the measured claim is "a brick
   tolerates a second open link and answers both", not "two links may carry arbitrary
   traffic". That is enough for D2's model as long as traffic goes over one channel and the
   others stand by (§6, D2).
5. **S9.5 / S9.8 — cost of failing over USB → BT** when the cable is pulled, each direction
   separately. The arena scenario in D2 is exactly this.
   **Measured on psk1 29.10.2026 with the owner pulling the cable at the brick end**
   (`scripts/cable-pull-probe.js`; USB carries `info` every 250 ms, Bluetooth stands by with
   one `info` a second, traffic moves to Bluetooth on the first USB failure and back after
   the brick reappears on USB):

   | brick | BT while the cable came out | BT carrying traffic alone | USB loss seen | brick back on USB after the plug signal | USB reopen |
   |---|---|---|---|---|---|
   | AAA | 18/18 | 111/111 | first failed call, `LIBUSB_ERROR_IO` in 6 ms | 21.1 s | 17 ms |
   | BBB | 4/4 | 101/101 | 259 ms after the last good reply (one tick), failing call 1 ms | 18.7 s | 20 ms |
   | CCC | 4/4 | 47/47 | 255 ms after the last good reply (one tick), failing call 7 ms | 4.4 s | 30 ms |

   Bluetooth on standby lost nothing while the cable came out, and carried the traffic on its
   own with p50 93–109 ms, p95 ≤ 182 ms. A pulled cable is not a timeout: the next USB call
   fails at once with `LIBUSB_ERROR_IO`, so the cockpit can fail over on the first failed
   command rather than waiting for the heartbeat. The way back needs the brick to reappear on
   the bus — 4.4–21 s after the plug signal, which includes the walk to the brick — and then
   opens in tens of milliseconds, so how often USB discovery polls decides how soon traffic
   returns to USB. One run per brick. The owner plugged each cable back as soon as the signal
   sounded, so the spread is the brick's or the host's, not the person's: CCC 4.4 s against
   18.7–21.1 s for AAA and BBB. **Hypothesis, unmeasured:** CCC is the one brick on firmware
   V1.09H, AAA and BBB run V1.10E; or Windows treats the bricks' composite device (HID + mass
   storage) differently on re-arrival. Telling them apart needs the Kernel-PnP arrival time
   against the probe's first sighting, and more than one run per brick. Not blocking: Bluetooth
   carries the traffic meanwhile.

Non-blocking for U1–U2; U3.1's final shape waits for point 1, and D2's shape for point 4.

## 4a. What the scan shows — proposal for the owner (29.10.2026)

The owner's requirements for the list a user picks a brick from: **the name that is on the
brick**, **the channels it is available on**, and **an order** — signal strength being the
one candidate so far. Measured the same day; nothing below is built.

### Name — only the brick itself is a reliable source

`scripts/name-source-probe.js` renamed CCC over USB (CCC → CCCx → CCC) and read every source:

| source | after rename to CCCx | after renaming back |
|---|---|---|
| `info` over USB | CCCx | CCC |
| USB discovery (libusb product string, fresh provider too) | **CCC — stale** | CCC |
| Bluetooth scan (Windows' record of a paired brick) | **CCC — stale** | **CCCx — stale** |
| `info` over Bluetooth | CCCx | CCC |
| TCP beacon | not measured — no brick had Wi-Fi on | |

The USB string is fixed when the cable is plugged in; Windows' Bluetooth record catches up
only at the next Bluetooth connection. So:

- **The cockpit keeps a confirmed name per brick** (identity = the twelve hex digits that are
  both USB serial and BT address), set every time it reads `info` from the brick — on
  connect, after its own rename — and later persisted (Phase 6).
- **A brick that appears on USB is asked its name at once.** It costs one round trip (~6 ms),
  and an extra USB link beside an open Bluetooth one is measured safe (U4.4).
- **Bluetooth is not connected just to read a name** — on a weak adapter that is a 5 s attempt
  that fails half the time. Until the brick has been asked, the list shows the discovery name
  marked as unconfirmed (how it looks is the panel's call).
- To check: the TCP beacon is sent by the brick and should carry its current name (owner
  offered to switch Wi-Fi on after the gap sweep).

### Channels

Per brick: **USB** when it is on the bus; **TCP** when its beacon is heard; **Bluetooth** when
it answered — a live connection, or a live inquiry hit. One catch, and it is finding #2 of
the review: Windows lists every *paired* brick whether it is switched on or not, and the
current helper's live inquiry covers only *unpaired* devices. For a paired brick not in use
there is today no cheap evidence that it is on. Options: show it as "known, not heard"
(a fourth icon state), or teach the helper an inquiry that includes paired devices — to be
measured, not assumed.

### Order — signal strength, and what else

Signal strength **is not yet known to be usable**, and an earlier wording of this paragraph
claimed more than the data show (corrected after the owner's question, 29.10.2026). For paired
bricks the helper reads Windows' records once per scan, so a value cannot change *within* a
scan — that it did not was no evidence of anything. Microsoft does not document the unit of
`System.Devices.Aep.SignalStrength`; classic Bluetooth commonly reports RSSI relative to the
ideal receive range (0 fine, positive stronger, negative weaker), so positive values are
plausible. Across four scans with nothing moving, the values did move: CCC 16/15/11/13, BBB
2/2/2/11, AAA 16/−19/−19/−15. **Open, and decisive:** whether the value follows distance or
is a record from the last contact — one brick carried to another room and back, a scan each
time. If it follows distance, it can order the list once smoothed into bands; sorting by the
raw value would make the list jump either way (review finding #13). Proposed order, in this
order:

1. **Bricks in use** (connected) — what the user is working with.
2. **On USB** — physically at the computer; the strongest evidence of nearness there is.
3. **Last used** — the brick the user connected most recently (needs persistence, Phase 6);
   for a returning user the best guess of what they want.
4. **Heard on Bluetooth, by signal in coarse bands** (near / middle / far, with hysteresis so a
   brick changes band only on a clear move) — this is where the owner's signal idea lives,
   once the helper can read it for paired bricks too.
5. **On TCP only.**
6. **Known but not heard** — greyed.

Within a group, by name, so the list stays still. One more idea, not an order but the same
problem: **"identify"** — make the chosen brick beep or blink its LED, so the user can tell two
bricks with similar names apart before connecting.

## 5. Explicitly not in step 1

- Rest of Phase 3 (3.2, 3.4–3.7) and Phase 4 API — they sit above the contract and are the
  natural step 2. Wiring `TelemetryService` into `extension.ts` waits for 3.5, as the plan says.
- Linux Bluetooth (1.11.11) — the lab has no candidate either (T-BTL-4..6 not written).
- 1.11.14 (registry record after "remove") — a design question, not a gap.
- Brick identity across transports (8a, 2.8.13) — decided (D2), implemented with Phase 5/6.
- Mock config loading (1.6.10) — small, independent, can ride along with any later step.

**Proposed order after step 1:** 2.8.12 (remaining hardware scenarios) → 2.8.13 after D2 →
1.6.10 → 3.2 + 3.5 together with 2.8.10a and wiring `TelemetryService` → Phase 4.

## 6. Decisions for the owner

- **D1 — USB order.** The lab's provisional order is node-hid > libusb, decided by worst-series
  p95 of 8 vs 11 ms on one host. Proposal: keep libusb preferred — 1024-byte frames (copy/move
  are impossible over 64-byte HID, 4.6.15), correct brick name (S1.9), 30× write throughput.
  The p95 difference is within one host's noise.
- **D2 — Brick identity (8a). Decided by the owner, 29.10.2026:** one brick, not one brick per
  transport. The brick carries a connect flag and connects over the channels it is allowed;
  with several available, traffic goes over the best one in the order **USB → BT → TCP**.
  Identity key: the 12 hex digits that are both the USB serial and the BT MAC (lab S9.3).
  The owner's UX sketch, for Phase 5:
  - discovery row `[U][B][T] Name`; a channel icon is hidden when that channel is not
    available at all, **blue** when available, **green** when connected, **grey** when lost;
  - clicking a channel icon connects that channel only; clicking the name connects every
    available channel;
  - a lost channel goes grey and reconnects by itself when it is found again;
  - user scenario: brick on USB + BT at the desk (traffic over USB) → cable pulled, robot
    leaves for the arena (cockpit moves to BT on its own) → back at the desk, cable in
    (cockpit returns to USB).

  **Open inside D2 — NF1.** "Every available channel connected, all green" means two live
  links to one brick, which the cockpit's transport guard and the lab's NF1 forbid ("one active
  transport per brick", freeze risk for all bricks). The incident record that rule cites does
  not exist (lab `testlab-inventory.md` §1). Either green means "link open" and NF1 is
  measured and lifted (U4.4), or green means "allowed and ready" with one link open at a time
  and failover paying the BT connect cost (U4.5). Not implemented in step 1.

  **Owner's call 29.10.2026: measure first. Measured the same day (U4.4): three bricks, two
  firmware versions, 100 % on both links, no freeze.** NF1 as written ("one active transport
  per brick") is not supported by evidence. Proposed replacement: **several links may be open
  to one brick; traffic goes over one of them — the preferred available channel — and the
  others stand by** (heartbeat only). Green then means "link open", as the owner's sketch has
  it, and the arena failover costs no Bluetooth connect. Still to measure before the cockpit
  relies on it: a physical cable pull with Bluetooth live, and the lab's NF1 (its runner
  enforces the old rule) needs the same correction.
- **D3 — Cooldown values**, once U3.2's numbers are in.
- **D4 — Commit split** as in U1, or a different grouping.

## 7. Done when

- The working tree is clean and pushed, in themed commits, each passing `test:ci`.
- `IMPLEMENTATION_PLAN.md` §2/§3 match the checkboxes, and the checkboxes match the code.
- 2.8.11 and 2.8.16 are closed with evidence; the scan cannot run beside a BT connect; cooldowns
  are either changed from measured numbers or left with a note saying why.
