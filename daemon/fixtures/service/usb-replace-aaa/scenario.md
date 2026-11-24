# replace on AAA over USB

Writes and moves onto files already there, with `replace: false`, through the daemon's file
methods over USB: find AAA, `bricks/connect`, then

1. `files/exists` of `/home/root/lms2012/prjs/CockpitFixture`: false;
2. `files/makeDirectory` of that folder;
3. `files/write` of `CockpitFixture/a.txt` with the inline content `first`;
4. `files/write` of the same file with `second` and `replace: false`: refused with
   `file_exists` after one `files/exists` on the brick, nothing written;
5. `files/read` of `a.txt`, inline: still `first`;
6. `files/write` of `CockpitFixture/b.txt` with `other`;
7. `files/move` of `a.txt` to `b.txt` with `replace: false`: refused with `file_exists`,
   nothing moved;
8. `files/move` of `a.txt` to `CockpitFixture/c.txt` with `replace: false`: the brick has no
   `c.txt`, so it moves;
9. `files/list` of the folder: `b.txt` and `c.txt`;
10. `files/remove` of the folder, recursive; `bricks/disconnect`.

- **Inputs:** the brick name `AAA`, the folder and file names above, the contents `first`,
  `second` and `other`.
- **Recorded** 24.11.2026 through the native daemon 0.3.39 in record mode on a test channel, on
  Windows 11 (HOSTA), with `scripts/hardware-scenario.mts` as the only client. The run ends with
  `bricks/disconnect` and `daemon/exit`, whose restart question the script answers yes.
- **Brick state:** AAA on the USB cable, on the main menu. The recorder replaced
  the bricks' serials with placeholders.
- **Command** (the directory must not exist yet):

  ```
  node scripts/hardware-scenario.mts replace --daemon daemon/target/debug/ev3-cockpitd --brick AAA --out <dir> --transport usb
  ```

- **Replay:** `cargo test -p ev3-cockpitd --test service_fixtures usb_writes_and_moves` replays
  it strictly.
