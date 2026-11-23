# cut-upload on CCC over USB

An upload cut in the middle with no person at the brick: a second client signs the brick out for
everyone while the write runs, so the daemon drops the session under it as a pulled cable would.
Find CCC, `bricks/connect`, `files/exists` of `/home/root/lms2012/prjs/CockpitFixture` (false),
`files/makeDirectory` of it, then

1. `transfer/begin` of 200000 bytes and `transfer/write` of the content (the line of
   `usb-file-round-trip-ccc` repeated and cut at 200000 bytes) in chunks of at most 16384 bytes;
2. `files/write` of `CockpitFixture/big.txt` from that handle;
3. 300 ms later a second client (the same name and kind) sends `bricks/disconnect` with
   `forEveryone`; the write fails with `transport_failed` (`USB transport was closed during the
   exchange`) after 64021 bytes reached the brick;
4. `bricks/connect` again; `files/list` of the folder: `big.txt`, 64021 bytes, MD5
   `a66ea6a41f58954b5d57831ac21f31de`;
5. `files/remove` of the folder, recursive: nothing left behind; `bricks/disconnect`.

- **Inputs:** the brick name `CCC`, the folder and file names, the content in step 1.
- **Replay:** matched only. Where the cut lands is a race between the second client's timer and
  the packets in flight, so a replay cuts a few packets earlier or later than the recording; the
  daemon test checks that the write fails and that the brick is connected, listed and cleaned up
  again afterwards.
- **Seen on the brick:** after this run the brick reported 64 kB less free space (4544 kB, see
  `tcp-info-storage-listing-ccc`) although the file was removed; the firmware likely still holds
  the cut download's handle, which nothing closed.
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
  node hardware-scenario.js cut-upload --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it matched; the same
  calls replay matched with `node scripts/hardware-scenario.mts cut-upload --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport usb`.