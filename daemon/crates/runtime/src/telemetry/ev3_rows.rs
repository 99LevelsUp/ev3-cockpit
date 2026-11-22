//! The EV3 row catalogue: every value the cockpit can read, as a row.
//!
//! Encodings are the ones the `ports`, `battery` and `buttons` commands use, so they inherit that
//! verification instead of being written from the specification again. That matters: the read-SI
//! opcode once held 0x9a (`opINPUT_READ`, a one-byte percent) instead of 0x9d (`opINPUT_READSI`, a
//! float), and every sensor value was one real byte followed by three bytes of the previous
//! command's leftovers.
//!
//! Which rows declare alignment 4 is per instruction, not per width: `opINPUT_READSI` rejects an
//! unaligned 32-bit result and answers an error carrying the previous payload, while
//! `opINPUT_DEVICE`/`READY_SI` accepts the same offset. Both measured 3 of 3 on a brick. The rows
//! use the former, so they are strict.

use std::sync::Arc;

use ev3_protocol::bytecode::{lc0, lc1, read_fixed_c_string, read_float32le, read_int32le};
use ev3_protocol::packet::{
    com_get_sub, com_hardware, input_device_sub, opcode, program_info_sub, program_slot,
    program_status, ui_button_sub, ui_read_sub,
};

use super::assembler::global_ref;
use super::error::TelemetryError;
use super::port_state::{PortState, port_state_of};
use super::row::{Lifetime, Parsed, Reading, RowCodec, RowResult, RowSlot, TelemetryRow, Tier};

const LAYER_SELF: u8 = 0;

/// The layers of the bricks a master can have below it in a USB daisy chain: three, for four
/// bricks in all (`DAISY_MAX_LAYER_DEPT`, `c_daisy.h`).
pub const CHAIN_LAYERS: [u8; 3] = [1, 2, 3];

/// Sensor ports 1-4 as the firmware numbers them.
const SENSOR_PORTS: [u8; 4] = [0, 1, 2, 3];

/// Motor ports as `opINPUT_DEVICE` numbers them: 16-19 for A-D. `opOUTPUT_GET_COUNT` numbers the
/// same sockets 0-3.
const MOTOR_INPUT_PORTS: [u8; 4] = [16, 17, 18, 19];

pub const SENSOR_PORT_NAMES: [&str; 4] = ["1", "2", "3", "4"];
pub const MOTOR_PORT_NAMES: [&str; 4] = ["A", "B", "C", "D"];

/// Buttons in the order the `buttons` command reads them.
pub const BUTTON_NAMES: [&str; 6] = ["up", "enter", "down", "right", "left", "back"];
const BUTTON_CODES: [u8; 6] = [1, 2, 3, 4, 5, 6];

/// The default divider of a sampled row: every tick.
pub const SAMPLED_DIVIDER: u32 = 1;
/// The default divider of an event row: every fifth tick, as LEGO's own Device Manager divides
/// its slow tier.
pub const EVENT_DIVIDER: u32 = 5;

/// The row that says whether a program runs in the user slot.
pub const PROGRAM_RUNNING_ROW: &str = "program.user.running";

/// The row that says how deep the chain below a brick is.
pub const CHAIN_DEPTH_ROW: &str = "chain.depth";

/// Entries in the master's device list: four sensor and four motor ports for each of four bricks.
const DEVICE_LIST_LENGTH: usize = 32;

const NAME_BYTES: usize = 16;
const VERSION_BYTES: usize = 16;

/// Which kind of port a row names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortKind {
    Sensor,
    Motor,
}

impl PortKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sensor => "sensor",
            Self::Motor => "motor",
        }
    }
}

/// The id of a port row: `ports.sensor.1.value` for the brick's own port, `chain.2.sensor.1.value`
/// for layer 2's.
pub fn port_row_id(kind: PortKind, name: &str, field: &str, layer: u8) -> String {
    if layer == LAYER_SELF {
        format!("ports.{}.{name}.{field}", kind.as_str())
    } else {
        format!("chain.{layer}.{}.{name}.{field}", kind.as_str())
    }
}

