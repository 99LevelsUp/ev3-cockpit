//! Maps [`BrickCommand`] values to EV3 bytecode payloads.
//!
//! Each builder returns an [`EncodedCommand`] ready for packet framing. Direct commands use a
//! global variable allocation header (first 2 bytes) to reserve space for reply data.

use crate::bytecode::{c_string, concat_bytes, gv0, gv1, lc0, lc1, lcs, uint16le, uint32le};
use crate::error::ProtocolError;
use crate::packet::{
    MAX_BRICK_NAME_LENGTH, com_get_sub, com_hardware, com_set_sub, command, file_sub, filename_sub,
    input_device_sub, is_valid_brick_name, opcode, program_info_sub, program_slot, system,
    ui_button_sub, ui_read_sub,
};

// ── Constants ───────────────────────────────────────────────────────

const LAYER_SELF: i32 = 0;
/// Max bytes per system command chunk.
const SYSTEM_LIST_CHUNK_SIZE: u16 = 1012;

/// The firmware's own receive and transmit buffers, in bytes.
///
/// `c_com.c` sets `RxBuf[n].BufSize = 1024` and `TxBuf[n].BufSize = 1024` unconditionally, for
/// every communication channel. So this is a firmware property, not a transport one: USB, TCP
/// and Bluetooth all hit the same ceiling, and USB's 1025-byte HID report (one report id plus
/// 1024) matches it exactly.
pub const FIRMWARE_BUFFER_BYTES: usize = 1024;

/// Envelope before a system command's own payload: length, counter, type, command.
pub const SYSTEM_ENVELOPE_BYTES: usize = 2 + 2 + 1 + 1;

/// Largest chunk `CONTINUE_DOWNLOAD` can carry on the stock firmware: the buffer less the
/// envelope and the one-byte handle.
pub const MAX_WRITE_CHUNK_BYTES: usize = FIRMWARE_BUFFER_BYTES - SYSTEM_ENVELOPE_BYTES - 1;

/// Largest packet the protocol can express: its length field is 16 bits and does not count
/// itself. The encoders guard this; the firmware's own 1024 is the transfer service's business,
/// since a user may set a larger packet for a firmware that takes one.
pub const MAX_PROTOCOL_PACKET_BYTES: usize = 0xffff + 2;

/// Largest first chunk `BEGIN_DOWNLOAD` can carry for a given path.
///
/// `BEGIN_DOWNLOAD` carries payload directly after the zero-terminated path, so its room
/// shrinks as the path grows, unlike `CONTINUE_DOWNLOAD`, whose header is fixed. Negative when
/// the path alone does not fit.
pub fn max_first_chunk_bytes(path: &str, packet_bytes: usize) -> i64 {
    let path_bytes = path.len() as i64 + 1;
    packet_bytes as i64 - SYSTEM_ENVELOPE_BYTES as i64 - 4 - path_bytes
}

// ── Capability probe (info command) ─────────────────────────────────

/// Lengths and offsets for info reply parsing.
pub mod info_layout {
    pub const LEN_BRICK_NAME: usize = 16;
    pub const LEN_OS_VERS: usize = 16;
    pub const LEN_HW_VERS: usize = 8;
    pub const LEN_FW_VERS: usize = 8;
    pub const LEN_OS_BUILD: usize = 12;
    pub const LEN_FW_BUILD: usize = 12;

    pub const OFF_BRICK_NAME: usize = 0;
    pub const OFF_OS_VERS: usize = OFF_BRICK_NAME + LEN_BRICK_NAME;
    pub const OFF_HW_VERS: usize = OFF_OS_VERS + LEN_OS_VERS;
    pub const OFF_FW_VERS: usize = OFF_HW_VERS + LEN_HW_VERS;
    pub const OFF_OS_BUILD: usize = OFF_FW_VERS + LEN_FW_VERS;
    pub const OFF_FW_BUILD: usize = OFF_OS_BUILD + LEN_OS_BUILD;
    pub const TOTAL_INFO_BYTES: usize = OFF_FW_BUILD + LEN_FW_BUILD;
}

// ── Bluetooth peer entry ────────────────────────────────────────────

