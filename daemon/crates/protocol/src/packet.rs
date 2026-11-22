//! EV3 packet framing: encode and decode the wire format used by all transports, plus the
//! command, opcode and subcode constants of firmware 1.09d.
//!
//! Wire format: `[bodyLength:u16le] [messageCounter:u16le] [type:u8] [payload:u8[]]`
//! where `bodyLength = 2 (counter) + 1 (type) + payload.len()`.

use crate::error::ProtocolError;

/// Minimum valid EV3 packet size: 2 (length) + 2 (counter) + 1 (type).
pub const MIN_PACKET_BYTES: usize = 5;

/// A decoded packet. The payload borrows from the bytes that were decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ev3Packet<'a> {
    /// Sequence number for matching requests with replies (0-65535).
    pub message_counter: u16,
    /// Command or reply type byte.
    pub packet_type: u8,
    /// Variable-length payload following the type byte.
    pub payload: &'a [u8],
}

/// Command type bytes (host to brick).
pub mod command {
    pub const DIRECT_COMMAND_REPLY: u8 = 0x00;
    pub const DIRECT_COMMAND_NO_REPLY: u8 = 0x80;
    pub const SYSTEM_COMMAND_REPLY: u8 = 0x01;
    pub const SYSTEM_COMMAND_NO_REPLY: u8 = 0x81;
}

/// Reply type bytes (brick to host).
pub mod reply {
    pub const DIRECT_REPLY: u8 = 0x02;
    pub const DIRECT_REPLY_ERROR: u8 = 0x04;
    pub const SYSTEM_REPLY: u8 = 0x03;
    pub const SYSTEM_REPLY_ERROR: u8 = 0x05;
}

/// System command opcodes.
pub mod system {
    pub const BEGIN_DOWNLOAD: u8 = 0x92;
    pub const CONTINUE_DOWNLOAD: u8 = 0x93;
    pub const BEGIN_UPLOAD: u8 = 0x94;
    pub const CONTINUE_UPLOAD: u8 = 0x95;
    /// Read bytes from a file a program is still writing: the way to tail a log.
    pub const BEGIN_GETFILE: u8 = 0x96;
    pub const CONTINUE_GETFILE: u8 = 0x97;
    pub const CLOSE_FILEHANDLE: u8 = 0x98;
    pub const LIST_FILES: u8 = 0x99;
    pub const CONTINUE_LIST_FILES: u8 = 0x9a;
    pub const CREATE_DIR: u8 = 0x9b;
    pub const DELETE_FILE: u8 = 0x9c;
    pub const LIST_OPEN_HANDLES: u8 = 0x9d;
    pub const WRITEMAILBOX: u8 = 0x9e;
    /// Hands the brick a trusted Bluetooth PIN (`c_bt.c` 2960-2966: a trusted address pairs
    /// without asking).
    pub const BLUETOOTHPIN: u8 = 0x9f;
    /// Restarts the brick in firmware-update mode. Declared so it is never sent by accident.
    pub const ENTERFWUPDATE: u8 = 0xa0;
    pub const SETBUNDLEID: u8 = 0xa1;
    pub const SETBUNDLESEEDID: u8 = 0xa2;
}