/// The port name a row keys on. The master's ports keep the names they always had (`1`); a
/// member's carries its layer (`2:3`), because the scheduler and the mode claims key on the port
/// name alone.
fn port_name(name: &str, layer: u8) -> String {
    if layer == LAYER_SELF {
        name.to_owned()
    } else {
        format!("{layer}:{name}")
    }
}

/// What an EV3 row reads, and how.
#[derive(Debug, Clone, Copy)]
enum Ev3Read {
    Occupancy {
        layer: u8,
        port: u8,
    },
    SensorSi {
        layer: u8,
        port: u8,
        mode: u8,
    },
    Tacho {
        index: u8,
    },
    BatteryLevel,
    BatteryVoltage,
    Button {
        code: u8,
    },
    BrickName,
    Radio {
        subcode: u8,
        hardware: u8,
        count: bool,
    },
    FirmwareVersion,
    ProgramRunning,
    ChainDepth,
}

fn constant(value: u8) -> Result<Vec<u8>, TelemetryError> {
    lc0(i32::from(value)).map_err(|error| TelemetryError::Assembly(error.to_string()))
}

fn byte_at(payload: &[u8], slot: RowSlot) -> Option<u8> {
    payload.get(slot).copied()
}

fn number(value: Option<f64>) -> Reading {
    value.map_or(Reading::Missing, Reading::Number)
}

impl RowCodec for Ev3Read {
    fn emit(&self, slot: RowSlot) -> Result<Vec<u8>, TelemetryError> {
        let mut out = Vec::new();
        match *self {
            Self::Occupancy { layer, port } => {
                out.extend([opcode::INPUT_DEVICE, input_device_sub::GET_TYPEMODE]);
                out.extend(constant(layer)?);
                out.extend(constant(port)?);
                out.extend(global_ref(slot)?);
                out.extend(global_ref(slot + 1)?);
            }
            Self::SensorSi { layer, port, mode } => {
                out.push(opcode::INPUT_READ_SI);
                out.extend(constant(layer)?);
                out.extend(constant(port)?);
                // Type hint 0: the firmware uses what it detected.
                out.extend(constant(0)?);
                out.extend(constant(mode)?);
                out.extend(global_ref(slot)?);
            }
            Self::Tacho { index } => {
                out.push(opcode::OUTPUT_GET_COUNT);
                out.extend(constant(LAYER_SELF)?);
                out.extend(constant(index)?);
                out.extend(global_ref(slot)?);
            }
            Self::BatteryLevel => {
                out.extend([opcode::UI_READ, ui_read_sub::GET_LBATT]);
                out.extend(global_ref(slot)?);
            }
            Self::BatteryVoltage => {
                out.extend([opcode::UI_READ, ui_read_sub::GET_VBATT]);
                out.extend(global_ref(slot)?);
            }
            Self::Button { code } => {
                out.extend([opcode::UI_BUTTON, ui_button_sub::PRESSED]);
                out.extend(constant(code)?);
                out.extend(global_ref(slot)?);
            }
            Self::BrickName => {
                out.extend([opcode::COM_GET, com_get_sub::GET_BRICKNAME]);
                out.extend(constant(NAME_BYTES as u8)?);
                out.extend(global_ref(slot)?);
            }
            Self::Radio {
                subcode, hardware, ..
            } => {
                out.extend([opcode::COM_GET, subcode]);
                out.extend(constant(hardware)?);
                out.extend(global_ref(slot)?);
            }
            Self::FirmwareVersion => {
                out.extend([opcode::UI_READ, ui_read_sub::GET_FW_VERS]);
                out.extend(constant(VERSION_BYTES as u8)?);
                out.extend(global_ref(slot)?);
            }
            Self::ProgramRunning => {
                out.push(opcode::PROGRAM_INFO);
                out.extend(constant(program_info_sub::GET_STATUS)?);
                out.extend(constant(program_slot::USER)?);
                out.extend(global_ref(slot)?);
            }
            Self::ChainDepth => {
                out.push(opcode::INPUT_DEVICE_LIST);
                // 32 does not fit a short constant (six bits, signed).
                out.extend(
                    lc1(DEVICE_LIST_LENGTH as i32)
                        .map_err(|error| TelemetryError::Assembly(error.to_string()))?,
                );
                out.extend(global_ref(slot)?);
                out.extend(global_ref(slot + DEVICE_LIST_LENGTH)?);
            }
        }
        Ok(out)
    }