/// Offsets for a `FAVOUR_ITEM` reply.
pub mod bt_peer_layout {
    /// Name slot of a `FAVOUR_ITEM` read: the largest DATA8 length, see the peer command.
    pub const NAME_BYTES: usize = 127;
    pub const OFF_NAME: usize = 0;
    pub const OFF_PAIRED: usize = NAME_BYTES;
    pub const OFF_CONNECTED: usize = NAME_BYTES + 1;
    pub const OFF_TYPE: usize = NAME_BYTES + 2;
    pub const TOTAL_BYTES: usize = NAME_BYTES + 3;
}

// ── Port layout ─────────────────────────────────────────────────────

/// Sensor port indices (1-4 mapped to 0-3 in EV3 protocol).
const SENSOR_PORTS: [i32; 4] = [0, 1, 2, 3];
/// Motor port indices (A-D mapped to 16-19 in EV3 INPUT_DEVICE, 0-3 for OUTPUT).
const MOTOR_INPUT_PORTS: [i32; 4] = [16, 17, 18, 19];

/// The firmware's file-handle table has this many slots (`lms2012.h` 363, `MAX_FILE_HANDLES`).
pub const FILE_HANDLE_SLOTS: u8 = 64;

// ── Public interface ────────────────────────────────────────────────

/// A command the encoder takes: the analogue of the command set a brick session sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrickCommand {
    /// A telemetry frame already built as bytecode (globals word followed by the bytecode).
    /// Passed through unchanged: only whoever composed it knows its layout.
    TelemetryFrame {
        payload: Vec<u8>,
    },
    Battery,
    Ports,
    Buttons,
    Info,
    /// Rename the brick. Checked here because the firmware's rejection is silent.
    SetName {
        name: String,
    },
    /// Switch the brick's Bluetooth radio on or off.
    SetBluetooth {
        on: bool,
    },
    /// Make the brick discoverable, or stop it answering inquiries.
    SetBluetoothVisible {
        visible: bool,
    },
    /// How many Bluetooth peers the brick remembers. Read this first and ask for a peer only
    /// below it: the firmware does not bounds-check the index (`c_bt.c` 3561-3567).
    BluetoothPeerCount,
    /// One remembered Bluetooth peer, by index. Only 0..=31 can be encoded.
    BluetoothPeer {
        index: u8,
    },
    /// Remove one remembered Bluetooth peer by exact name.
    RemoveBluetoothPeer {
        name: String,
    },
    ProgramRun {
        path: String,
    },
    ProgramStop,
    ProgramStatus,
    ProgramEmergencyStop,
    SystemRun {
        command: String,
    },
    FsList {
        path: String,
    },
    FsRead {
        path: String,
    },
    FsWrite {
        path: String,
        content: String,
    },
    FsExists {
        path: String,
    },
    FsDelete {
        path: String,
    },
    FsBeginWrite {
        path: String,
        total_bytes: u32,
        chunk: Vec<u8>,
    },
    FsContinueWrite {
        handle: u8,
        chunk: Vec<u8>,
    },
    FsBeginRead {
        path: String,
        want_bytes: u16,
    },
    FsContinueRead {
        handle: u8,
        want_bytes: u16,
    },
    FsCloseHandle {
        handle: u8,
    },
    FsSize {
        path: String,
    },
    FsFreeSpace,
    FsMakeDirectory {
        path: String,
    },
    /// Copies rather than moves: the firmware's MOVE subcode leaves the source.
    FsCopy {
        from: String,
        to: String,
    },
    /// Recursive delete. `FsDelete` refuses a populated directory; this does not.
    FsRemoveTree {
        path: String,
    },
    /// Continues a listing the brick could not fit in one reply.
    FsListContinue {
        handle: u8,
        want_bytes: u16,
    },
}