/// `opFILE` subcodes, every one firmware 1.09d has (`bytecodes.h`; 26 is unused). Only some have
/// a code path here; the rest are declared so the capability is known.
pub mod file_sub {
    pub const OPEN_APPEND: u8 = 0;
    pub const OPEN_READ: u8 = 1;
    pub const OPEN_WRITE: u8 = 2;
    pub const READ_VALUE: u8 = 3;
    pub const WRITE_VALUE: u8 = 4;
    pub const READ_TEXT: u8 = 5;
    pub const WRITE_TEXT: u8 = 6;
    pub const CLOSE: u8 = 7;
    /// Load an `.rbf` into a slot's image memory (`bytecodes.h` 817, `c_memory.c` 3057-3127).
    pub const LOAD_IMAGE: u8 = 8;
    pub const GET_HANDLE: u8 = 9;
    pub const MAKE_FOLDER: u8 = 10;
    /// Allocates an image pool; reports nothing about storage (see `opMEMORY_USAGE`).
    pub const GET_POOL: u8 = 11;
    pub const SET_LOG_SYNC_TIME: u8 = 12;
    pub const GET_FOLDERS: u8 = 13;
    pub const GET_LOG_SYNC_TIME: u8 = 14;
    pub const GET_SUBFOLDER_NAME: u8 = 15;
    pub const WRITE_LOG: u8 = 16;
    pub const CLOSE_LOG: u8 = 17;
    pub const GET_IMAGE: u8 = 18;
    pub const GET_ITEM: u8 = 19;
    pub const GET_CACHE_FILES: u8 = 20;
    pub const PUT_CACHE_FILE: u8 = 21;
    pub const GET_CACHE_FILE: u8 = 22;
    pub const DEL_CACHE_FILE: u8 = 23;
    pub const DEL_SUBFOLDER: u8 = 24;
    pub const GET_LOG_NAME: u8 = 25;
    pub const OPEN_LOG: u8 = 27;
    pub const READ_BYTES: u8 = 28;
    pub const WRITE_BYTES: u8 = 29;
    /// Recursive delete by name.
    ///
    /// Distinct from `DEL_SUBFOLDER`, which takes an index, and from the `DELETE_FILE` system
    /// command, which removes a file or an *empty* directory only.
    pub const REMOVE: u8 = 30;
    /// Copy, despite the name: the firmware runs `cp -r` and leaves the source in place.
    ///
    /// A rename is therefore this followed by a delete. The copy runs on the brick, so its cost
    /// does not scale with the link.
    pub const MOVE: u8 = 31;
}

/// `opFILENAME` subcodes, every one firmware 1.09d has (`bytecodes.h`).
pub mod filename_sub {
    pub const EXIST: u8 = 16;
    pub const TOTALSIZE: u8 = 17;
    pub const SPLIT: u8 = 18;
    pub const MERGE: u8 = 19;
    pub const CHECK: u8 = 20;
    pub const PACK: u8 = 21;
    pub const UNPACK: u8 = 22;
    pub const GET_FOLDERNAME: u8 = 23;
}

/// Direct command opcodes.
pub mod opcode {
    pub const UI_READ: u8 = 0x81;
    pub const UI_BUTTON: u8 = 0x83;
    pub const COM_GET: u8 = 0xd3;
    pub const COM_SET: u8 = 0xd4;
    /// `opCOM_REMOVE` (`bytecodes.h` 463): drop a remembered peer from the brick's list.
    ///
    /// Takes the hardware selector and the peer's name, and has no subcode (`c_com.c`
    /// 5554-5575). The handler never calls `SetDispatchStatus`, so a reply means only that the
    /// brick answered; whether the entry went has to be read back.
    pub const COM_REMOVE: u8 = 0xd6;
    pub const INPUT_DEVICE: u8 = 0x99;
    /// `opINPUT_READSI`: one sensor reading in SI units.
    ///
    /// Signature from the firmware's own opcode table: `PAR8,PAR8,PAR8,PAR8,PARF` (layer, port,
    /// type hint, mode hint, and a four-byte float out).
    ///
    /// This constant once held 0x9a. 0x9A is `opINPUT_READ`, whose last parameter is `PAR8`: it
    /// writes a single percent byte. The parser read four bytes as a float from a slot the
    /// firmware had filled one byte of, so every sensor value was three bytes of whatever the
    /// previous command had left in the global buffer.
    pub const INPUT_READ_SI: u8 = 0x9d;
    pub const INPUT_DEVICE_LIST: u8 = 0x98;
    pub const OUTPUT_SPEED: u8 = 0xa5;
    pub const OUTPUT_START: u8 = 0xa6;
    pub const OUTPUT_STOP: u8 = 0xa3;
    pub const OUTPUT_RESET: u8 = 0xa2;
    pub const OUTPUT_GET_COUNT: u8 = 0xb3;
    pub const MEMORY_USAGE: u8 = 0xc5;
    pub const FILE: u8 = 0xc0;
    pub const FILENAME: u8 = 0xc6;
    pub const PROGRAM_STOP: u8 = 0x02;
    /// `opPROGRAM_START` (`bytecodes.h` 170): slot, size (read and ignored), image address, debug.
    pub const PROGRAM_START: u8 = 0x03;
    /// `opPROGRAM_INFO` (`bytecodes.h` 179): subcode, slot, then the subcode's parameters.
    pub const PROGRAM_INFO: u8 = 0x0c;
    /// `opSYSTEM` (`bytecodes.h` 302): a shell command string, out a 32-bit status.
    pub const SYSTEM: u8 = 0x60;
}

