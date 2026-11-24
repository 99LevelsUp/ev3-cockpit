//! Parses raw EV3 reply payloads into typed [`BrickResponse`] values.
//!
//! Each parser corresponds to a [`BrickCommand`] kind and extracts the structured data from the
//! global variable bytes returned by the brick. Nothing is read past the end of a payload: a
//! short one is refused as malformed, or its missing slots read as absent where the rule says so.

use crate::bytecode::{read_fixed_c_string, read_float32le, read_int32le, read_uint32le};
use crate::commands::{BrickCommand, bt_peer_layout, info_layout};
use crate::error::ProtocolError;
use crate::packet::{Ev3Packet, program_status, reply, system_status};
use crate::peripherals::{PeripheralType, peripheral_type_of};

// ── Sensor/motor type names ─────────────────────────────────────────

// Names come from the one vocabulary (`peripherals.rs`, codes from `bytecodes.h`), shared with
// the mock and the telemetry rows. Two codes were once wrong here (16 named `color`, 29
// `color-v2`) so a touch sensor read as a colour sensor; the tests pin the codes.

/// `TYPE_UNKNOWN` (125): "port not empty but type has not been determined".
///
/// Not a corner case: every sensor plugged in while running reports it for a second or two
/// before announcing itself, observed on all three bricks. None of 125, 126 (`TYPE_NONE`, "port
/// empty or not available") and 127 (`TYPE_ERROR`) carries a usable reading, so the value is
/// dropped rather than passed on: the buffer slot behind it holds whatever the last command left
/// there.
const TYPE_UNKNOWN: u8 = 125;
const NO_DEVICE_TYPE: u8 = 126;
const TYPE_ERROR: u8 = 127;

fn has_reading(type_code: u8) -> bool {
    type_code != TYPE_UNKNOWN && type_code != NO_DEVICE_TYPE && type_code != TYPE_ERROR
}

/// `DATA32_NAN` from `bytecodes.h` (0x80000000): a tacho slot with nothing to report.
///
/// Distinct from an empty port: the device is there and has no reading yet. Sensor readings
/// signal the same thing with `DATAF_NAN`, which the firmware defines as 0/0 and therefore
/// arrives as a real NaN.
const DATA32_NAN: i32 = i32::MIN;

const SENSOR_PORT_LABELS: [&str; 4] = ["1", "2", "3", "4"];
const MOTOR_PORT_LABELS: [&str; 4] = ["A", "B", "C", "D"];

/// Bytes before the data in a system-command reply payload: the command echo, the status byte,
/// a uint32 size and a handle. Verified against a real brick.
const SYSTEM_REPLY_HEADER_BYTES: usize = 7;

// ── Response types ──────────────────────────────────────────────────

/// One port's reading. No timestamp: this crate reads no clock, the caller stamps it.
#[derive(Debug, Clone, PartialEq)]
pub struct PortReading {
    /// Port label: `1`-`4` for sensors, `A`-`D` for motors.
    pub port: &'static str,
    /// The device's name; `None` for an empty port.
    pub peripheral_type: Option<PeripheralType>,
    /// The firmware's raw type code beside the name; `None` for an empty port.
    pub type_code: Option<u8>,
    /// A sensor's SI value or a motor's tacho; `None` when the port has no usable reading.
    pub value: Option<f64>,
    /// `deg` for a tacho reading.
    pub unit: Option<&'static str>,
}

/// Which of the six buttons are pressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ButtonsState {
    pub up: bool,
    pub enter: bool,
    pub down: bool,
    pub right: bool,
    pub left: bool,
    pub back: bool,
}

/// One entry in a directory listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    /// `Unknown` when the line matched neither the directory nor the file shape: kept rather
    /// than dropped, so a firmware that formats differently is visible.
    pub kind: FsEntryKind,
    /// Byte size, which the brick includes for files only.
    pub bytes: Option<u32>,
    /// MD5 the brick computed, lowercase hex. Files only.
    pub md5: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsEntryKind {
    File,
    Directory,
    Unknown,
}

