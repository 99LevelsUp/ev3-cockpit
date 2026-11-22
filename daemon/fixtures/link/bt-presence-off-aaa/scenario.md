# bt-presence-off on AAA

**Not recorded yet. Needs the owner:** AAA paired with this computer, then switched off before the run.

Discovers AAA over Bluetooth (Windows still lists it as paired) and makes one presence check; nothing answers.

- **Brick state to note when recording:** AAA paired, switched off. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-presence-off --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-presence-off-bbb` or `bt-presence-off-ccc` with its own copy of this file.