impl BrickCommand {
    /// The command's name as it appears in error messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::TelemetryFrame { .. } => "telemetry:frame",
            Self::Battery => "battery",
            Self::Ports => "ports",
            Self::Buttons => "buttons",
            Self::Info => "info",
            Self::SetName { .. } => "brick:setName",
            Self::SetBluetooth { .. } => "brick:setBluetooth",
            Self::SetBluetoothVisible { .. } => "brick:setBluetoothVisible",
            Self::BluetoothPeerCount => "brick:bluetoothPeerCount",
            Self::BluetoothPeer { .. } => "brick:bluetoothPeer",
            Self::RemoveBluetoothPeer { .. } => "brick:removeBluetoothPeer",
            Self::ProgramRun { .. } => "program:run",
            Self::ProgramStop => "program:stop",
            Self::ProgramStatus => "program:status",
            Self::ProgramEmergencyStop => "program:emergencyStop",
            Self::SystemRun { .. } => "system:run",
            Self::FsList { .. } => "fs:list",
            Self::FsRead { .. } => "fs:read",
            Self::FsWrite { .. } => "fs:write",
            Self::FsExists { .. } => "fs:exists",
            Self::FsDelete { .. } => "fs:delete",
            Self::FsBeginWrite { .. } => "fs:beginWrite",
            Self::FsContinueWrite { .. } => "fs:continueWrite",
            Self::FsBeginRead { .. } => "fs:beginRead",
            Self::FsContinueRead { .. } => "fs:continueRead",
            Self::FsCloseHandle { .. } => "fs:closeHandle",
            Self::FsSize { .. } => "fs:size",
            Self::FsFreeSpace => "fs:freeSpace",
            Self::FsMakeDirectory { .. } => "fs:makeDirectory",
            Self::FsCopy { .. } => "fs:copy",
            Self::FsRemoveTree { .. } => "fs:removeTree",
            Self::FsListContinue { .. } => "fs:listContinue",
        }
    }
}

/// An encoded command: type byte and payload, ready for [`crate::encode_ev3_packet`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedCommand {
    /// EV3 command type byte.
    pub packet_type: u8,
    /// Bytecode payload (direct command) or system command payload.
    pub payload: Vec<u8>,
}

/// Builds the EV3 wire payload for a [`BrickCommand`].
pub fn build_command(cmd: &BrickCommand) -> Result<EncodedCommand, ProtocolError> {
    match cmd {
        // Already bytecode: the assembler composed it from whichever rows came up. Nothing
        // here can add to that, and re-deriving it would need the row set the caller has.
        BrickCommand::TelemetryFrame { payload } => Ok(direct_raw(payload.clone())),
        BrickCommand::Battery => build_battery_command(),
        BrickCommand::Ports => build_ports_command(),
        BrickCommand::Buttons => build_buttons_command(),
        BrickCommand::Info => build_info_command(),
        BrickCommand::SetName { name } => build_set_brick_name_command(name),
        BrickCommand::SetBluetooth { on } => {
            build_com_set_flag_command(com_set_sub::SET_ON_OFF, *on)
        }
        BrickCommand::SetBluetoothVisible { visible } => {
            build_com_set_flag_command(com_set_sub::SET_VISIBLE, *visible)
        }
        BrickCommand::BluetoothPeerCount => build_bluetooth_peer_count_command(),
        BrickCommand::BluetoothPeer { index } => build_bluetooth_peer_command(*index),
        BrickCommand::RemoveBluetoothPeer { name } => build_remove_bluetooth_peer_command(name),
        BrickCommand::ProgramRun { path } => build_program_run_command(path),
        BrickCommand::ProgramStop => direct_command(
            0,
            &[
                &[opcode::PROGRAM_STOP],
                &lc0(i32::from(program_slot::USER))?,
            ],
        ),
        BrickCommand::ProgramStatus => direct_command(
            1,
            &[
                &[opcode::PROGRAM_INFO],
                &lc0(i32::from(program_info_sub::GET_STATUS))?,
                &lc0(i32::from(program_slot::USER))?,
                &gv0(0)?,
            ],
        ),
        // The brick's own power-off sequence (`ui.lms` 1887-1889). Never PROGRAM_STOP(0): slot 0
        // means every slot, the brick's UI too, and the VM exits (`lms2012.c` 2943-2951).
        BrickCommand::ProgramEmergencyStop => direct_command(
            0,
            &[
                &[opcode::PROGRAM_STOP],
                &lc0(i32::from(program_slot::USER))?,
                &[opcode::PROGRAM_STOP],
                &lc0(i32::from(program_slot::DEBUG))?,
                &[opcode::INPUT_DEVICE],
                &lc0(i32::from(input_device_sub::STOP_ALL))?,
                &lc0(-1)?,
            ],
        ),
        BrickCommand::SystemRun { command: shell } => {
            if shell.trim().is_empty() {
                return Err(ProtocolError::new("Refusing an empty shell command."));
            }
            direct_command(4, &[&[opcode::SYSTEM], &lcs(shell), &gv0(0)?])
        }
        BrickCommand::FsList { path } => Ok(system_command(&[
            &[system::LIST_FILES],
            &uint16le(SYSTEM_LIST_CHUNK_SIZE),
            &c_string(path),
        ])),
        BrickCommand::FsRead { path } => Ok(system_command(&[
            &[system::BEGIN_UPLOAD],
            &uint16le(SYSTEM_LIST_CHUNK_SIZE),
            &c_string(path),
        ])),
        BrickCommand::FsWrite { path, content } => {
            let length = u32::try_from(content.len()).map_err(|_| {
                ProtocolError::new("fs:write content does not fit a 32-bit length.")
            })?;
            Ok(system_command(&[
                &[system::BEGIN_DOWNLOAD],
                &uint32le(length),
                &c_string(path),
                content.as_bytes(),
            ]))
        }
        BrickCommand::FsExists { path } => build_fs_exists_command(path),
        BrickCommand::FsDelete { path } => {
            Ok(system_command(&[&[system::DELETE_FILE], &c_string(path)]))
        }
        BrickCommand::FsBeginWrite {
            path,
            total_bytes,
            chunk,
        } => build_fs_begin_write_command(path, *total_bytes, chunk),
        BrickCommand::FsContinueWrite { handle, chunk } => {
            build_fs_continue_write_command(assert_file_handle(*handle)?, chunk)
        }
        BrickCommand::FsBeginRead { path, want_bytes } => Ok(system_command(&[
            &[system::BEGIN_UPLOAD],
            &uint16le(*want_bytes),
            &c_string(path),
        ])),
        BrickCommand::FsContinueRead { handle, want_bytes } => Ok(system_command(&[
            &[system::CONTINUE_UPLOAD, assert_file_handle(*handle)?],
            &uint16le(*want_bytes),
        ])),
        BrickCommand::FsCloseHandle { handle } => Ok(system_command(&[&[
            system::CLOSE_FILEHANDLE,
            assert_file_handle(*handle)?,
        ]])),
        BrickCommand::FsSize { path } => build_fs_size_command(path),
        BrickCommand::FsFreeSpace => build_fs_free_space_command(),
        BrickCommand::FsMakeDirectory { path } => build_fs_make_directory_command(path),
        BrickCommand::FsCopy { from, to } => build_fs_copy_command(from, to),
        BrickCommand::FsRemoveTree { path } => build_fs_remove_tree_command(path),
        BrickCommand::FsListContinue { handle, want_bytes } => Ok(system_command(&[
            &[system::CONTINUE_LIST_FILES, assert_file_handle(*handle)?],
            &uint16le(*want_bytes),
        ])),
    }
}