/// A parsed reply, matching the command that was sent.
#[derive(Debug, Clone, PartialEq)]
pub enum BrickResponse {
    /// Handed back as bytes on purpose: only the frame that was sent knows the layout.
    TelemetryFrame {
        payload: Vec<u8>,
    },
    /// Charge in percent (0-100), volts and amps.
    Battery {
        level: u8,
        voltage: f32,
        current_amps: f32,
    },
    Ports {
        motor_ports: Vec<PortReading>,
        sensor_ports: Vec<PortReading>,
    },
    Buttons(ButtonsState),
    Info {
        /// The brick's own name; `EV3` when it reported none.
        display_name: String,
        firmware_version: Option<String>,
        os_version: Option<String>,
    },
    /// Settings writes and stops carry nothing back: whether they took is only observable on
    /// the brick afterwards.
    SetName,
    SetBluetooth,
    SetBluetoothVisible,
    RemoveBluetoothPeer,
    ProgramStop,
    ProgramEmergencyStop,
    /// The loaded image's size; 0 when the file is not on the brick.
    ProgramRun {
        image_bytes: i32,
    },
    ProgramStatus {
        running: bool,
        status: u8,
    },
    SystemRun {
        status: i32,
    },
    BluetoothPeerCount {
        count: u8,
    },
    BluetoothPeer {
        /// The name exactly as the brick stores it, untrimmed.
        name: String,
        paired: bool,
        connected: bool,
        /// `ICON_*` from `bytecodes.h` 1301-1304: 3 PC, 4 phone, 5 brick, 6 unknown.
        peer_type: u8,
    },
    /// The first page of a directory listing. `listing` is the page's text as raw bytes: the
    /// firmware cuts pages anywhere, mid-name included, so the pages are joined and then read with
    /// [`parse_listing`], never read one by one.
    FsList {
        listing: Vec<u8>,
        complete: bool,
        handle: Option<u8>,
    },
    /// A further page of a directory listing; `listing` continues the previous page's bytes.
    FsListContinue {
        listing: Vec<u8>,
        complete: bool,
        handle: u8,
    },
    FsRead {
        content: String,
    },
    FsWrite,
    FsExists {
        exists: bool,
    },
    FsDelete {
        deleted: bool,
    },
    FsBeginWrite {
        handle: u8,
        end_of_file: bool,
    },
    FsContinueWrite {
        handle: u8,
        end_of_file: bool,
    },
    FsBeginRead {
        total_bytes: u32,
        handle: u8,
        end_of_file: bool,
        chunk: Vec<u8>,
    },
    FsContinueRead {
        handle: u8,
        end_of_file: bool,
        chunk: Vec<u8>,
    },
    FsCloseHandle,
    /// Kilobytes, rounded up, and the files the total covers (zero for a plain file).
    FsSize {
        kilobytes: u32,
        files: u32,
    },
    FsFreeSpace {
        total_kb: u32,
        free_kb: u32,
    },
    FsMakeDirectory {
        exists: bool,
    },
    FsCopy,
    FsRemoveTree,
    /// What a read from an offset found: whether the path exists, the file's size when it was
    /// opened, and the bytes from the offset on (at most the bytes asked for; none when the file
    /// is no longer than the offset).
    FsReadFrom {
        exists: bool,
        size: u32,
        chunk: Vec<u8>,
    },
}

// ── Public interface ────────────────────────────────────────────────

