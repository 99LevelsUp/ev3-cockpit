# deploy-and-run on CCC over USB

A program deployed and run in one call, heard ending through a program subscription. Find CCC,
`bricks/connect`, `files/exists` of `/home/root/lms2012/prjs/CockpitFixture` (false), then

1. `programs/subscribe` CCC: `running` false, `runSeq` 0;
2. `programs/deployAndRun` with one file, `CockpitFixture/Wait.rbf` as inline content, and that
   path to run: outcome `started`, `runSeq` 1, the file uploaded, nothing skipped;
3. `programs/stateChanged`: running (`runSeq` 1), then not running about nine seconds later, after
   the daemon's once-a-second status reads saw the program end;
4. `subscriptions/cancel`; `files/remove` of the folder, recursive; `bricks/disconnect`.

- **Inputs:** the brick name `CCC`, the path above, and `Wait.rbf` (36 bytes, base64
  `TEVHTyQAAABtAAEAAAAAABwAAAAAAAAABAAAAIWCQB9AhkAK`), assembled with the firmware's assembler from

  ```
  vmthread  MAIN
  {
    DATA32  Timer
    TIMER_WAIT(8000,Timer)
    TIMER_READY(Timer)
  }
  ```

  It waits eight seconds and ends; it draws nothing, writes nothing and moves no motor.
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
  node hardware-scenario.js deploy-and-run --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it strictly; the same
  calls replay matched with `node scripts/hardware-scenario.mts deploy-and-run --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport usb`.