    fn parse(&self, payload: &[u8], slot: RowSlot) -> Parsed {
        match *self {
            Self::Occupancy { .. } => Parsed {
                value: number(byte_at(payload, slot).map(f64::from)),
                mode: byte_at(payload, slot + 1),
            },
            Self::SensorSi { .. } | Self::BatteryVoltage => {
                Parsed::value(number(read_float32le(payload, slot).ok().map(f64::from)))
            }
            Self::Tacho { .. } => {
                Parsed::value(number(read_int32le(payload, slot).ok().map(f64::from)))
            }
            Self::BatteryLevel => Parsed::value(number(byte_at(payload, slot).map(f64::from))),
            Self::Button { .. } => Parsed::value(
                byte_at(payload, slot).map_or(Reading::Missing, |b| Reading::Flag(b == 1)),
            ),
            Self::BrickName => Parsed::value(text(payload, slot, NAME_BYTES)),
            Self::FirmwareVersion => Parsed::value(text(payload, slot, VERSION_BYTES)),
            Self::Radio { count, .. } => {
                Parsed::value(byte_at(payload, slot).map_or(Reading::Missing, |b| {
                    if count {
                        Reading::Number(f64::from(b))
                    } else {
                        Reading::Flag(b != 0)
                    }
                }))
            }
            Self::ProgramRunning => {
                Parsed::value(byte_at(payload, slot).map_or(Reading::Missing, |b| {
                    Reading::Flag(b == program_status::RUNNING)
                }))
            }
            Self::ChainDepth => Parsed::value(
                payload
                    .get(slot..slot + DEVICE_LIST_LENGTH)
                    .map_or(Reading::Missing, |types| {
                        Reading::Number(f64::from(chain_depth_of(types)))
                    }),
            ),
        }
    }
}

/// A string cut at its terminator: the firmware writes a string only up to it and never clears a
/// direct command's globals, so what follows is an earlier reply's leftovers.
fn text(payload: &[u8], slot: RowSlot, length: usize) -> Reading {
    if slot >= payload.len() {
        Reading::Missing
    } else {
        Reading::Text(read_fixed_c_string(payload, slot, length))
    }
}

/// The deepest layer with a device on any port. A brick with nothing plugged in reads exactly
/// like no brick, so an empty last member is not counted; one above a member with a device is,
/// because a chain has no gaps.
fn chain_depth_of(types: &[u8]) -> u8 {
    let mut depth = 0;
    for layer in CHAIN_LAYERS {
        let base = usize::from(layer) * 4;
        let occupied = (0..4).any(|port| {
            [base + port, 16 + base + port]
                .iter()
                .any(|&index| port_state_of(types.get(index).copied()) != PortState::Empty)
        });
        if occupied {
            depth = layer;
        }
    }
    depth
}

fn build(
    id: String,
    tier: Tier,
    divider: Option<u32>,
    bytes: usize,
    alignment: usize,
    read: Ev3Read,
) -> TelemetryRow {
    TelemetryRow {
        id,
        tier,
        lifetime: divider.map_or(Lifetime::OneShot, |divider| Lifetime::Repeating { divider }),
        result: RowResult { bytes, alignment },
        unit: None,
        port: None,
        layer: None,
        mode: None,
        reports_occupancy: false,
        reports_chain_depth: false,
        codec: Arc::new(read),
    }
}

