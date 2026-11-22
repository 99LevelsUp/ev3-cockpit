# usb-cable-pull on AAA

**Not recorded yet. Needs the owner:** pull AAA's USB cable while the commands run, within a minute of the start (the harness beeps and waits 5 s first). Plug it back in afterwards.

Discovers AAA over USB, connects, and sends back to back a direct command the brick holds for 500 ms (`opTIMER_WAIT`/`opTIMER_READY`), up to 120 of them, until one fails because the cable was pulled, most likely in the middle of an exchange. Then disconnects and discovers once more (AAA no longer listed).

- **Brick state to note when recording:** AAA alone on the USB cable, on the main menu. Note Wi-Fi and Bluetooth on or off, and
  whether Port View is open.
- **Inputs:** the brick name `AAA`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile; then copy
  `recording.jsonl` here, after the harness has reported no real identifiers in it):

  ```
  cargo run -p ev3-transports --example record -- usb-cable-pull --brick AAA --out <dir> --owner-present
  ```

- **Other bricks:** the same with `--brick BBB` or `--brick CCC`; the fixture then goes into
  `usb-cable-pull-bbb` or `usb-cable-pull-ccc` with its own copy of this file.
