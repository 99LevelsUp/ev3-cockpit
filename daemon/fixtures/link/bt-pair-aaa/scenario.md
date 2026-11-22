# bt-pair on AAA

**Not recorded yet. Needs the owner:** AAA on, Bluetooth on and visible, not paired with this computer (run bt-forget first). Watch AAA's display and confirm on the brick if it asks.

Listens for unpaired bricks (one inquiry, not recorded), discovers (AAA listed as unpaired), pairs AAA (PIN 1234 answered by the provider), discovers again (paired).

- **Brick state to note when recording:** AAA on, Bluetooth visible, unpaired. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- bt-pair --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `bt-pair-bbb` or `bt-pair-ccc` with its own copy of this file.