fn with_port(mut row: TelemetryRow, name: &str, layer: u8) -> TelemetryRow {
    row.port = Some(port_name(name, layer));
    row.layer = (layer != LAYER_SELF).then_some(layer);
    row
}

fn with_unit(mut row: TelemetryRow, unit: &str) -> TelemetryRow {
    row.unit = Some(unit.to_owned());
    row
}

// ── Ports ────────────────────────────────────────────────────────────

/// What is plugged into one sensor port: the type code and the mode, two bytes.
///
/// A row with its own divider, not a header stapled to every frame: reading every port's type in
/// every frame took 48 of the 57 bytes on the HID link and left room for one value, so truncation
/// would have starved every value row. A hot-plug is noticed when this row next comes up, which is
/// invisible beside the second or two a device reports `TYPE_UNKNOWN` while it identifies.
/// `GET_TYPEMODE` reads memory and never blocks, so the row is safe at any divider.
pub fn sensor_occupancy_row(index: usize, divider: u32, layer: u8) -> TelemetryRow {
    occupancy_row(
        PortKind::Sensor,
        SENSOR_PORT_NAMES[index],
        SENSOR_PORTS[index],
        divider,
        layer,
    )
}

/// What is plugged into one motor port: the same instruction, the other port numbering. On a
/// member of a daisy chain this is all there is of a motor: its type crosses the chain, its tacho
/// does not.
pub fn motor_occupancy_row(index: usize, divider: u32, layer: u8) -> TelemetryRow {
    occupancy_row(
        PortKind::Motor,
        MOTOR_PORT_NAMES[index],
        MOTOR_INPUT_PORTS[index],
        divider,
        layer,
    )
}

fn occupancy_row(kind: PortKind, name: &str, port: u8, divider: u32, layer: u8) -> TelemetryRow {
    let row = build(
        port_row_id(kind, name, "occupancy", layer),
        Tier::Event,
        Some(divider),
        2,
        1,
        Ev3Read::Occupancy { layer, port },
    );
    TelemetryRow {
        reports_occupancy: true,
        ..with_port(row, name, layer)
    }
}

/// One sensor reading in SI units.
///
/// Comes up only while its port's last known occupancy was a real device type. `opINPUT_READSI`
/// never changes the dispatch status: an empty, faulty or still busy port answers NaN at once.
pub fn sensor_value_row(index: usize, mode: u8, divider: u32, layer: u8) -> TelemetryRow {
    let name = SENSOR_PORT_NAMES[index];
    let row = build(
        port_row_id(PortKind::Sensor, name, "value", layer),
        Tier::Sampled,
        Some(divider),
        4,
        4,
        Ev3Read::SensorSi {
            layer,
            port: SENSOR_PORTS[index],
            mode,
        },
    );
    TelemetryRow {
        mode: Some(mode),
        ..with_port(row, name, layer)
    }
}

/// One motor's tacho count, in degrees.
pub fn motor_tacho_row(index: usize, divider: u32) -> TelemetryRow {
    let name = MOTOR_PORT_NAMES[index];
    let row = build(
        format!("ports.motor.{name}.tacho"),
        Tier::Sampled,
        Some(divider),
        4,
        4,
        Ev3Read::Tacho { index: index as u8 },
    );
    with_unit(with_port(row, name, LAYER_SELF), "deg")
}

// ── System ───────────────────────────────────────────────────────────

/// Battery charge in percent. Event tier on purpose: it changes, but nothing needs its
/// instantaneous value.
pub fn battery_level_row(divider: u32) -> TelemetryRow {
    let row = build(
        "system.battery.level".into(),
        Tier::Event,
        Some(divider),
        1,
        1,
        Ev3Read::BatteryLevel,
    );
    with_unit(row, "%")
}

