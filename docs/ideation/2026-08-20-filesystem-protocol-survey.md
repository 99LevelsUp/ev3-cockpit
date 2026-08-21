# Filesystem protocol survey

> Verified 20.08.2026 against firmware sources in `ev3-resources`, not inferred:
> `11_Firmware/ev3_firmware_109d_developer_edition/c_com/source/c_com.h` (system commands),
> `.../lms2012/source/bytecodes.h` (direct-command subcodes),
> `.../c_com/source/c_com.c` (system command implementations).
>
> This exists because the same survey was done once in conversation and lost. Opcodes and
> subcodes here are copied from the headers; none are guessed.

## Why this document

`IMPLEMENTATION_PLAN.md` §4.6 scopes the filesystem to five operations — `uploadFile`,
`downloadFile`, `executeRbf`, `listFiles`, `readFile` — and `DESIGN.md` §11 to roughly the
same. The requirement is broader: **every operation the protocol offers**, not only the
obvious ones. That gap is the reason for this survey.

## 1. System commands (`SYSTEM_COMMAND`, 0x92–0xA2)

Seventeen exist. `src/protocol/ev3Packet.ts` currently declares nine.

| Code | Name | Declared | Purpose |
|---|---|:--:|---|
| 0x92 | `BEGIN_DOWNLOAD` | ✅ | start writing a file **to** the brick |
| 0x93 | `CONTINUE_DOWNLOAD` | ✅ | next chunk — **never sent**, so `fs:write` drops content |
| 0x94 | `BEGIN_UPLOAD` | ✅ | start reading a file **from** the brick |
| 0x95 | `CONTINUE_UPLOAD` | ✅ | next chunk — **never sent**, so `fs:read` truncates |
| 0x96 | `BEGIN_GETFILE` | ❌ | read bytes from a file **while it is being written** |
| 0x97 | `CONTINUE_GETFILE` | ❌ | continue that read |
| 0x98 | `CLOSE_FILEHANDLE` | ✅ | release a handle |
| 0x99 | `LIST_FILES` | ✅ | directory listing |
| 0x9A | `CONTINUE_LIST_FILES` | ✅ | continue a listing past one packet |
| 0x9B | `CREATE_DIR` | ✅ | make a directory |
| 0x9C | `DELETE_FILE` | ✅ | delete — see §3, it also removes empty directories |
| 0x9D | `LIST_OPEN_HANDLES` | ❌ | enumerate handles the brick currently holds |
| 0x9E | `WRITEMAILBOX` | ❌ | write to a VM mailbox (messaging, not filesystem) |
| 0x9F | `BLUETOOTHPIN` | ❌ | transfer a trusted pin code |
| 0xA0 | `ENTERFWUPDATE` | ❌ | reboot into firmware-update mode |
| 0xA1 | `SETBUNDLEID` | ❌ | mode2 bundle id |
| 0xA2 | `SETBUNDLESEEDID` | ❌ | mode2 bundle seed id |

`BEGIN_GETFILE` is the interesting omission: it reads a file that is still open for
writing, which is what tailing a running program's log output needs. Nothing else in the
protocol offers that.

`ENTERFWUPDATE` and `BLUETOOTHPIN` are in range but are not filesystem operations and
carry real risk — see §5.

## 2. `opFILE` (0xC0) subcodes — the direct-command filesystem

Thirty-two subcodes, none currently used. This is where the operations missing from the
system-command set live.

| # | Subcode | Relevance |
|---|---|---|
| 0/1/2 | `OPEN_APPEND` / `OPEN_READ` / `OPEN_WRITE` | handle-based access, an alternative to the chunked system commands |
| 3/4 | `READ_VALUE` / `WRITE_VALUE` | typed single-value access |
| 5/6 | `READ_TEXT` / `WRITE_TEXT` | line-oriented access |
| 7 | `CLOSE` | close an `opFILE` handle |
| 8/18 | `LOAD_IMAGE` / `GET_IMAGE` | RGF image handling |
| 9 | `GET_HANDLE` | resolve a name to a handle |
| 10 | `MAKE_FOLDER` | **mkdir** — second path to it, alongside `CREATE_DIR` |
| 11 | `GET_POOL` | free space / pool information |
| 13 | `GET_FOLDERS` | count subfolders |
| 15 | `GET_SUBFOLDER_NAME` | enumerate subfolders by index |
| 19 | `GET_ITEM` | item lookup |
| 20–23 | `GET_CACHE_FILES`, `PUT_CACHE_FILE`, `GET_CACHE_FILE`, `DEL_CACHE_FILE` | brick file cache |
| 24 | `DEL_SUBFOLDER` | **rmdir** by index |
| 28/29 | `READ_BYTES` / `WRITE_BYTES` | raw binary access |
| 30 | `REMOVE` | delete via direct command |
| **31** | **`MOVE`** | **rename / move — the only primitive for it** |
| 12/14/16/17/25/27 | `SET_LOG_SYNC_TIME`, `GET_LOG_SYNC_TIME`, `WRITE_LOG`, `CLOSE_LOG`, `GET_LOG_NAME`, `OPEN_LOG` | datalog subsystem |

**There is no `RENAME` system command.** Rename is `opFILE` subcode 31 (`MOVE`) and
nothing else. Any plan that treats rename as "another system command like delete" is
wrong.

## 3. `opFILENAME` (0xC6) subcodes

