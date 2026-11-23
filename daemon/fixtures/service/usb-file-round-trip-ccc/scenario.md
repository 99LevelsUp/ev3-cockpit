# file-round-trip on CCC over USB

A file round trip through the daemon's file methods over USB: find CCC as in
`usb-info-storage-listing-ccc`, `bricks/connect`, then

1. `files/exists` of `/home/root/lms2012/prjs/CockpitFixture`: false (the script refuses to go on
   otherwise, so every run sends the same requests);
2. `files/makeDirectory` of that folder;
3. `files/write` of `CockpitFixture/notes.txt` with inline content: 3000 bytes, the line
   `the quick brown fox jumps over the lazy dog` plus a newline, repeated and cut at 3000 bytes;
4. `files/size` of the file: `{"files": 0, "kilobytes": 3}`;
5. `files/read` of the file, inline: the same 3000 bytes;
6. `files/move` to `CockpitFixture/moved.txt`;
7. `files/list` of the folder: `moved.txt`, 3000 bytes, MD5 `57271eb06eca76d0aacbab96ae322981`;
8. `files/remove` of the folder, recursive: nothing left behind;
9. `files/exists` of the folder: false; `bricks/disconnect`.

- **Inputs:** the brick name `CCC`, the folder and file names above, the content described in
  step 3. Letters only, so nothing in them looks like an address or a name the recorder replaces.
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
  node scripts/hardware-scenario.mts file-round-trip --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures` replays it strictly; the same
  calls replay matched with `node scripts/hardware-scenario.mts file-round-trip --daemon <ev3-cockpitd>
  --brick CCC --replay daemon/fixtures/service/<this directory> --transport usb`.