# usb-discovery on AAA

One USB discovery through `UsbTransportProvider`, which lists AAA by the name in its USB
descriptor.

- **Brick state:** AAA alone on the USB cable, on the brick's main menu, no session open. Its
  Bluetooth and Wi-Fi were in a stuck state (the brick had not been restarted since); neither
  takes part. Port View: not noted. Recorded 21.11.2026 on a Windows 11 computer.
- **Inputs:** the brick name `AAA`, matched against the discovery's display name.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile, then copy
  `recording.jsonl` here):

  ```
  cargo run -p ev3-transports --example record -- usb-discovery --brick AAA --out <dir>
  ```
