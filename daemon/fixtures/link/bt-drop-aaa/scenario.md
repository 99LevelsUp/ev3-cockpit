# bt-drop on AAA

**Not recorded yet. Needs the owner:** switch AAA off (or its Bluetooth) while the commands run, within a minute of the start (the harness beeps and waits 5 s first).

Discovers AAA over Bluetooth, connects, and sends back to back a direct command the brick holds for 500 ms, up to 120 of them, until one fails because the link dropped. Then disconnects and discovers once more.

- **Brick state to note when recording:** AAA on, Bluetooth working, paired. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-drop --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-drop-bbb` or `bt-drop-ccc` with its own copy of this file.
