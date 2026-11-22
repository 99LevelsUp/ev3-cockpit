# bt-discovery on AAA

**Not recorded yet. Needs the owner:** AAA on, Bluetooth on, paired with this computer.

One Bluetooth discovery through the Windows provider (Windows' device cache), which lists AAA as paired.

- **Brick state to note when recording:** AAA on, Bluetooth working again after the restart, paired with this computer; not on USB. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-discovery --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-discovery-bbb` or `bt-discovery-ccc` with its own copy of this file.