/// Parses an EV3 reply packet into a typed [`BrickResponse`].
///
/// `cmd` is the original command (to know what to parse). Fails if the reply is an error reply
/// or is malformed.
pub fn parse_response(
    cmd: &BrickCommand,
    reply_packet: &Ev3Packet<'_>,
) -> Result<BrickResponse, ProtocolError> {
    validate_reply(reply_packet, cmd.kind())?;
    let payload = reply_packet.payload;

    match cmd {
        BrickCommand::TelemetryFrame { .. } => Ok(BrickResponse::TelemetryFrame {
            payload: payload.to_vec(),
        }),
        BrickCommand::Battery => parse_battery(payload),
        BrickCommand::Ports => Ok(parse_ports(payload)),
        BrickCommand::Buttons => Ok(parse_buttons(payload)),
        BrickCommand::Info => Ok(parse_info(payload)),
        // Nothing to parse: `validate_reply` above has already rejected an error status, and a
        // successful settings write carries no payload. Whether the setting actually took is
        // only observable on the brick afterwards. opCOM_REMOVE never even sets a dispatch
        // status (c_com.c 5567-5606), so its reply says only that the brick answered. A stop is
        // the same: `program:status` shows whether the slot stopped.
        BrickCommand::SetName { .. } => Ok(BrickResponse::SetName),
        BrickCommand::SetBluetooth { .. } => Ok(BrickResponse::SetBluetooth),
        BrickCommand::SetBluetoothVisible { .. } => Ok(BrickResponse::SetBluetoothVisible),
        BrickCommand::RemoveBluetoothPeer { .. } => Ok(BrickResponse::RemoveBluetoothPeer),
        BrickCommand::ProgramStop => Ok(BrickResponse::ProgramStop),
        BrickCommand::ProgramEmergencyStop => Ok(BrickResponse::ProgramEmergencyStop),
        BrickCommand::ProgramRun { .. } => {
            if payload.len() < 8 {
                return Err(ProtocolError::new(
                    "Malformed program:run reply: expected 8 bytes.",
                ));
            }
            Ok(BrickResponse::ProgramRun {
                image_bytes: read_int32le(payload, 0)?,
            })
        }
        BrickCommand::ProgramStatus => {
            let Some(&status) = payload.first() else {
                return Err(ProtocolError::new(
                    "Malformed program:status reply: no status byte.",
                ));
            };
            Ok(BrickResponse::ProgramStatus {
                running: status == program_status::RUNNING,
                status,
            })
        }
        BrickCommand::SystemRun { .. } => {
            if payload.len() < 4 {
                return Err(ProtocolError::new(
                    "Malformed system:run reply: expected 4 bytes.",
                ));
            }
            Ok(BrickResponse::SystemRun {
                status: read_int32le(payload, 0)?,
            })
        }
        BrickCommand::BluetoothPeerCount => {
            let Some(&count) = payload.first() else {
                return Err(ProtocolError::new(
                    "Malformed brick:bluetoothPeerCount reply: no count byte.",
                ));
            };
            Ok(BrickResponse::BluetoothPeerCount { count })
        }
        BrickCommand::BluetoothPeer { .. } => parse_bluetooth_peer(payload),
        BrickCommand::FsList { .. } => parse_fs_list(payload),
        BrickCommand::FsRead { .. } => parse_fs_read(payload),
        BrickCommand::FsWrite { .. } => Ok(BrickResponse::FsWrite),
        BrickCommand::FsExists { .. } => {
            // One output byte from `opFILENAME/EXIST`: non-zero when the path resolves.
            //
            // This used to infer existence from a LIST_FILES reply not erroring, and returned
            // true whatever came back, including for a file in a directory that had just been
            // created empty. The builder moved to the real primitive without the parser
            // following, so the right question was asked and the answer thrown away.
            let Some(&byte) = payload.first() else {
                return Err(ProtocolError::new(
                    "Malformed fs:exists reply: no result byte.",
                ));
            };
            Ok(BrickResponse::FsExists { exists: byte != 0 })
        }
        BrickCommand::FsBeginWrite { .. } => {
            let status = transfer_status(payload, "fs:beginWrite")?;
            if payload.len() < 3 {
                return Err(ProtocolError::new(
                    "BEGIN_DOWNLOAD reply carried no file handle.",
                ));
            }
            Ok(BrickResponse::FsBeginWrite {
                handle: payload[2],
                end_of_file: status == system_status::END_OF_FILE,
            })
        }
        BrickCommand::FsContinueWrite { .. } => {
            let status = transfer_status(payload, "fs:continueWrite")?;
            if payload.len() < 3 {
                return Err(ProtocolError::new(
                    "CONTINUE_DOWNLOAD reply carried no file handle.",
                ));
            }
            Ok(BrickResponse::FsContinueWrite {
                handle: payload[2],
                end_of_file: status == system_status::END_OF_FILE,
            })
        }
        BrickCommand::FsBeginRead { .. } => {
            // [0] echo, [1] status, [2..5] total size, [6] handle, [7..] payload
            let status = transfer_status(payload, "fs:beginRead")?;
            if payload.len() < 7 {
                return Err(ProtocolError::new(format!(
                    "Malformed BEGIN_UPLOAD reply: expected at least 7 bytes, got {}.",
                    payload.len()
                )));
            }
            Ok(BrickResponse::FsBeginRead {
                total_bytes: read_uint32le(payload, 2)?,
                handle: payload[6],
                end_of_file: status == system_status::END_OF_FILE,
                chunk: payload[7..].to_vec(),
            })
        }
        BrickCommand::FsContinueRead { .. } => {
            // [0] echo, [1] status, [2] handle, [3..] payload; no size, unlike BEGIN_UPLOAD
            let status = transfer_status(payload, "fs:continueRead")?;
            if payload.len() < 3 {
                return Err(ProtocolError::new(
                    "CONTINUE_UPLOAD reply carried no file handle.",
                ));
            }
            Ok(BrickResponse::FsContinueRead {
                handle: payload[2],
                end_of_file: status == system_status::END_OF_FILE,
                chunk: payload[3..].to_vec(),
            })
        }
        BrickCommand::FsCloseHandle { .. } => {
            transfer_status(payload, "fs:closeHandle")?;
            Ok(BrickResponse::FsCloseHandle)
        }
        BrickCommand::FsListContinue { .. } => parse_fs_list_continue(payload),
        BrickCommand::FsReadFrom {
            offset, max_bytes, ..
        } => parse_fs_read_from(payload, *offset, *max_bytes),
        BrickCommand::FsSize { .. } => {
            if payload.len() < 8 {
                return Err(ProtocolError::new(format!(
                    "Malformed fs:size reply: expected 8 bytes, got {}.",
                    payload.len()
                )));
            }
            // Firmware order: files first, then the kilobyte total.
            Ok(BrickResponse::FsSize {
                files: read_uint32le(payload, 0)?,
                kilobytes: read_uint32le(payload, 4)?,
            })
        }
        BrickCommand::FsFreeSpace => {
            if payload.len() < 8 {
                return Err(ProtocolError::new(format!(
                    "Malformed fs:freeSpace reply: expected 8 bytes, got {}.",
                    payload.len()
                )));
            }
            Ok(BrickResponse::FsFreeSpace {
                total_kb: read_uint32le(payload, 0)?,
                free_kb: read_uint32le(payload, 4)?,
            })
        }
        BrickCommand::FsMakeDirectory { .. } => {
            let Some(&byte) = payload.first() else {
                return Err(ProtocolError::new(
                    "Malformed fs:makeDirectory reply: no result byte.",
                ));
            };
            Ok(BrickResponse::FsMakeDirectory { exists: byte != 0 })
        }
        BrickCommand::FsCopy { .. } => Ok(BrickResponse::FsCopy),
        BrickCommand::FsRemoveTree { .. } => Ok(BrickResponse::FsRemoveTree),
        BrickCommand::FsDelete { .. } => Ok(BrickResponse::FsDelete { deleted: true }),
    }
}

