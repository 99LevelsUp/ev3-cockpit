# bt-connect-commands on AAA

**Not recorded yet. Needs the owner:** AAA on, Bluetooth on, paired with this computer.

Discovers AAA over Bluetooth, connects (RFCOMM), sends the same five commands as usb-connect-commands (clear the reply area, `info`, `battery`, `LIST_FILES` of `/home/root/lms2012/prjs/`, `opNOP`) and disconnects.

- **Brick state to note when recording:** AAA on, Bluetooth working, paired; not on USB. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-connect-commands --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-connect-commands-bbb` or `bt-connect-commands-ccc` with its own copy of this file.