/// Program slots (`bytecodes.h` 1037-1046). User programs run in USER, as the brick's own
/// browser runs them.
pub mod program_slot {
    pub const USER: u8 = 1;
    pub const DEBUG: u8 = 4;
}

/// Subcodes of `opPROGRAM_INFO` (`bytecodes.h` 740).
pub mod program_info_sub {
    pub const GET_STATUS: u8 = 22;
}

/// A program's status (`bytecodes.h` 1593-1596); a whole program is only ever one of these two.
pub mod program_status {
    pub const RUNNING: u8 = 0x10;
    pub const STOPPED: u8 = 0x40;
}

/// Subcodes for `opUI_READ`. Values marked (verified) were read off a real brick.
pub mod ui_read_sub {
    /// Battery voltage, float32 (verified).
    pub const GET_VBATT: u8 = 0x01;
    /// Battery current draw in amps, float32 (verified).
    pub const GET_IBATT: u8 = 0x02;
    /// Battery charge level in percent, one byte (verified).
    pub const GET_LBATT: u8 = 0x12;
    pub const GET_OS_VERS: u8 = 0x03;
    pub const GET_IMOTOR: u8 = 0x07;
    pub const GET_HW_VERS: u8 = 0x09;
    pub const GET_FW_VERS: u8 = 0x0a;
    pub const GET_FW_BUILD: u8 = 0x0b;
    pub const GET_OS_BUILD: u8 = 0x0c;
    /// 0x1e per the firmware enum (0x1d is GET_POWER).
    pub const GET_SDCARD: u8 = 0x1e;
}

/// Subcodes for `opCOM_GET`, from `lms2012/source/bytecodes.h` (`COM_GET_SUBCODE`).
/// `GET_BRICKNAME` was verified against three bricks, each returning its own name.
pub mod com_get_sub {
    /// Whether a radio is on (`bytecodes.h` 636). Takes the hardware selector, answers one
    /// DATA8. **Never ask it of USB:** that case leaves the dispatch status at FAILBREAK
    /// (`c_com.c` 4296-4330), which ends the whole direct command (`lms2012.c` 2496-2510).
    pub const GET_ON_OFF: u8 = 0x01;
    /// Whether Bluetooth is visible (`bytecodes.h` 637); answers the Bluetooth flag whatever
    /// radio is named (`c_com.c` 4334-4347).
    pub const GET_VISIBLE: u8 = 0x02;
    /// How many peers the brick remembers on one radio (`bytecodes.h` 642). Takes the hardware
    /// selector, answers one DATA8 (`c_com.c` 4585-4612).
    pub const FAVOUR_ITEMS: u8 = 0x0a;
    /// One remembered peer by index (`bytecodes.h` 643). Takes hardware, index and a name
    /// length; answers the name, then paired, connected and type, one DATA8 each (`c_com.c`
    /// 4615-4689). The index is not bounds-checked (`c_bt.c` 3561-3567), so never ask past the
    /// count `FAVOUR_ITEMS` gave.
    pub const FAVOUR_ITEM: u8 = 0x0b;
    /// Bluetooth MAC of this brick.
    pub const GET_ID: u8 = 0x0c;
    /// The brick's user-visible name.
    pub const GET_BRICKNAME: u8 = 0x0d;
    /// Whether a radio's hardware is there (`bytecodes.h` 647): USB and Bluetooth always, Wi-Fi
    /// when a known dongle is in (`c_com.c` 4860-4885). Never fails.
    pub const GET_PRESENT: u8 = 0x0f;
}