// ── Direct command parsers ──────────────────────────────────────────

fn parse_battery(payload: &[u8]) -> Result<BrickResponse, ProtocolError> {
    // Global layout from the battery command: [0..3] volts, [4..7] amps, [8] percent.
    if payload.len() < 9 {
        return Err(ProtocolError::new(format!(
            "Malformed battery reply: expected 9 bytes, got {}.",
            payload.len()
        )));
    }
    // The contract promises 0-100 and the UI renders it as a percentage. Clamping an
    // out-of-range byte would report a false full battery and let the heartbeat succeed, hiding
    // exactly the layout change this error exists to surface, and the layout was measured on one
    // firmware. Refusing costs nothing now that a protocol error no longer tears the session
    // down.
    if payload[8] > 100 {
        return Err(ProtocolError::new(format!(
            "Battery level out of range: {} is not a percentage. \
             The reply layout does not match this firmware.",
            payload[8]
        )));
    }
    Ok(BrickResponse::Battery {
        level: payload[8],
        voltage: read_float32le(payload, 0)?,
        current_amps: read_float32le(payload, 4)?,
    })
}

fn parse_ports(payload: &[u8]) -> BrickResponse {
    // The firmware does not clear the global buffer, so a slot it did not write holds whatever
    // the previous command left there, verified on hardware, where the unwritten bytes were
    // legible ASCII. Presence therefore comes from the type code only, and a value is trusted
    // only for a port that reports a device.
    let mut sensor_ports = Vec::with_capacity(4);
    let mut motor_ports = Vec::with_capacity(4);

    // Sensor type/mode: bytes 0..7 (2 per port)
    for (i, label) in SENSOR_PORT_LABELS.iter().enumerate() {
        let type_code = payload.get(i * 2).copied().unwrap_or(NO_DEVICE_TYPE);
        let present = type_code != NO_DEVICE_TYPE;
        let raw = if has_reading(type_code) && payload.len() >= 16 + (i + 1) * 4 {
            read_float32le(payload, 16 + i * 4).ok()
        } else {
            None
        };
        sensor_ports.push(PortReading {
            port: label,
            peripheral_type: present.then(|| peripheral_type_of(type_code)),
            type_code: present.then_some(type_code),
            // DATAF_NAN is a real NaN, so a device with no reading yet is reported as having
            // none rather than as holding a nonsense number.
            value: raw.filter(|v| v.is_finite()).map(f64::from),
            unit: None,
        });
    }

    // Motor type/mode: bytes 8..15 (2 per port)
    for (i, label) in MOTOR_PORT_LABELS.iter().enumerate() {
        let type_code = payload.get(8 + i * 2).copied().unwrap_or(NO_DEVICE_TYPE);
        let present = type_code != NO_DEVICE_TYPE;
        let raw = if has_reading(type_code) && payload.len() >= 32 + (i + 1) * 4 {
            read_int32le(payload, 32 + i * 4).ok()
        } else {
            None
        };
        let tacho = raw.filter(|v| *v != DATA32_NAN);
        motor_ports.push(PortReading {
            port: label,
            peripheral_type: present.then(|| peripheral_type_of(type_code)),
            type_code: present.then_some(type_code),
            value: tacho.map(f64::from),
            unit: tacho.map(|_| "deg"),
        });
    }

    BrickResponse::Ports {
        motor_ports,
        sensor_ports,
    }
}

