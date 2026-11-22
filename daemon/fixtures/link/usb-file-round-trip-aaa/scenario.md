# usb-file-round-trip on AAA

A file round trip at the protocol level over USB: discover, connect, then

1. `BEGIN_DOWNLOAD` of `/home/root/lms2012/prjs/linkfixture.txt`, 3000 bytes, no first chunk;
2. three `CONTINUE_DOWNLOAD` packets of up to 1017 bytes (a 1024-byte frame less the envelope);
3. `BEGIN_UPLOAD` asking 1012 bytes, then `CONTINUE_UPLOAD` until all 3000 are back;
4. the read-back compared with what was written;
5. `DELETE_FILE`, then disconnect.

- **Brick state:** AAA alone on the USB cable, on the main menu, no file of that name in the
  projects folder. Bluetooth and Wi-Fi in a stuck state, not used. Port View: not noted.
  Recorded 21.11.2026 on Windows 11.
- **Inputs:** the brick name `AAA`; the path above; the content is the line
  `the quick brown fox jumps over the lazy dog` plus a newline, repeated and cut at 3000 bytes.
  Letters only, so nothing in it looks like an address or a name the recorder would replace.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile):

  ```
  cargo run -p ev3-transports --example record -- usb-file-round-trip --brick AAA --out <dir>
  ```
