# tcp-discovery on AAA

**Not recorded yet. Needs the owner:** AAA on, Wi-Fi on, on the same network as this computer.

TCP discovery, repeated once a second up to 20 times, until AAA's UDP beacon lists it.

- **Brick state to note when recording:** AAA on, Wi-Fi working after the restart, on this computer's network. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- tcp-discovery --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `tcp-discovery-bbb` or `tcp-discovery-ccc` with its own copy of this file.
