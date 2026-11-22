# bt-presence on AAA

**Not recorded yet. Needs the owner:** AAA on, Bluetooth on, paired with this computer.

Discovers AAA over Bluetooth and makes one presence check (an SDP query, no connection); the brick answers.

- **Brick state to note when recording:** AAA on, Bluetooth working, paired, no session. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-presence --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-presence-bbb` or `bt-presence-ccc` with its own copy of this file.