/// Refuses a file handle outside the firmware's table. The firmware reads `Files[handle]` before
/// it checks the bound, and a byte of 128 or more becomes a negative index (`c_com.c` 529-531,
/// `DATA8`): a number past the table is a read of someone else's memory, not an error.
fn assert_file_handle(handle: u8) -> Result<u8, ProtocolError> {
    if handle < FILE_HANDLE_SLOTS {
        Ok(handle)
    } else {
        Err(ProtocolError::new(format!(
            "A file handle is 0..{}, not {handle}.",
            FILE_HANDLE_SLOTS - 1
        )))
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

fn direct_raw(payload: Vec<u8>) -> EncodedCommand {
    EncodedCommand {
        packet_type: command::DIRECT_COMMAND_REPLY,
        payload,
    }
}

/// A direct command that wants a reply, with `globals` bytes of global variables for it.
fn direct_command(globals: u16, bytecode: &[&[u8]]) -> Result<EncodedCommand, ProtocolError> {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(bytecode.len() + 1);
    let header = uint16le(globals);
    parts.push(&header);
    parts.extend_from_slice(bytecode);
    Ok(direct_raw(concat_bytes(&parts)))
}

fn system_command(parts: &[&[u8]]) -> EncodedCommand {
    EncodedCommand {
        packet_type: command::SYSTEM_COMMAND_REPLY,
        payload: concat_bytes(parts),
    }
}

// ── Direct commands ─────────────────────────────────────────────────

/// Battery: charge level, voltage and current in one round trip.
///
/// Global layout: [0..3] volts float32, [4..7] amps float32, [8] level percent.
///
/// This used to ask only for GET_IBATT and report `current * 200` as the level. On a brick
/// reading 100 % that produced 29 %, because current draw tracks motor load rather than
/// remaining charge. GET_LBATT answers the actual question.
///
/// The floats sit at offsets 0 and 4 with the single byte last: putting the byte first left
/// both floats unaligned and the firmware rejected the whole command.
fn build_battery_command() -> Result<EncodedCommand, ProtocolError> {
    direct_command(
        9,
        &[
            &[opcode::UI_READ, ui_read_sub::GET_VBATT],
            &gv0(0)?,
            &[opcode::UI_READ, ui_read_sub::GET_IBATT],
            &gv0(4)?,
            &[opcode::UI_READ, ui_read_sub::GET_LBATT],
            &gv0(8)?,
        ],
    )
}

/// Ports: reads sensor type/mode for 4 sensor ports and 4 motor ports, plus one float32 SI
/// value per port.
///
/// Global allocation layout:
/// - Bytes 0..7:   sensor type+mode (2 bytes x 4 ports)
/// - Bytes 8..15:  motor type+mode (2 bytes x 4 ports)
/// - Bytes 16..31: sensor SI values (4 bytes x 4 ports)
/// - Bytes 32..47: motor tacho (4 bytes x 4 ports)
fn build_ports_command() -> Result<EncodedCommand, ProtocolError> {
    let global_bytes: u16 = 8 + 8 + 16 + 16; // 48
    let mut ops: Vec<Vec<u8>> = vec![uint16le(global_bytes).to_vec()];

    // Sensor type/mode: 2 bytes each at offsets 0..7
    for (i, port) in SENSOR_PORTS.iter().enumerate() {
        let i = i as u32;
        ops.push(vec![opcode::INPUT_DEVICE, input_device_sub::GET_TYPEMODE]);
        ops.push(lc0(LAYER_SELF)?);
        ops.push(lc0(*port)?);
        ops.push(gv0(i * 2)?); // type
        ops.push(gv0(i * 2 + 1)?); // mode
    }

    // Motor type/mode: 2 bytes each at offsets 8..15
    for (i, port) in MOTOR_INPUT_PORTS.iter().enumerate() {
        let i = i as u32;
        ops.push(vec![opcode::INPUT_DEVICE, input_device_sub::GET_TYPEMODE]);
        ops.push(lc0(LAYER_SELF)?);
        ops.push(lc0(*port)?);
        ops.push(gv0(8 + i * 2)?); // type
        ops.push(gv0(8 + i * 2 + 1)?); // mode
    }

    // Sensor SI values: 4 bytes each at offsets 16..31
    for (i, port) in SENSOR_PORTS.iter().enumerate() {
        ops.push(vec![opcode::INPUT_READ_SI]);
        ops.push(lc0(LAYER_SELF)?);
        ops.push(lc0(*port)?);
        ops.push(lc0(0)?); // type hint (0 = auto)
        ops.push(lc0(0)?); // mode hint (0 = default)
        ops.push(gv0(16 + i as u32 * 4)?);
    }

    // Motor tacho: 4 bytes each at offsets 32..47
    for i in 0..4 {
        ops.push(vec![opcode::OUTPUT_GET_COUNT]);
        ops.push(lc0(LAYER_SELF)?);
        ops.push(lc0(i)?); // motor port index 0-3
        ops.push(gv1(32 + i as u32 * 4)?);
    }

    let parts: Vec<&[u8]> = ops.iter().map(Vec::as_slice).collect();
    Ok(direct_raw(concat_bytes(&parts)))
}

/// Buttons: one byte per button, in the order up, enter, down, right, left, back.
///
/// This once asked `opUI_READ` for subcode 0x0d, which is GET_ADDRESS, not a button read: a real
/// brick answered the whole command with an error, so button telemetry never worked outside the
/// mock. `opUI_BUTTON` with PRESSED is the right opcode.
fn build_buttons_command() -> Result<EncodedCommand, ProtocolError> {
    let mut ops: Vec<Vec<u8>> = vec![uint16le(6).to_vec()];
    for (i, button_id) in [1, 2, 3, 4, 5, 6].into_iter().enumerate() {
        ops.push(vec![opcode::UI_BUTTON, ui_button_sub::PRESSED]);
        ops.push(lc0(button_id)?);
        ops.push(gv0(i as u32)?);
    }
    let parts: Vec<&[u8]> = ops.iter().map(Vec::as_slice).collect();
    Ok(direct_raw(concat_bytes(&parts)))
}

/// Info: the brick's own name, plus firmware, OS and hardware versions.
///
/// The name comes from `opCOM_GET` / GET_BRICKNAME. It used to be absent entirely and
/// `displayName` carried the OS version instead, so a brick called AAA reported itself as
/// "Linux 2.6.33-rc".
fn build_info_command() -> Result<EncodedCommand, ProtocolError> {
    use info_layout::*;
    let mut ops: Vec<Vec<u8>> = vec![uint16le(TOTAL_INFO_BYTES as u16).to_vec()];

    let mut read_string = |op: u8, sub: u8, len: usize, off: usize| -> Result<(), ProtocolError> {
        ops.push(vec![op, sub]);
        ops.push(lc0(len as i32)?);
        if off < 32 {
            ops.push(gv0(off as u32)?);
        } else {
            ops.push(gv1(off as u32)?);
        }
        Ok(())
    };

    read_string(
        opcode::COM_GET,
        com_get_sub::GET_BRICKNAME,
        LEN_BRICK_NAME,
        OFF_BRICK_NAME,
    )?;
    read_string(
        opcode::UI_READ,
        ui_read_sub::GET_OS_VERS,
        LEN_OS_VERS,
        OFF_OS_VERS,
    )?;
    read_string(
        opcode::UI_READ,
        ui_read_sub::GET_HW_VERS,
        LEN_HW_VERS,
        OFF_HW_VERS,
    )?;
    read_string(
        opcode::UI_READ,
        ui_read_sub::GET_FW_VERS,
        LEN_FW_VERS,
        OFF_FW_VERS,
    )?;
    read_string(
        opcode::UI_READ,
        ui_read_sub::GET_OS_BUILD,
        LEN_OS_BUILD,
        OFF_OS_BUILD,
    )?;
    read_string(
        opcode::UI_READ,
        ui_read_sub::GET_FW_BUILD,
        LEN_FW_BUILD,
        OFF_FW_BUILD,
    )?;

    let parts: Vec<&[u8]> = ops.iter().map(Vec::as_slice).collect();
    Ok(direct_raw(concat_bytes(&parts)))
}

/// Rename the brick.
///
/// The reply carries nothing useful, and the only way to know the rename took is to read the
/// name back with `info`.
///
/// Characters and length are checked here rather than left to the brick because the firmware's
/// rejection is silent: `ValidateString` fails, `DspStat` stays untouched, and the caller sees a
/// command that appeared to work on a brick that did not change its name.
fn build_set_brick_name_command(name: &str) -> Result<EncodedCommand, ProtocolError> {
    if !is_valid_brick_name(name) {
        return Err(ProtocolError::new(format!(
            "Brick name \"{name}\" is not one the firmware accepts: letters, digits, \"_\" and \"-\" only, \
             no spaces or accented letters."
        )));
    }
    if name.len() > MAX_BRICK_NAME_LENGTH {
        return Err(ProtocolError::new(format!(
            "Brick name is {} characters; the firmware accepts at most {MAX_BRICK_NAME_LENGTH}.",
            name.len()
        )));
    }

    // Asks for a reply even though it reads nothing back: the channel matches every command to a
    // reply packet by message counter, so a NO_REPLY command would simply time out. Zero globals
    // means the brick answers with a bare status.
    direct_command(
        0,
        &[&[opcode::COM_SET, com_set_sub::SET_BRICKNAME], &lcs(name)],
    )
}

/// Switch one of the brick's radios on, or make it discoverable.
///
/// Both subcodes read the same two parameters (which radio, then the flag), so they share a
/// builder. Sending only the flag would have the firmware read the flag as the hardware selector
/// and then take whatever followed as the value, which looks like a dead command rather than a
/// malformed one.
fn build_com_set_flag_command(subcode: u8, value: bool) -> Result<EncodedCommand, ProtocolError> {
    direct_command(
        0,
        &[
            &[opcode::COM_SET, subcode],
            &lc0(i32::from(com_hardware::BT))?,
            &lc0(i32::from(value))?,
        ],
    )
}

/// `FAVOUR_ITEMS` on Bluetooth: one global byte, the number of remembered peers.
fn build_bluetooth_peer_count_command() -> Result<EncodedCommand, ProtocolError> {
    direct_command(
        1,
        &[
            &[opcode::COM_GET, com_get_sub::FAVOUR_ITEMS],
            &lc0(i32::from(com_hardware::BT))?,
            &gv0(0)?,
        ],
    )
}

/// `FAVOUR_ITEM` on Bluetooth: one peer's name, then paired, connected and type.
///
/// Global layout: [0..126] name, [127] paired, [128] connected, [129] type.
///
/// The name length is 127 because nothing larger can be asked for. The firmware passes it
/// straight to `snprintf` (`c_bt.c` 3565). It swaps -1 for `vmBRICKNAMESIZE` only when the name
/// goes to a handle (`c_com.c` 4624-4629), which a global variable is not: `PrimParPointer` sets
/// the handle only for `PRIMPAR_HANDLE` (`lms2012.c` 698, 813-817). The length is a DATA8 read
/// with sign extension (`lms2012.c` 776-786), so -1 or anything above 127 would become a huge
/// size and let a long name run past the reply buffer.
fn build_bluetooth_peer_command(index: u8) -> Result<EncodedCommand, ProtocolError> {
    use bt_peer_layout::*;
    direct_command(
        TOTAL_BYTES as u16,
        &[
            &[opcode::COM_GET, com_get_sub::FAVOUR_ITEM],
            &lc0(i32::from(com_hardware::BT))?,
            &lc0(i32::from(index))?,
            &lc1(NAME_BYTES as i32)?,
            &gv0(OFF_NAME as u32)?,
            &gv1(OFF_PAIRED as u32)?,
            &gv1(OFF_CONNECTED as u32)?,
            &gv1(OFF_TYPE as u32)?,
        ],
    )
}

/// Whether a peer name is empty or blank, which a removal cannot address: the firmware reads an
/// empty one as a wildcard for the first named entry (`c_bt.c` 2205-2211).
pub fn is_blank_peer_name(name: &str) -> bool {
    name.trim().is_empty()
}

/// `opCOM_REMOVE` on Bluetooth, by the peer's name.
///
/// Refuses an empty or blank name and checks nothing else. Empty is the firmware's wildcard for
/// the first named entry (`c_bt.c` 2205-2211), so it would forget some other computer; blank is
/// refused with it because no computer is called that. The brick-name character set does not
/// apply: this is another device's Bluetooth name, which may hold spaces, dots or accented
/// letters, and the firmware compares the bytes as stored.
fn build_remove_bluetooth_peer_command(name: &str) -> Result<EncodedCommand, ProtocolError> {
    if is_blank_peer_name(name) {
        return Err(ProtocolError::new(
            "Refusing to remove a Bluetooth peer with an empty name: the brick would remove \
             the first entry in its list instead.",
        ));
    }
    // Asks for a reply for the same reason a rename does: the channel matches replies by
    // message counter.
    direct_command(
        0,
        &[
            &[opcode::COM_REMOVE],
            &lc0(i32::from(com_hardware::BT))?,
            &lcs(name),
        ],
    )
}

// ── Programs and the shell ──────────────────────────────────────────

/// Load an `.rbf` into the user slot and start it, as the firmware's own example does (`c_com.h`
/// 820-843) but with globals instead of locals, so the reply carries the image's size: 0 means
/// the file is not on the brick, and the start that followed found no image (`lms2012.c` 1427).
/// Globals: [0..3] size, [4..7] image address. PROGRAM_START reads the size and ignores it
/// ("Dummy", `lms2012.c` 2995-2998); debug 0 runs it normally.
fn build_program_run_command(path: &str) -> Result<EncodedCommand, ProtocolError> {
    if path.trim().is_empty() {
        return Err(ProtocolError::new(
            "Refusing to run a program with an empty path.",
        ));
    }
    let slot = lc0(i32::from(program_slot::USER))?;
    direct_command(
        8,
        &[
            &[opcode::FILE],
            &lc0(i32::from(file_sub::LOAD_IMAGE))?,
            &slot,
            &lcs(path),
            &gv0(0)?,
            &gv0(4)?,
            &[opcode::PROGRAM_START],
            &slot,
            &gv0(0)?,
            &gv0(4)?,
            &lc0(0)?,
        ],
    )
}

// ── Direct-command filesystem operations ───────────────────────────

/// `opFILENAME/EXIST`: one output byte, non-zero when the path resolves.
///
/// Replaces inferring existence from a directory listing, which needed the parent read and
/// paged wrongly for a listing that spanned packets.
fn build_fs_exists_command(path: &str) -> Result<EncodedCommand, ProtocolError> {
    direct_command(
        1,
        &[
            &[opcode::FILENAME, filename_sub::EXIST],
            &lcs(path),
            &gv0(0)?,
        ],
    )
}

/// `opFILENAME/TOTALSIZE`: outputs a file count and a byte total, in that order.
fn build_fs_size_command(path: &str) -> Result<EncodedCommand, ProtocolError> {
    direct_command(
        8,
        &[
            &[opcode::FILENAME, filename_sub::TOTALSIZE],
            &lcs(path),
            &gv0(0)?,
            &gv0(4)?,
        ],
    )
}

/// `opMEMORY_USAGE`: total then free, in kilobytes. No subcode.
///
/// Not `opFILE/GET_POOL`, which allocates an image pool and reports nothing about storage.
fn build_fs_free_space_command() -> Result<EncodedCommand, ProtocolError> {
    direct_command(8, &[&[opcode::MEMORY_USAGE], &gv0(0)?, &gv0(4)?])
}

/// `opFILE/MAKE_FOLDER`: one output byte, set when the directory exists afterwards.
fn build_fs_make_directory_command(path: &str) -> Result<EncodedCommand, ProtocolError> {
    direct_command(
        1,
        &[&[opcode::FILE, file_sub::MAKE_FOLDER], &lcs(path), &gv0(0)?],
    )
}

/// `opFILE/MOVE`: a recursive copy that leaves the source. No output.
fn build_fs_copy_command(from: &str, to: &str) -> Result<EncodedCommand, ProtocolError> {
    direct_command(0, &[&[opcode::FILE, file_sub::MOVE], &lcs(from), &lcs(to)])
}

/// `opFILE/REMOVE`: recursive delete by name. No output.
fn build_fs_remove_tree_command(path: &str) -> Result<EncodedCommand, ProtocolError> {
    direct_command(0, &[&[opcode::FILE, file_sub::REMOVE], &lcs(path)])
}

// ── System commands (transfers) ─────────────────────────────────────

fn build_fs_begin_write_command(
    path: &str,
    total_bytes: u32,
    chunk: &[u8],
) -> Result<EncodedCommand, ProtocolError> {
    // Sized against what the protocol can carry; the link's packet (the firmware's buffer, a
    // tighter host transport, or a size the user set) is the service's business, and its own
    // guard catches that before this one.
    let room = max_first_chunk_bytes(path, MAX_PROTOCOL_PACKET_BYTES);
    if chunk.len() as i64 > room {
        return Err(ProtocolError::new(format!(
            "BEGIN_DOWNLOAD first chunk of {} bytes exceeds the {room} bytes left after a {}-character path.",
            chunk.len(),
            path.encode_utf16().count()
        )));
    }
    // The brick refuses a chunk larger than the size it was told to expect (SIZE_ERROR), so
    // catch the caller's arithmetic here rather than reading it back off the wire.
    if chunk.len() as u64 > u64::from(total_bytes) {
        return Err(ProtocolError::new(format!(
            "First chunk of {} bytes exceeds the declared total of {total_bytes}.",
            chunk.len()
        )));
    }
    Ok(system_command(&[
        &[system::BEGIN_DOWNLOAD],
        &uint32le(total_bytes),
        &c_string(path),
        chunk,
    ]))
}

fn build_fs_continue_write_command(
    handle: u8,
    chunk: &[u8],
) -> Result<EncodedCommand, ProtocolError> {
    // The protocol's ceiling; the link's packet is the service's to keep (see the begin-write
    // builder).
    let room = MAX_PROTOCOL_PACKET_BYTES - SYSTEM_ENVELOPE_BYTES - 1;
    if chunk.len() > room {
        return Err(ProtocolError::new(format!(
            "CONTINUE_DOWNLOAD chunk of {} bytes exceeds the protocol's {room}-byte limit.",
            chunk.len()
        )));
    }
    Ok(system_command(&[
        &[system::CONTINUE_DOWNLOAD, handle],
        chunk,
    ]))
}