| # | Subcode | Relevance |
|---|---|---|
| 16 | `EXIST` | **a real existence primitive** |
| 17 | `TOTALSIZE` | size without listing the parent |
| 18/19 | `SPLIT` / `MERGE` | path manipulation on the brick |
| 20 | `CHECK` | validate a filename |
| 21/22 | `PACK` / `UNPACK` | archive handling |
| 23 | `GET_FOLDERNAME` | current folder |

`fs:exists` is currently inferred by listing the parent directory and searching it. With
`EXIST` that becomes one command instead of a listing that may need `CONTINUE_LIST_FILES`
paging — and it stops being wrong for a directory whose listing spans packets.

## 4. Facts measured from the firmware implementation

Read out of `c_com.c`, not assumed:

- **`DELETE_FILE` removes directories too.** It calls POSIX `remove()`, which unlinks a
  file *or* an empty directory; the firmware's own debug string reads
  `"Folder %s not deleted"`. A non-empty directory fails with `NO_PERMISSION`, so
  recursive delete is the client's job (or `DEL_SUBFOLDER`'s).
- **Path length is capped at 60 bytes** by the firmware: `char Name[60]` with
  `snprintf(Name, 60, ...)`. A longer path is silently truncated, not rejected — so the
  brick may delete or create something other than what was asked. This needs a
  client-side guard.
- System replies are `[0] command echo, [1] status, …` — already corrected in
  `validateReply`, and `SYSTEM_REPLY_HEADER_BYTES = 7` for the listing header.

## 5. Operations to deliberately exclude, and why

Not everything in range belongs in a filesystem API:

- **`ENTERFWUPDATE` (0xA0)** — reboots the brick into firmware-update mode. A bricking
  hazard behind a plausible-looking call. Out of scope.
- **`BLUETOOTHPIN` (0x9F)** — pairing credential transfer, not filesystem, and it moves a
  secret. Out of scope.
- **`SETBUNDLEID` / `SETBUNDLESEEDID` (0xA1/0xA2)** — mode2 provisioning, no consumer.
- **`WRITEMAILBOX` (0x9E)** — VM messaging. A legitimate feature, but it belongs to a
  messaging surface, not to `filesystem`.

Excluding these is a decision, not an oversight; recorded here so the next round of review
does not read the gap as incomplete coverage.

## 7. Corrections from hardware

Four entries above were wrong, and each was only caught by running the operation against a
brick and checking the result rather than the call.

| Claim | What the brick does |
|---|---|
| `MOVE` (31) is rename | It is `cp -r`. The source survives and the destination is deleted first, so renaming is copy-then-delete and cannot be atomic. The copy runs brick-side, so it costs one command whatever the size. |
| `GET_POOL` (11) gives free space | It allocates an image pool and says nothing about storage. Free space is `opMEMORY_USAGE` (0xC5), which takes no subcode. |
| `TOTALSIZE` (17) gives bytes | Kilobytes, rounded up: a 3-byte file measures 1. `cMemoryFindSize` ends with `Size = (Size + (KB - 1)) / KB`. Exact bytes come from a listing entry. |
| Its file count is 1 for a file | Zero. The firmware only counts while walking a directory. |

Two further facts worth keeping:

- **`DEL_SUBFOLDER` (24) takes an index, not a name.** The by-name recursive delete is
  `REMOVE` (30), via `cMemoryDeleteSubFolders`.
- **Absolute paths are safe with `opFILE` subcodes.** `ConstructFilename` substitutes the
  running program's directory only when the caller supplies no path at all. It also
  validates the character set, and `"`, `$` and a backtick are all rejected — which is why
  `MOVE`'s use of `system("cp -r ...")` is not an injection route.

### The listing format

`cComGetFileInfo` writes one line per entry:

```
directory   name/
file        <32 hex md5> <8 hex byte size> name
```

So a trailing slash is the only directory marker, and a file line already carries an exact
byte size and a checksum the caller would otherwise have to fetch separately.

### What USB cannot do

A HID write delivers 64 bytes, so a direct command whose parameters exceed roughly 50 bytes
cannot be sent at all. `opFILE/MOVE` carries two paths and a stock EV3 project path is
already 25 characters, so **copy and move do not work over USB** while every other
operation does. TCP and Bluetooth carry them inside their 1024-byte packets. The libusb
path is therefore a correctness requirement for USB, not only a throughput one.

## 6. Open questions for the design

1. **Two paths to most operations** — chunked system commands versus `opFILE` handles.
   Which is authoritative for the service, and is the other worth exposing at all?
2. **Chunk size per transport.** USB is report-framed at 1024 bytes; BT and TCP are
   stream-framed. The chunk size is a protocol constant, but the *useful* chunk size is a
   transport property.
3. **The 10 commands/second firmware guard** (DESIGN §4.1) applies here hardest: a
   1 MB upload at 1 KB per chunk is ~1000 commands, so ~100 seconds at the guard ceiling
   regardless of transport. This is the strongest argument yet for task 1.8.4a — whether
   exceeding the limit rejects or applies backpressure — because a chunked transfer under
   a throwing rate limiter simply cannot complete.
4. **Transfer-level deadline** (task 1.8.5b): 1000 chunks each inside its own
   `SEND_TIMEOUT_MS` can still add up to minutes of apparent success.
5. **Recursive operations.** Delete and rename of a populated directory have no protocol
   primitive. Does the service recurse client-side, or refuse?
6. **`BEGIN_GETFILE`** — worth including for log tailing, or defer with the datalog
   subsystem?