/// Battery voltage, float32.
pub fn battery_voltage_row(divider: u32) -> TelemetryRow {
    let row = build(
        "system.battery.voltage".into(),
        Tier::Event,
        Some(divider),
        4,
        4,
        Ev3Read::BatteryVoltage,
    );
    with_unit(row, "V")
}

/// One button's pressed state.
pub fn button_row(index: usize, divider: u32) -> TelemetryRow {
    build(
        format!("ui.button.{}", BUTTON_NAMES[index]),
        Tier::Sampled,
        Some(divider),
        1,
        1,
        Ev3Read::Button {
            code: BUTTON_CODES[index],
        },
    )
}

/// The brick's own name, which can change: renaming is a feature.
pub fn brick_name_row(divider: u32) -> TelemetryRow {
    build(
        "system.brickName".into(),
        Tier::Event,
        Some(divider),
        NAME_BYTES,
        1,
        Ev3Read::BrickName,
    )
}

/// One `opCOM_GET` byte about a radio.
///
/// The radio is named as Bluetooth or Wi-Fi on purpose: `GET_ON_OFF` asked of USB leaves the
/// dispatch status at FAILBREAK (`c_com.c` 4296-4330), which ends the whole direct command
/// (`lms2012.c` 2496-2510), so every row in the frame would be lost. The subcodes here answer
/// NOBREAK for the radios they are asked about.
fn radio_row(id: &str, subcode: u8, hardware: u8, count: bool, divider: u32) -> TelemetryRow {
    build(
        id.into(),
        Tier::Event,
        Some(divider),
        1,
        1,
        Ev3Read::Radio {
            subcode,
            hardware,
            count,
        },
    )
}

/// Bluetooth switched on in the brick's settings.
pub fn bluetooth_on_row(divider: u32) -> TelemetryRow {
    radio_row(
        "system.bluetooth.on",
        com_get_sub::GET_ON_OFF,
        com_hardware::BT,
        false,
        divider,
    )
}

/// Bluetooth visible to a search.
pub fn bluetooth_visible_row(divider: u32) -> TelemetryRow {
    radio_row(
        "system.bluetooth.visible",
        com_get_sub::GET_VISIBLE,
        com_hardware::BT,
        false,
        divider,
    )
}

/// How many peers the brick remembers on Bluetooth: the count only. The entries stay a command,
/// because the firmware does not bounds-check the index (`c_bt.c` 3561-3567), so each may be asked
/// only once this count is known.
pub fn bluetooth_peers_row(divider: u32) -> TelemetryRow {
    radio_row(
        "system.bluetooth.peers",
        com_get_sub::FAVOUR_ITEMS,
        com_hardware::BT,
        true,
        divider,
    )
}

/// Wi-Fi switched on.
pub fn wifi_on_row(divider: u32) -> TelemetryRow {
    radio_row(
        "system.wifi.on",
        com_get_sub::GET_ON_OFF,
        com_hardware::WIFI,
        false,
        divider,
    )
}

/// A Wi-Fi dongle the firmware knows is plugged in.
pub fn wifi_present_row(divider: u32) -> TelemetryRow {
    radio_row(
        "system.wifi.present",
        com_get_sub::GET_PRESENT,
        com_hardware::WIFI,
        false,
        divider,
    )
}

/// The firmware version: read once, then retired. Should flashing in-session ever become ours to
/// support, this row becomes repeating and nothing else changes.
pub fn firmware_version_row() -> TelemetryRow {
    build(
        "system.firmwareVersion".into(),
        Tier::Static,
        None,
        VERSION_BYTES,
        1,
        Ev3Read::FirmwareVersion,
    )
}