/// Subcodes for `opCOM_SET` (`COM_SET_SUBCODE` in the firmware).
pub mod com_set_sub {
    /// Switch a radio on or off. Reads **two** DATA8 parameters: the hardware selector
    /// ([`super::com_hardware`]) and then the flag (`c_com.c`, `case SET_ON_OFF`).
    pub const SET_ON_OFF: u8 = 0x01;
    /// Make the brick discoverable. Same two-parameter shape as `SET_ON_OFF`.
    pub const SET_VISIBLE: u8 = 0x02;
    /// Rename the brick. Takes one string parameter.
    pub const SET_BRICKNAME: u8 = 0x08;
}

/// Which radio a `COM_SET`/`COM_GET` subcode is talking about (`HWTYPE` in the firmware).
///
/// Easy to miss and impossible to guess: `SET_ON_OFF` and `SET_VISIBLE` both take this before
/// their actual argument, so a single-argument call silently addresses the wrong hardware.
pub mod com_hardware {
    pub const USB: u8 = 1;
    pub const BT: u8 = 2;
    pub const WIFI: u8 = 3;
}

/// Longest brick name the firmware accepts.
///
/// `vmBRICKNAMESIZE` is 120 including the terminator and the check is a strict `>`, so 118
/// characters is what actually fits.
pub const MAX_BRICK_NAME_LENGTH: usize = 118;

/// Whether a brick name uses only characters the firmware accepts: ASCII letters, digits, `_`
/// and `-`, and at least one.
///
/// `ValidChars` in `lms2012.c` gives the name bit (`vmCHARSET_NAME`) to nothing else (not a
/// space, not a dot, nothing outside 0x00-0x7F, so no byte of 128 or more) and one character
/// without it fails the whole rename. Being ASCII-only, a name that matches has as many bytes
/// as characters, so [`MAX_BRICK_NAME_LENGTH`] can be checked against `len()`.
pub fn is_valid_brick_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Subcodes for `opUI_BUTTON`.
///
/// Button state is not an `opUI_READ` subcode. Asking `opUI_READ` for 0x0d (which is
/// GET_ADDRESS) made the firmware answer with an error, confirmed against a real brick, where
/// PRESSED under `opUI_BUTTON` answers correctly.
pub mod ui_button_sub {
    /// Is the given button currently pressed: one byte, 0 or 1 (verified).
    pub const PRESSED: u8 = 0x09;
}

/// Subcodes for `opINPUT_DEVICE`.
pub mod input_device_sub {
    pub const SET_TYPEMODE: u8 = 0x01;
    pub const GET_TYPEMODE: u8 = 0x05;
    /// Stop every motor (`bytecodes.h` 708, `c_input.c` 4798-4860); layer -1 = every brick in a
    /// chain.
    pub const STOP_ALL: u8 = 0x0d;
}

/// System command status codes.
pub mod system_status {
    pub const OK: u8 = 0x00;
    pub const UNKNOWN_HANDLE: u8 = 0x01;
    pub const HANDLE_NOT_READY: u8 = 0x02;
    pub const CORRUPT_FILE: u8 = 0x03;
    pub const NO_HANDLES_AVAILABLE: u8 = 0x04;
    pub const NO_PERMISSION: u8 = 0x05;
    pub const ILLEGAL_PATH: u8 = 0x06;
    pub const FILE_EXISTS: u8 = 0x07;
    pub const END_OF_FILE: u8 = 0x08;
    pub const SIZE_ERROR: u8 = 0x09;
    pub const UNKNOWN_ERROR: u8 = 0x0a;
    pub const ILLEGAL_FILENAME: u8 = 0x0b;
    pub const ILLEGAL_CONNECTION: u8 = 0x0c;

