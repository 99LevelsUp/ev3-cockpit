# tcp-connect-commands on AAA

**Not recorded yet. Needs the owner:** AAA on, Wi-Fi on, on the same network as this computer.

Discovers AAA by its beacon, connects over TCP (unlock handshake), sends the same five commands as usb-connect-commands and disconnects.

- **Brick state to note when recording:** AAA on, Wi-Fi working, on this computer's network. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- tcp-connect-commands --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `tcp-connect-commands-bbb` or `tcp-connect-commands-ccc` with its own copy of this file.
