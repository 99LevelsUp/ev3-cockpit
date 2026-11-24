# follow on BBB over USB

A file followed while it is written, through the daemon's `files/follow` over USB: find BBB,
`bricks/connect`, then

1. `files/exists` of `/home/root/lms2012/prjs/CockpitFixture`: false;
2. `files/makeDirectory` of that folder;
3. `files/write` of `CockpitFixture/out.txt` with empty inline content: an empty file, so the
   next write's truncation never takes it below the offset the follow reached;
4. `files/follow` of the file from offset 0: `{"offset": 0, "size": 0}`;
5. `transfer/begin` of 10000 bytes and one `transfer/write`, then `files/write` of the file from
   that handle: the line `the quick brown fox jumps over the lazy dog` plus a newline, repeated
   and cut at 10000 bytes. The brick's file grows packet by packet as the upload lands;
6. the follow's `files/appended`: all 10000 bytes, in order, in 11 notifications, each starting
   where the last ended (each poll is one `fs:readFrom` direct command from the offset reached);
7. `files/remove` of the file: the follow ends with `files/followEnded`, reason `removed`, 0.4 s
   later;
8. `files/remove` of the folder, recursive; `bricks/disconnect`.

- **Inputs:** the brick name `BBB`, the folder and file names above, the content in step 5.
- **Recorded** 24.11.2026 through the native daemon 0.3.26 in record mode on a test channel, on
  Windows 11 (HOSTA), with `scripts/hardware-scenario.mts` as the only client. The run ends with
  `bricks/disconnect` and `daemon/exit`, whose restart question the script answers yes.
- **Brick state:** BBB on the USB cable, on the main menu, firmware V1.10E. The recorder replaced
  BBB's serial with a placeholder.
- **Command** (the directory must not exist yet):

  ```
  node scripts/hardware-scenario.mts follow --daemon daemon/target/debug/ev3-cockpitd --brick BBB --out <dir> --transport usb
  ```

- **Replay:** matched only: how many polls find nothing depends on the host's pace. `cargo test -p
  ev3-cockpitd --test service_fixtures usb_follow` and the client tests in
  `daemon/crates/client/tests/addon.rs` replay it.
