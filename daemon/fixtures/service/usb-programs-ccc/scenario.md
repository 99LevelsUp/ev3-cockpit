# programs on CCC over USB

Starting, stopping and following a program already on the brick. Find CCC, `bricks/connect`,
`files/exists` of `/home/root/lms2012/prjs/CockpitFixture` (false), then

1. `files/makeDirectory` of the folder and `files/write` of `CockpitFixture/Wait.rbf` inline
   (the program of `usb-deploy-and-run-ccc`, 36 bytes);
2. `programs/subscribe` CCC: `running` false, `runSeq` 0;
3. `programs/run` of `CockpitFixture/Wait.rbf`: outcome `started`, `runSeq` 1, nothing uploaded;
4. `programs/stop` at once: `running` false, `runSeq` 1, `stoppedBy` `hardware scenario`;
5. `programs/status`: the same;
6. `programs/stateChanged`: running, then stopped by `hardware scenario`;
7. `subscriptions/cancel`; `files/remove` of the folder, recursive; `bricks/disconnect`.

- **Inputs:** the brick name `CCC`, the path, and `Wait.rbf` as in `usb-deploy-and-run-ccc`.
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
  node hardware-scenario.js programs --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it strictly; the same
  calls replay matched with `node scripts/hardware-scenario.mts programs --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport usb`.