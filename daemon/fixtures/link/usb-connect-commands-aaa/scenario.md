# usb-connect-commands on AAA

Discovers AAA over USB, connects (libusb, 1024-byte frames), sends five commands with message
counters 1 to 5, and disconnects:

1. a direct command that writes zeros over 72 bytes of its global variables;
2. `info` (brick name, OS, hardware and firmware versions and builds) into those same 72 bytes;
3. `battery` (volts, amps, level);
4. `LIST_FILES` of `/home/root/lms2012/prjs/`;
5. `opNOP`.

Why step 1: the firmware does not clear a direct command's globals, and a string read writes only
up to its terminator, so without it the info reply carried bytes an earlier command had left
after the name (on AAA, a fragment of some other text). The harness refuses an info reply with
anything after a terminator.

- **Brick state:** AAA alone on the USB cable, on the brick's main menu. Bluetooth and Wi-Fi in a
  stuck state, not used. Port View: not noted. Recorded 21.11.2026 on Windows 11. The listing
  shows what was in the projects folder then (five folders and an empty lock file).
- **Inputs:** the brick name `AAA`; the folder `/home/root/lms2012/prjs/`.
- **Command** (from `daemon/`, into a fresh directory inside the user's profile):

  ```
  cargo run -p ev3-transports --example record -- usb-connect-commands --brick AAA --out <dir>
  ```
