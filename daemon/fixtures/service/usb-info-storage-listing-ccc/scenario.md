# info-storage-listing on CCC over USB

The read-only round through the daemon's surface over USB: `bricks/list` with
`waitForDiscovery`, then the list again until CCC is listed on USB with its name confirmed (the
daemon's own name probe, recorded as `open_probe` and one exchange), then

1. `bricks/connect` CCC;
2. `bricks/info`: name `CCC`, firmware `V1.09H`, OS `Linux 2.6.33-rc`;
3. `bricks/storage`: 6000 kB in all, 4608 kB free;
4. `files/list` of `/home/root/lms2012/`: the folders `tools`, `sys`, `source`, `prjs`,
   `apps` and the file `lms2012` (122762 bytes, MD5 `cb16168f4d1d317cc15074772e021876`);
5. `files/exists` of `/home/root/lms2012/prjs/`: true;
6. `bricks/disconnect` CCC.

- **Inputs:** the brick name `CCC` and the two paths above. The firmware folder is listed rather
  than the projects folder so that nothing of the brick owner's own projects is published.
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
  node scripts/hardware-scenario.mts info-storage-listing --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it strictly; the same
  calls replay matched with `node scripts/hardware-scenario.mts info-storage-listing --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport usb`.