fn parse_buttons(payload: &[u8]) -> BrickResponse {
    let pressed = |i: usize| payload.get(i).is_some_and(|b| *b != 0);
    BrickResponse::Buttons(ButtonsState {
        up: pressed(0),
        enter: pressed(1),
        down: pressed(2),
        right: pressed(3),
        left: pressed(4),
        back: pressed(5),
    })
}

fn parse_info(payload: &[u8]) -> BrickResponse {
    use info_layout::*;
    let brick_name = read_fixed_c_string(payload, OFF_BRICK_NAME, LEN_BRICK_NAME);
    let os_version = read_fixed_c_string(payload, OFF_OS_VERS, LEN_OS_VERS);
    let fw_version = read_fixed_c_string(payload, OFF_FW_VERS, LEN_FW_VERS);
    BrickResponse::Info {
        // The brick's name, not the kernel version this used to report.
        display_name: if brick_name.is_empty() {
            "EV3".to_owned()
        } else {
            brick_name
        },
        firmware_version: (!fw_version.is_empty()).then_some(fw_version),
        os_version: (!os_version.is_empty()).then_some(os_version),
    }
}

/// Layout from the peer command: [0..126] name, [127] paired, [128] connected, [129] type.
///
/// The name is cut at its terminator and not trimmed, unlike the info strings: a peer is removed
/// by an exact match on these bytes, and a trimmed name would no longer match.
fn parse_bluetooth_peer(payload: &[u8]) -> Result<BrickResponse, ProtocolError> {
    use bt_peer_layout::*;
    if payload.len() < TOTAL_BYTES {
        return Err(ProtocolError::new(format!(
            "Malformed brick:bluetoothPeer reply: expected {TOTAL_BYTES} bytes, got {}.",
            payload.len()
        )));
    }
    let slot = &payload[OFF_NAME..OFF_NAME + NAME_BYTES];
    let end = slot.iter().position(|b| *b == 0).unwrap_or(slot.len());
    Ok(BrickResponse::BluetoothPeer {
        name: String::from_utf8_lossy(&slot[..end]).into_owned(),
        paired: payload[OFF_PAIRED] != 0,
        connected: payload[OFF_CONNECTED] != 0,
        peer_type: payload[OFF_TYPE],
    })
}

// ── System command parsers ──────────────────────────────────────────

