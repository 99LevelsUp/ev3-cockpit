# bt-forget on AAA

**Not recorded yet. Needs the owner:** AAA on and paired with this computer. This removes the pairing: run bt-pair right after it.

Discovers AAA over Bluetooth, forgets it (removes the pairing; the provider reports the records Windows keeps), discovers again.

- **Brick state to note when recording:** AAA on, Bluetooth working, paired. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-forget --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-forget-bbb` or `bt-forget-ccc` with its own copy of this file.
