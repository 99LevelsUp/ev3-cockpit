# telemetry-minute on CCC over USB

A minute of telemetry. Find CCC, `bricks/connect`, then

1. `telemetry/rows`: every row a client can ask for; the script takes the ones whose id names the
   battery or the program: `program.user.running`, `system.battery.voltage`,
   `system.battery.level`;
2. `telemetry/subscribe` CCC to those rows at an interval of 1000 ms: each granted every 1000 ms,
   an empty snapshot;
3. 60 seconds of `telemetry/update`: 59 updates from 60 reads, one read a second; the last read
   was still in flight when the subscription ended and is recorded as abandoned;
4. `subscriptions/cancel`; `bricks/disconnect`.

- **Inputs:** the brick name `CCC`, the three row ids, the interval.
- **Replay:** strictly it takes the full minute: the daemon reads at the recorded pace, and the
  test waits for the 59th update and the read after it before it cancels.
- **Recorded** 22.11.2026 through the native daemon 0.2.519 in record mode on a test channel, on a
  Raspberry Pi 5 (linux-arm64), with `scripts/hardware-scenario.mts` as the only client (kind
  `cli`, named `hardware scenario`, development build, version 0.0.1). The run ends with
  `bricks/disconnect` and `daemon/exit`, whose restart question the script answers yes.
- **Brick state:** CCC on the USB cable, on the main menu, paired over Bluetooth and on Wi-Fi;
  AAA and BBB known to the host but switched off. The recorder replaced CCC's serial with the
  placeholder `001653F00A0A`.
- **Command** (on the recording host, the daemon built for it beside the script; the
  directory must not exist yet):

  ```
  node scripts/hardware-scenario.mts telemetry-minute --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it strictly; the same
  calls replay matched with `node scripts/hardware-scenario.mts telemetry-minute --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport usb`.