fn parse_fs_list(payload: &[u8]) -> Result<BrickResponse, ProtocolError> {
    // Anything shorter than the header is a malformed reply, not an empty directory. Returning
    // an empty list for it made a corrupted exchange indistinguishable from a directory that
    // genuinely holds nothing.
    if payload.len() < SYSTEM_REPLY_HEADER_BYTES {
        return Err(ProtocolError::new(format!(
            "Malformed fs:list reply: expected at least {SYSTEM_REPLY_HEADER_BYTES} bytes, got {}.",
            payload.len()
        )));
    }
    // Measured against a real brick: the reply payload is
    //   [0] system command echo (0x99 LIST_FILES)
    //   [1] status
    //   [2..5] list size, uint32
    //   [6] handle
    //   [7..] the listing
    // Skipping 4 left three stray bytes glued to the first entry, which is exactly what a
    // directory listing beginning "\0\0\0tetris 22/" looked like.
    Ok(BrickResponse::FsList {
        listing: payload[SYSTEM_REPLY_HEADER_BYTES..].to_vec(),
        // Whether the brick still has more of this listing to hand over: the status is
        // END_OF_FILE on the last page.
        complete: payload[1] == system_status::END_OF_FILE,
        handle: Some(payload[6]),
    })
}

/// A continuation reply, whose header is `[echo][status][handle]`: three bytes, where the
/// opening `LIST_FILES` reply carries a four-byte list size as well.
/// The globals of a read from an offset ([`crate::commands::read_from_layout`]). The data area
/// holds what the last `READ_BYTES` left, skipped bytes included, so only as much as the size
/// says lies past the offset is taken.
fn parse_fs_read_from(
    payload: &[u8],
    offset: u32,
    max_bytes: u16,
) -> Result<BrickResponse, ProtocolError> {
    use crate::commands::read_from_layout::{DATA, EXISTS, SIZE};
    let data = DATA as usize;
    if payload.len() < data + usize::from(max_bytes) {
        return Err(ProtocolError::new(format!(
            "Malformed fs:readFrom reply: expected {} bytes, got {}.",
            data + usize::from(max_bytes),
            payload.len()
        )));
    }
    if payload[EXISTS as usize] == 0 {
        return Ok(BrickResponse::FsReadFrom {
            exists: false,
            size: 0,
            chunk: Vec::new(),
        });
    }
    let size = read_uint32le(payload, SIZE as usize)?;
    let count = size.saturating_sub(offset).min(u32::from(max_bytes)) as usize;
    Ok(BrickResponse::FsReadFrom {
        exists: true,
        size,
        chunk: payload[data..data + count].to_vec(),
    })
}

fn parse_fs_list_continue(payload: &[u8]) -> Result<BrickResponse, ProtocolError> {
    if payload.len() < 3 {
        return Err(ProtocolError::new(format!(
            "Malformed fs:listContinue reply: expected at least 3 bytes, got {}.",
            payload.len()
        )));
    }
    Ok(BrickResponse::FsListContinue {
        listing: payload[3..].to_vec(),
        complete: payload[1] == system_status::END_OF_FILE,
        handle: payload[2],
    })
}

/// Reads a whole directory listing: the bytes of every page, joined. One line per entry; the
/// firmware carries a name its page cut into the next page (`c_com.c`, CONTINUE_LIST_FILES), so
/// reading a page alone would make two wrong entries of it.
pub fn parse_listing(bytes: &[u8]) -> Vec<FsEntry> {
    String::from_utf8_lossy(bytes)
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(parse_listing_line)
        .collect()
}

/// The listing text a brick sends for `entries`, the inverse of [`parse_listing`]: `name/` for a
/// directory, `<md5> <size, 8 hex> name` for a file, one per line. For fakes and tests that play a
/// brick.
pub fn format_listing(entries: &[FsEntry]) -> Vec<u8> {
    let mut text = String::new();
    for entry in entries {
        match entry.kind {
            FsEntryKind::Directory => text.push_str(&format!("{}/\n", entry.name)),
            FsEntryKind::File => text.push_str(&format!(
                "{} {:08X} {}\n",
                entry
                    .md5
                    .clone()
                    .unwrap_or_else(|| "0".repeat(32))
                    .to_ascii_uppercase(),
                entry.bytes.unwrap_or(0),
                entry.name
            )),
            FsEntryKind::Unknown => text.push_str(&format!("{}\n", entry.name)),
        }
    }
    text.into_bytes()
}

