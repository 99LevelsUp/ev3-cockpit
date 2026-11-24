# usb-read-from on BBB

A file read from an offset with one direct command, over USB: discover, connect, then

1. `BEGIN_DOWNLOAD` of `/home/root/lms2012/prjs/linkfixture.txt`, 3000 bytes, and three
   `CONTINUE_DOWNLOAD` packets, as in `usb-file-round-trip`;
2. `fs:readFrom` of that file from offsets 0, 1000, 2990, 3000 and 5000 (992 bytes asked for each,
   64 for the last): `opFILENAME EXIST`, `opFILE OPEN_READ`, a skip to the offset with `READ_BYTES`
   on the brick, the new bytes into the reply, `CLOSE`. Each answer is compared with the file:
   992, 992, 10, 0 and 0 bytes, the size 3000 every time;
3. `fs:readFrom` of `/home/root/lms2012/prjs/nolinkfixture.txt`, which does not exist: answered
   as missing;
4. `DELETE_FILE`, then disconnect.

What it shows: the stock firmware runs a direct command with jumps and a loop, opens a file for
reading from the command slot, and reads into global variables; a missing file is told apart from
an empty one by `EXIST`.

- **Brick state:** BBB alone on the USB cable, on the main menu, no file of those names in the
  projects folder. Bluetooth on, not used. Firmware V1.10E. Recorded 24.11.2026 on Windows 11.
- **Inputs:** the brick name `BBB`; the paths above; the content of `usb-file-round-trip`.
- **Measured beside it** (not recorded): skipping costs the brick about 12 µs a byte (a 64 KiB
  file read from 8192, 32768 and 65000 took 0.12, 0.42 and 0.78 s), and a read at the file's end
  skips nothing (14 ms).
- **Command** (from `daemon/`, into a fresh directory inside the user's profile):

  ```
  cargo run -p ev3-transports --example record -- usb-read-from --brick BBB --out <dir>
  ```
