# usb-stale-reply on AAA

Late replies the link has to step over, provoked without a person: a direct command the brick
holds for 800 ms (`opTIMER_WAIT` 800 into global 0, then `opTIMER_READY`).

1. Discover and connect over USB.
2. The slow command with a 200 ms budget: recorded as a `timeout` after about 200 ms.
3. `opNOP` with a 3 s budget. The brick finishes the slow command first, so this link reads the
   slow command's reply (counter 1) before its own (counter 2) and steps over it. Recorded as an
   ordinary reply that took about 600 ms, the rest of the wait.
4. The slow command again, its caller dropping the exchange after 200 ms: recorded as abandoned
   (no reply, no error). Replay never finishes it.
5. `opNOP` again, about 600 ms, then disconnect.

The step-over happens below the provider, so the recording shows only its effect: a timeout or an
abandoned call followed by a correct reply that took as long as the brick's remaining wait.

- **Brick state:** AAA alone on the USB cable, on the main menu. Bluetooth and Wi-Fi in a stuck
  state, not used. Port View: not noted. Recorded 21.11.2026 on Windows 11.
- **Inputs:** the brick name `AAA`; the wait of 800 ms, budgets of 200 ms and 3 s.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile):

  ```
  cargo run -p ev3-transports --example record -- usb-stale-reply --brick AAA --out <dir>
  ```
