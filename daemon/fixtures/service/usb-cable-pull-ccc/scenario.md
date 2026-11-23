# cable-pull on CCC over USB (owner-run, not recorded yet)

Reconnect after a pulled USB cable, through the daemon's surface, with the daemon recording only
its USB provider. `scripts/cable-pull-probe.mts` drives it; `recording.jsonl` goes into this
directory once the owner has run it and the recording passed the identifier search.

1. `bricks/list` with `waitForDiscovery`, then the list until CCC is listed on USB with its name
   confirmed; `bricks/connect` CCC;
2. `telemetry/subscribe` CCC to `system.battery.voltage` every 500 ms, so the link carries traffic;
   five seconds of updates;
3. **Instruction (three beeps): "PULL the USB cable out of the brick now."** The probe waits up to
   60 s for `bricks/changed` with CCC's USB channel no longer connected, and prints how long that
   took; five more seconds;
4. **Instruction (one beep): "PLUG the USB cable back into the brick now."** The probe waits up to
   60 s for `bricks/reconnected`: the client never let go of CCC, so the daemon connects it again
   by itself;
5. `bricks/info` answers again; three seconds of telemetry; `subscriptions/cancel`;
   `bricks/disconnect`; `daemon/exit` with its restart question answered yes.

- **Brick state:** CCC on the USB cable, on the main menu; nothing running.
- **Inputs:** the brick name `CCC`, the row id and interval above.
- **Command** (on the recording host, the daemon built for it and both scripts in one folder; the
  recording directory must not exist yet):

  ```
  node scripts/cable-pull-probe.mts --daemon ./ev3-cockpitd --brick CCC --out ./out
  ```

- **Expected:** the loss reported within a few seconds of the pull, `bricks/reconnected` within a
  few seconds of the plug, and telemetry updates again after it. The run exits 1 and says which
  step it waited for in vain otherwise.