/// Splits one listing line into its parts.
///
/// `cComGetFileInfo` writes a directory as `name/` and a file as
/// `<32 hex md5> <8 hex size> name`. The `.` and `..` entries arrive like any other directory
/// and are dropped by the caller, not here: a parser should not decide policy.
fn parse_listing_line(line: &str) -> FsEntry {
    if let Some(name) = line.strip_suffix('/') {
        return FsEntry {
            name: name.to_owned(),
            kind: FsEntryKind::Directory,
            bytes: None,
            md5: None,
        };
    }

    // 32 hex, space, 8 hex, space, then the name (one or more characters, none of them a line
    // terminator).
    if let Some((md5, size, name)) = split_file_line(line) {
        return FsEntry {
            name: name.to_owned(),
            kind: FsEntryKind::File,
            bytes: u32::from_str_radix(size, 16).ok(),
            md5: Some(md5.to_ascii_lowercase()),
        };
    }

    // A line in neither shape: report it rather than guess, so an unexpected firmware format
    // shows up as an odd name instead of a silently dropped entry.
    FsEntry {
        name: line.to_owned(),
        kind: FsEntryKind::Unknown,
        bytes: None,
        md5: None,
    }
}

fn split_file_line(line: &str) -> Option<(&str, &str, &str)> {
    let bytes = line.as_bytes();
    if bytes.len() < 32 + 1 + 8 + 1 + 1 || bytes[32] != b' ' || bytes[41] != b' ' {
        return None;
    }
    // Checked on bytes first: every slice point below is then an ASCII boundary.
    if !bytes[..32].iter().all(u8::is_ascii_hexdigit)
        || !bytes[33..41].iter().all(u8::is_ascii_hexdigit)
    {
        return None;
    }
    let md5 = &line[..32];
    let size = &line[33..41];
    let name = &line[42..];
    if name.is_empty() || name.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((md5, size, name))
}

fn parse_fs_read(payload: &[u8]) -> Result<BrickResponse, ProtocolError> {
    // Same reasoning as fs:list: too short to hold the header means malformed, not empty.
    if payload.len() < SYSTEM_REPLY_HEADER_BYTES {
        return Err(ProtocolError::new(format!(
            "Malformed fs:read reply: expected at least {SYSTEM_REPLY_HEADER_BYTES} bytes, got {}.",
            payload.len()
        )));
    }
    // Same 7-byte header as the listing reply, with the size field naming the file rather than
    // the listing.
    Ok(BrickResponse::FsRead {
        content: String::from_utf8_lossy(&payload[SYSTEM_REPLY_HEADER_BYTES..]).into_owned(),
    })
}

/// Reads the `[echo][status]` prefix every system reply opens with.
///
/// `END_OF_FILE` is deliberately not an error: the firmware sets it as a status on an ordinary
/// SYSTEM_REPLY (its error paths set `CmdType` to SYSTEM_REPLY_ERROR instead), and it is how a
/// transfer learns it has reached the last chunk.
fn transfer_status(payload: &[u8], kind: &str) -> Result<u8, ProtocolError> {
    if payload.len() < 2 {
        return Err(ProtocolError::new(format!(
            "Malformed {kind} reply: expected at least 2 bytes, got {}.",
            payload.len()
        )));
    }
    Ok(payload[1])
}

// ── Validation ──────────────────────────────────────────────────────

fn validate_reply(packet: &Ev3Packet<'_>, command_kind: &str) -> Result<(), ProtocolError> {
    if packet.packet_type == reply::DIRECT_REPLY_ERROR {
        return Err(ProtocolError::new(format!(
            "EV3 direct command error for '{command_kind}'"
        )));
    }
    if packet.packet_type == reply::SYSTEM_REPLY_ERROR {
        // payload[0] is the echoed system command, payload[1] the status: the same layout the
        // parsers above skip with SYSTEM_REPLY_HEADER_BYTES. Reading [0] here reported every
        // failure as the command byte, so an ILLEGAL_PATH came out as '0x99' and lost the one
        // piece of information the error carried.
        let status = packet.payload.get(1).copied().unwrap_or(0xff);
        let status_name =
            system_status::name_of(status).map_or_else(|| format!("0x{status:x}"), str::to_owned);
        return Err(ProtocolError::new(format!(
            "EV3 system command error for '{command_kind}': {status_name}"
        )));
    }
    Ok(())
}