/// Whether a program runs in the user slot: the `program:status` command's encoding as a row, so
/// it rides in the frame a read brick sends anyway. Only `RUNNING` is a running program; a halted
/// or unknown slot is not.
pub fn program_running_row(divider: u32) -> TelemetryRow {
    build(
        PROGRAM_RUNNING_ROW.into(),
        Tier::Event,
        Some(divider),
        1,
        1,
        Ev3Read::ProgramRunning,
    )
}

// ── Daisy chain ──────────────────────────────────────────────────────

/// How many bricks hang below this one in a USB daisy chain: 0 for none, up to 3.
///
/// The master keeps the type of every port of the whole chain in one array and refreshes it on
/// its own (`c_input.c` `cInputDcmUpdate`); `opINPUT_DEVICE_LIST` copies it in one instruction that
/// never blocks (`c_input.c` 3750-3776). Sensors sit at layer × 4 + port, motors at
/// 16 + layer × 4 + port; measured on three chained bricks, the list agrees with `GET_TYPEMODE` on every port. The
/// list's `CHANGED` byte is not used: reading it resets it for the asking program slot, so a
/// second reader would steal it.
pub fn chain_depth_row(divider: u32) -> TelemetryRow {
    TelemetryRow {
        reports_chain_depth: true,
        ..build(
            CHAIN_DEPTH_ROW.into(),
            Tier::Event,
            Some(divider),
            DEVICE_LIST_LENGTH + 1,
            1,
            Ev3Read::ChainDepth,
        )
    }
}

/// Every row a brick offers, in truncation priority order.
///
/// What a user watches comes first: sensor values and tacho, then buttons, then the slower system
/// rows, then occupancy, which has a slow divider anyway, so losing it on a tight tick costs one
/// divider period, while losing a sensor value costs a visibly frozen reading. The rows of bricks
/// below this one in a chain follow the master's rows of the same kind, and the chain's depth
/// comes last. The scheduler orders by urgency each tick, so this order breaks ties only.
pub fn all_ev3_rows() -> Vec<TelemetryRow> {
    let mut rows = Vec::new();
    rows.extend((0..4).map(|i| sensor_value_row(i, 0, SAMPLED_DIVIDER, LAYER_SELF)));
    for layer in CHAIN_LAYERS {
        rows.extend((0..4).map(|i| sensor_value_row(i, 0, SAMPLED_DIVIDER, layer)));
    }
    rows.extend((0..4).map(|i| motor_tacho_row(i, SAMPLED_DIVIDER)));
    rows.extend((0..BUTTON_NAMES.len()).map(|i| button_row(i, SAMPLED_DIVIDER)));
    // Before the system rows: it decides how fast the whole loop may run.
    rows.push(program_running_row(EVENT_DIVIDER));
    rows.push(battery_voltage_row(EVENT_DIVIDER));
    rows.push(battery_level_row(EVENT_DIVIDER));
    rows.push(brick_name_row(EVENT_DIVIDER));
    rows.push(bluetooth_on_row(EVENT_DIVIDER));
    rows.push(bluetooth_visible_row(EVENT_DIVIDER));
    rows.push(bluetooth_peers_row(EVENT_DIVIDER));
    rows.push(wifi_on_row(EVENT_DIVIDER));
    rows.push(wifi_present_row(EVENT_DIVIDER));
    rows.push(firmware_version_row());
    rows.extend((0..4).map(|i| sensor_occupancy_row(i, EVENT_DIVIDER, LAYER_SELF)));
    rows.extend((0..4).map(|i| motor_occupancy_row(i, EVENT_DIVIDER, LAYER_SELF)));
    for layer in CHAIN_LAYERS {
        rows.extend((0..4).map(|i| sensor_occupancy_row(i, EVENT_DIVIDER, layer)));
    }
    for layer in CHAIN_LAYERS {
        rows.extend((0..4).map(|i| motor_occupancy_row(i, EVENT_DIVIDER, layer)));
    }
    rows.push(chain_depth_row(EVENT_DIVIDER));
    rows
}
