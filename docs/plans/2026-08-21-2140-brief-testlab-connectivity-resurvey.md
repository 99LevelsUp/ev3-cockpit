# Brief: re-survey EV3 connectivity in the testlab

**Status:** assignment, not scheduled. Written 21.08.2026 after the libusb finding in
`ev3-cockpit`. No work started.

**Target repo:** `ev3-testlab` (`apps/connectivity-lab`). Filed here because that workspace
is not under version control, so a brief left there would not survive; copy it over when the
work starts.

---

## 1. Why this exists

The testlab's stated purpose is: *for each connection type — which technology gives the
fastest and most stable link in the cockpit?* It ran for months and did not find that USB
over libusb is four to forty times faster than USB over HID, and that two filesystem
operations were impossible over HID entirely.

That is not a missed run. Two structural causes made the finding unreachable, and both are
still in place.

### 1.1 The matrix compared libraries, not wires

`design.md` lists the USB stack as four comparison candidates:

```
usb-hid-enumeration      (node-hid)              — primary
usb-native-hidapi        (koffi → hidapi.dll)    — parity check
usb-node-usb-raw         (libusb)                — tech exploration only
usb-win32-setupdi-hid    (koffi → setupapi.dll)  — parity check
```

Three of the four are **the same wire** reached through three libraries. All three inherit
the identical 64-byte ceiling, because that ceiling lives in the brick's HID report
descriptor (`Report Count 0` on both reports) rather than in any library. A matrix of four
entries was really a matrix of two, and the second one — libusb, the only different wire —
was fenced off by rule in `CLAUDE.md`:

> `usb-node-usb-raw` je tech exploration strategie — nepřidávat do `buildStrategyList()`

Its role had been fixed as *reading the product string* before anyone measured it as a
channel. The classification became the reason never to test it.

### 1.2 Every metric was a small-packet metric

The collected metrics are `durationMs`, `candidateCount`, `verifiedCount`, `avgRttMs`,
`verifyRttMs`, `fsLatencyMs`. The probe payload is `BATTERY_PAYLOAD` — around 16 bytes.

**A 64-byte ceiling cannot appear in any measurement whose largest packet is 16 bytes.** The
lab could have run indefinitely without seeing it. This is the more important of the two
causes, because it is not specific to USB: any property that only shows at size, over
duration, or under concurrency is currently outside the lab's reach.

### 1.3 A third problem found while writing this

`lib/tcpAdapter.ts` does not call `setNoDelay`. `src/transports/tcpSocketAdapter.ts` in the
cockpit does. The lab and production are separate implementations and they have drifted, so
the lab is ranking a socket that is not the one that ships. Unknown how far this extends —
the BT and USB adapters have the same duplication.

---

## 2. Hypothesis worth testing first

The protocol is strictly request-reply and the frame is capped by the firmware at 1024
bytes. If both hold, then **throughput ≈ frame ÷ RTT** on every transport, and the whole
"which technology is best" question collapses onto RTT and stability, because frame size is
already exhausted.

Against the numbers measured so far:

| Transport | Measured throughput | Implied RTT | Separately measured RTT |
|---|---|---|---|
| USB (libusb) | 325 KB/s | 3.1 ms | 5.7 ms |
| TCP | 57.3 KB/s | 17.3 ms | 16.1 ms |
| BT | 20.3 KB/s | 48.9 ms | 90.9 ms |

TCP fits closely. USB and BT are out by roughly a factor of two, which is exactly why this
is a hypothesis and not a conclusion — and why throughput and RTT need measuring **in one
run, over the same command mix**, which is not done today. If the model holds, the ranking
work is mostly RTT work. If it breaks, the break is the finding.

---

## 3. Scope, in priority order

### P1 — Bulk payload as a first-class axis

Every candidate must move a real payload, not only a battery command. Suggested sizes: 1 KB,
64 KB, 1 MB, with every byte compared on return.

*Acceptance:* the summary reports write and read throughput per candidate, and a candidate
that cannot carry a given payload at all is reported as a **failure**, not as a slow result.

Without this, this class of mistake simply recurs in a different disguise.

