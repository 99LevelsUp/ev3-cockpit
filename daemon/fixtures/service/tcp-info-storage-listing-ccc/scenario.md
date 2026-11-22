# info-storage-listing on CCC over TCP

The same read-only round as `usb-info-storage-listing-ccc`, with the daemon recording only its TCP
provider: the first discovery hears no beacon yet, the second lists CCC by its beacon name, then
connect, `bricks/info` (`CCC`, `V1.09H`, `Linux 2.6.33-rc`), `bricks/storage` (6000 kB, 4544
kB free), `files/list` of `/home/root/lms2012/` (the same six entries), `files/exists` of
`/home/root/lms2012/prjs/` (true), disconnect. The brick's address on the network was replaced as
it was recorded; no exchange carries it.

- **Inputs:** as in `usb-info-storage-listing-ccc`.
- **Recorded** 22.11.2026 through the native daemon 0.2.519 in record mode on a test channel, on a
  Raspberry Pi 5 (linux-arm64), with `scripts/hardware-scenario.js` as the only client (kind
  `cli`, named `hardware scenario`, development build, version 0.0.1). The run ends with
  `bricks/disconnect` and `daemon/exit`, whose restart question the script answers yes.
- **Brick state:** CCC on the USB cable, on the main menu, paired over Bluetooth and on Wi-Fi;
  AAA and BBB known to the host but switched off. The recorder replaced CCC's serial with the
  placeholder `001653F00A0A`.
- **Command** (on the recording host, the daemon built for it beside the script; the
  directory must not exist yet):

  ```
  node hardware-scenario.js info-storage-listing --daemon ./ev3-cockpitd --brick CCC --out ./out --transport tcp
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it strictly; the same
  calls replay matched with `node scripts/hardware-scenario.js info-storage-listing --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport tcp`.