    /// The name of a status code, for an error message.
    pub fn name_of(status: u8) -> Option<&'static str> {
        Some(match status {
            OK => "OK",
            UNKNOWN_HANDLE => "UNKNOWN_HANDLE",
            HANDLE_NOT_READY => "HANDLE_NOT_READY",
            CORRUPT_FILE => "CORRUPT_FILE",
            NO_HANDLES_AVAILABLE => "NO_HANDLES_AVAILABLE",
            NO_PERMISSION => "NO_PERMISSION",
            ILLEGAL_PATH => "ILLEGAL_PATH",
            FILE_EXISTS => "FILE_EXISTS",
            END_OF_FILE => "END_OF_FILE",
            SIZE_ERROR => "SIZE_ERROR",
            UNKNOWN_ERROR => "UNKNOWN_ERROR",
            ILLEGAL_FILENAME => "ILLEGAL_FILENAME",
            ILLEGAL_CONNECTION => "ILLEGAL_CONNECTION",
            _ => return None,
        })
    }
}

// ── Encode / Decode ─────────────────────────────────────────────────

/// Encodes an EV3 packet into its wire format.
///
/// The message counter is masked to 16 bits. A payload too long for the 16-bit length field is
/// refused rather than sent with a wrapped length.
pub fn encode_ev3_packet(
    message_counter: u32,
    packet_type: u8,
    payload: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let body_length = 2 + 1 + payload.len();
    let declared = u16::try_from(body_length).map_err(|_| {
        ProtocolError::new(format!(
            "EV3 packet body of {body_length} bytes does not fit the 16-bit length field."
        ))
    })?;
    let mut out = Vec::with_capacity(2 + body_length);
    out.extend_from_slice(&declared.to_le_bytes());
    out.extend_from_slice(&((message_counter & 0xffff) as u16).to_le_bytes());
    out.push(packet_type);
    out.extend_from_slice(payload);
    Ok(out)
}

/// Decodes raw bytes into a structured [`Ev3Packet`].
///
/// A packet shorter than the minimum, or whose declared length differs from the bytes given
/// (truncated or oversized), is refused; nothing is read past the length.
pub fn decode_ev3_packet(packet: &[u8]) -> Result<Ev3Packet<'_>, ProtocolError> {
    if packet.len() < MIN_PACKET_BYTES {
        return Err(ProtocolError::new(format!(
            "Invalid EV3 packet: expected at least {MIN_PACKET_BYTES} bytes, got {}",
            packet.len()
        )));
    }
    let declared_body_length = usize::from(u16::from_le_bytes([packet[0], packet[1]]));
    let actual_body_length = packet.len() - 2;
    if declared_body_length != actual_body_length {
        return Err(ProtocolError::new(format!(
            "Invalid EV3 packet length: declared body {declared_body_length}, actual body {actual_body_length}"
        )));
    }
    Ok(Ev3Packet {
        message_counter: u16::from_le_bytes([packet[2], packet[3]]),
        packet_type: packet[4],
        payload: &packet[5..],
    })
}

/// Extracts the first length-prefixed packet from a receive buffer, returning it and what is
/// left. `None` if the buffer doesn't contain a complete packet yet.
pub fn extract_length_prefixed_packet(buffer: &[u8]) -> Option<(&[u8], &[u8])> {
    if buffer.len() < 2 {
        return None;
    }
    let total_length = 2 + usize::from(u16::from_le_bytes([buffer[0], buffer[1]]));
    if buffer.len() < total_length {
        return None;
    }
    Some(buffer.split_at(total_length))
}

/// Reads the 16-bit message counter from bytes 2-3 of a raw packet; `None` if it is too short.
pub fn message_counter_of(packet: &[u8]) -> Option<u16> {
    if packet.len() < 4 {
        return None;
    }
    Some(u16::from_le_bytes([packet[2], packet[3]]))
}

/// Checks that a reply carries the counter of the command it answers.
///
/// A mismatch is a framing fault, not a lost link: the error says so, so a heartbeat does not
/// reconnect a brick that is answering. `transport_label` names the transport in the message,
/// since the brick cannot tell us which one it was. A reply too short to hold a counter reads
/// as `-1`.
pub fn verify_reply_counter(
    reply: &[u8],
    expected: u16,
    transport_label: &str,
) -> Result<(), ProtocolError> {
    let got = message_counter_of(reply);
    if got == Some(expected) {
        return Ok(());
    }
    let got = got.map_or(-1, i32::from);
    Err(ProtocolError::new(format!(
        "{transport_label} reply counter mismatch: expected {expected}, got {got}."
    )))
}