### P2 — Re-cut the matrix by wire, not by library

Group candidates by the channel they use. Three HID libraries are one candidate with three
implementations; libusb interrupt transfers are a different candidate. Retire the
"tech exploration only" category — it is the mechanism that hid the finding.

*Acceptance:* `design.md` names each candidate's **wire**, and no candidate is excluded from
`buildStrategyList()` by classification alone. Exclusions carry a measured reason.

Known wires today, for the re-cut:

| Transport | Wire | Reached via |
|---|---|---|
| USB | HID reports | node-hid, hidapi.dll, setupapi.dll |
| USB | interrupt endpoints (1024 B) | libusb — now the cockpit's preferred backend |
| TCP | stream socket | Node `net` |
| BT | RFCOMM | WinSock2 (koffi), serialport SPP — WinRT dropped 28.08.2026 |

### P3 — Fidelity check between lab and cockpit

The lab is only useful if what it measures is what ships. `setNoDelay` is proof that the two
have diverged; assume there is more.

*Acceptance:* a documented, repeatable comparison of the socket and device options each side
sets (nodelay, keepalive, timeouts, buffer sizes, report sizes, retry policy), with
differences either removed or recorded as deliberate.

Worth considering: whether the lab should import the cockpit's adapters rather than keep its
own copies. That removes the drift at the root, at the cost of coupling the lab to a build.
This is a design decision for the owner, not a foregone conclusion.

### P4 — Distributions instead of averages

Stability is the primary question and an average hides a stall. `NumericStats` already
carries p95, so this is mostly a reporting change: p95, p99, max, and jitter per candidate.

*Acceptance:* the summary ranks on p95 rather than mean, and a candidate with a good mean
and a bad tail is visibly worse than one with a slightly worse mean and a tight tail.

### P5 — Concurrency and load

No scenario today runs anything simultaneously. The open question carried over from the
cockpit's filesystem work: **do the measured throughputs hold on a loaded brick** — a
running program, plus telemetry polling, plus a transfer?

*Acceptance:* a soak scenario with heartbeat, telemetry and bulk transfer in flight at once,
reporting throughput and RTT degradation against the same measurements taken idle.

Needs program control, which the cockpit does not have yet — so this item is blocked on
cockpit phase 4.7a, and can be reduced to "heartbeat + telemetry + transfer" in the meantime.

### P6 — Failure and recovery scenarios

Stability in the sense that matters to a user: what happens when it breaks.

- Cable unplugged mid-transfer
- Brick rebooted mid-session
- Wi-Fi dropped, then restored
- Bluetooth taken out of range and returned

*Acceptance:* per transport and per candidate — time to detect, time to recover, whether the
session survives or must be rebuilt, and whether a partially written file is left behind.

Two carryovers from the cockpit belong here, both currently unverified:

- the libusb path on **Linux** (padding to `wMaxPacketSize` should be harmless there, but has
  not been run)
- recovery from **unplugging mid-transfer** on the libusb path

### P7 — Bluetooth backend comparison under load

Two RFCOMM backends remain and there is no evidence they were ever compared for stability
rather than for connecting at all. BT is also the transport whose implied and measured RTT
disagree most.

*Acceptance:* p95 RTT and stall counts per backend over a soak run, and a recommendation
with the measurement behind it.

---

## 4. Out of scope

- Adding transports. USB, BT and TCP are the three physical channels; this is about what runs
  inside them.
- `usb-drive-deploy` (mass storage) as a runtime transport — it is a deployment path.
- `usb-recovery-pid0006` — recovery mode, a separate concern.
- Rewriting the cockpit. Findings migrate as they always have: verified in the lab, then
  reimplemented cleanly.

---

## 5. What "done" means

The lab can answer, with a measurement behind each answer:

1. For each of the three channels, which wire and which implementation is fastest for bulk,
   which has the tightest latency tail, and which survives failure best — and whether those
   are the same one.
2. Whether throughput is frame-bound or RTT-bound per transport (§2).
3. Where the lab's own adapters differ from the cockpit's.

And the matrix is cut so that a candidate is never excluded because of what it was once
classified as.
