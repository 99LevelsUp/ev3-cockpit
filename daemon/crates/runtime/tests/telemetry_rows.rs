//! The pure telemetry core: the frame assembler, the row catalogue and registry, port states, the
//! program row, the throttle, the cadence and the settings' defaults. Ports of
//! `frameAssembler.test.ts`, `rowRegistry.test.ts`, `portState.test.ts`, `programRow.test.ts`,
//! `tickThrottle.test.ts`, the cadence cases of `brickTelemetry.test.ts` and
//! `telemetrySettings.test.ts`. Names are `<describe>__<it>` in snake case.

#![allow(non_snake_case)]

mod support_telemetry;

use ev3_protocol::packet::{com_get_sub, com_hardware, input_device_sub, opcode, program_status};
use ev3_protocol::{BrickCommand, build_command};
use ev3_runtime::telemetry::assembler::{
    AssembledFrame, MAX_USABLE_GLOBAL_BYTES, assemble_frame, build_telemetry_frame,
    bytecode_budget_for, check_no_mode_conflict, global_budget_for, global_ref, global_ref_bytes,
    parse_frame, validate_row,
};
use ev3_runtime::telemetry::ev3_rows::{
    all_ev3_rows, chain_depth_row, motor_occupancy_row, sensor_occupancy_row,
};
use ev3_runtime::telemetry::port_state::is_readable_type;
use ev3_runtime::telemetry::{
    Lifetime, PortState, ProgramPresetSettings, Reading, RowRegistry, StaleSettings,
    TelemetryError, TelemetryRow, ThrottleSettings, TickThrottle, Tier, cadence_for,
    ev3_row_registry, port_state_of, typical_round_trip_ms,
};
use ev3_transports::Transport;
use support_telemetry::{HID, LIBUSB, RowExt, row};

fn rows_by_id() -> std::collections::HashMap<String, TelemetryRow> {
    all_ev3_rows()
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect()
}

fn ids(frame: &AssembledFrame) -> Vec<&str> {
    frame.placed.iter().map(|p| p.row.id.as_str()).collect()
}

// ── frame assembler — budgets ───────────────────────────────────────

#[test]
fn frame_assembler_budgets__caps_the_reply_at_what_fits_inside_max_msg_size() {
    assert_eq!(global_budget_for(LIBUSB), MAX_USABLE_GLOBAL_BYTES);
    assert_eq!(MAX_USABLE_GLOBAL_BYTES, 1019);
}

#[test]
fn frame_assembler_budgets__gives_the_request_7_fewer_bytes_than_the_packet_and_the_reply_5_fewer()
{
    assert_eq!(bytecode_budget_for(HID), 57);
    assert_eq!(global_budget_for(HID), 59);
}

#[test]
fn frame_assembler_budgets__refuses_a_row_whose_result_can_never_come_back_on_this_link() {
    let too_wide = row("wide").bytes(60, 4);
    assert!(matches!(
        validate_row(&too_wide, HID),
        Err(TelemetryError::Assembly(_))
    ));
    assert!(validate_row(&too_wide, LIBUSB).is_ok());
}

#[test]
fn frame_assembler_budgets__refuses_a_row_whose_byte_count_cannot_tile_its_own_alignment() {
    assert!(validate_row(&row("odd").bytes(3, 4), LIBUSB).is_err());
}

// ── frame assembler — layout ────────────────────────────────────────

#[test]
fn frame_assembler_layout__puts_32_bit_results_first_so_alignment_costs_no_padding() {
    let frame = assemble_frame(
        &[
            row("byte.a"),
            row("float.a").bytes(4, 4),
            row("byte.b"),
            row("float.b").bytes(4, 4),
        ],
        LIBUSB,
    )
    .unwrap();
    let layout: Vec<(&str, usize)> = frame
        .placed
        .iter()
        .map(|p| (p.row.id.as_str(), p.slot))
        .collect();
    assert_eq!(
        layout,
        [("float.a", 0), ("float.b", 4), ("byte.a", 8), ("byte.b", 9)]
    );
    assert_eq!(frame.global_bytes, 10);
}

#[test]
fn frame_assembler_layout__never_places_a_32_bit_result_on_an_offset_the_brick_would_reject() {
    let frame = assemble_frame(
        &[row("b0"), row("b1"), row("b2"), row("f").bytes(4, 4)],
        LIBUSB,
    )
    .unwrap();
    for placed in &frame.placed {
        assert_eq!(
            placed.slot % placed.row.result.alignment,
            0,
            "{} landed on {}",
            placed.row.id,
            placed.slot
        );
    }
}

#[test]
fn frame_assembler_layout__preserves_the_caller_order_within_one_alignment_class() {
    let frame = assemble_frame(&[row("first"), row("second"), row("third")], LIBUSB).unwrap();
    assert_eq!(ids(&frame), ["first", "second", "third"]);
}

#[test]
fn frame_assembler_layout__spends_a_second_byte_on_a_global_reference_past_offset_31() {
    assert_eq!(global_ref_bytes(31), 1);
    assert_eq!(global_ref_bytes(32), 2);
}

#[test]
fn frame_assembler_layout__keeps_every_slot_aligned_and_spends_no_padding_over_many_shapes() {
    let shapes = [(1, 1), (2, 2), (4, 4), (8, 4), (2, 1)];
    for seed in 0..40usize {
        let rows: Vec<TelemetryRow> = (0..6)
            .map(|i| {
                let (bytes, alignment) = shapes[(seed * 7 + i * 3) % shapes.len()];
                row(&format!("s{seed}.r{i}")).bytes(bytes, alignment)
            })
            .collect();
        let frame = assemble_frame(&rows, LIBUSB).unwrap();
        for placed in &frame.placed {
            assert_eq!(
                placed.slot % placed.row.result.alignment,
                0,
                "seed {seed}: {}",
                placed.row.id
            );
        }
        let sum: usize = frame.placed.iter().map(|p| p.row.result.bytes).sum();
        assert_eq!(frame.global_bytes, sum, "seed {seed}: padding spent");
    }
}

// ── frame assembler — truncation ────────────────────────────────────

fn wide_rows(n: usize) -> Vec<TelemetryRow> {
    (0..n).map(|i| row(&format!("r{i}")).bytes(4, 4)).collect()
}

#[test]
fn frame_assembler_truncation__defers_what_does_not_fit_instead_of_dropping_it() {
    let rows = wide_rows(20);
    let frame = assemble_frame(&rows, HID).unwrap();
    assert_eq!(frame.placed.len() + frame.deferred.len(), 20);
    assert!(frame.global_bytes <= global_budget_for(HID));
    assert!(frame.bytecode.len() <= bytecode_budget_for(HID));
    let deferred: Vec<&str> = frame.deferred.iter().map(|r| r.id.as_str()).collect();
    let expected: Vec<&str> = rows[frame.placed.len()..]
        .iter()
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(deferred, expected);
}

#[test]
fn frame_assembler_truncation__lets_the_declaration_bind_before_the_instruction_count() {
    let frame = assemble_frame(&wide_rows(30), HID).unwrap();
    assert!(!frame.deferred.is_empty());
    assert!(frame.bytecode.len() < bytecode_budget_for(HID));
}

#[test]
fn frame_assembler_truncation__takes_everything_when_the_link_is_wide() {
    let frame = assemble_frame(&wide_rows(20), LIBUSB).unwrap();
    assert!(frame.deferred.is_empty());
    assert_eq!(frame.placed.len(), 20);
}

#[test]
fn frame_assembler_truncation__refuses_rather_than_emitting_a_frame_that_can_carry_nothing() {
    let huge = row("huge").bytes(4, 4).pad(80);
    assert!(matches!(
        assemble_frame(&[huge], HID),
        Err(TelemetryError::Assembly(_))
    ));
}

// ── frame assembler — mode ownership ────────────────────────────────

#[test]
fn frame_assembler_mode_ownership__refuses_two_modes_of_one_port() {
    let rows = [
        row("p1.mode0").bytes(4, 4).port("1").mode(0),
        row("p1.mode2").bytes(4, 4).port("1").mode(2),
    ];
    assert!(check_no_mode_conflict(&rows).is_err());
}

#[test]
fn frame_assembler_mode_ownership__allows_several_reads_of_the_same_mode() {
    let rows = [
        row("p1.si").bytes(4, 4).port("1").mode(0),
        row("p1.raw").bytes(4, 4).port("1").mode(0),
        row("p1.pct").port("1").mode(0),
    ];
    assert!(check_no_mode_conflict(&rows).is_ok());
}

#[test]
fn frame_assembler_mode_ownership__allows_different_modes_on_different_ports() {
    let rows = [
        row("p1").bytes(4, 4).port("1").mode(0),
        row("p2").bytes(4, 4).port("2").mode(3),
    ];
    assert!(check_no_mode_conflict(&rows).is_ok());
}

// ── frame assembler — the wire and back ─────────────────────────────

#[test]
fn frame_assembler_the_wire_and_back__declares_the_globals_word_the_firmware_reads() {
    let frame = assemble_frame(&[row("f").bytes(4, 4)], LIBUSB).unwrap();
    let payload = build_telemetry_frame(&frame).unwrap();
    assert_eq!(payload[0], 4);
    assert_eq!(payload[1], 0);
    assert_eq!(payload[2..], frame.bytecode[..]);
}

#[test]
fn frame_assembler_the_wire_and_back__parses_each_row_from_the_recorded_slot() {
    let frame = assemble_frame(&[row("b"), row("f").bytes(4, 4)], LIBUSB).unwrap();
    let mut payload = vec![0u8; 5];
    payload[..4].copy_from_slice(&12.5f32.to_le_bytes());
    payload[4] = 99;
    let values = parse_frame(&frame, &payload, 1000);
    let get = |id: &str| {
        values
            .iter()
            .find(|v| v.row_id == id)
            .unwrap()
            .value
            .clone()
    };
    assert_eq!(get("f"), Reading::Number(12.5));
    assert_eq!(get("b"), Reading::Number(99.0));
}

#[test]
fn frame_assembler_the_wire_and_back__stamps_every_value_with_the_tick_it_came_from() {
    let frame = assemble_frame(&[row("f").bytes(4, 4)], LIBUSB).unwrap();
    assert_eq!(parse_frame(&frame, &[0; 4], 4242)[0].sampled_at, 4242);
}

#[test]
fn frame_assembler_the_wire_and_back__refuses_to_declare_more_globals_than_can_come_back() {
    let frame = AssembledFrame {
        bytecode: vec![0; 2],
        global_bytes: MAX_USABLE_GLOBAL_BYTES + 1,
        placed: Vec::new(),
        deferred: Vec::new(),
    };
    assert!(build_telemetry_frame(&frame).is_err());
}

// ── row registry ────────────────────────────────────────────────────

#[test]
fn row_registry__registers_the_whole_ev3_catalogue_and_lists_it_as_plain_data() {
    let listed = ev3_row_registry().list();
    assert_eq!(listed.len(), all_ev3_rows().len());
    let json = serde_json::to_value(&listed).unwrap();
    let find = |id: &str| {
        json.as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        find("ports.sensor.1.value"),
        serde_json::json!({"id": "ports.sensor.1.value", "tier": "sampled", "port": "1"})
    );
    assert_eq!(
        find("system.battery.voltage"),
        serde_json::json!({"id": "system.battery.voltage", "tier": "event", "unit": "V"})
    );
}

#[test]
fn row_registry__finds_a_row_by_id() {
    let registry = ev3_row_registry();
    assert_eq!(
        registry.get("ports.motor.A.tacho").unwrap().id,
        "ports.motor.A.tacho"
    );
    assert!(registry.get("ports.motor.E.tacho").is_none());
}

fn reg_row(id: &str) -> TelemetryRow {
    row(id).bytes(4, 4)
}

#[test]
fn row_registry__refuses_a_second_row_with_the_same_id() {
    let mut registry = RowRegistry::new();
    registry.register(reg_row("test.row")).unwrap();
    let error = registry.register(reg_row("test.row")).unwrap_err();
    assert!(error.to_string().contains("already registered"));
}

#[test]
fn row_registry__refuses_an_id_that_is_not_a_namespaced_path() {
    let mut registry = RowRegistry::new();
    for id in [
        "value",
        "ports..1",
        "ports.1.",
        ".ports.1",
        "ports 1.value",
        "",
    ] {
        let error = registry.register(reg_row(id)).expect_err(id);
        assert!(error.to_string().contains("id"), "{id}");
    }
}

#[test]
fn row_registry__refuses_a_result_that_cannot_come_back_on_the_hid_fallback() {
    let mut registry = RowRegistry::new();
    assert!(registry.register(row("test.fits").bytes(56, 4)).is_ok());
    assert!(registry.register(row("test.wide").bytes(60, 4)).is_err());
}

/// A codec whose bytecode is `bytes` long, one more past slot 31.
struct Sized(usize);
impl ev3_runtime::telemetry::row::RowCodec for Sized {
    fn emit(&self, slot: usize) -> Result<Vec<u8>, TelemetryError> {
        Ok(vec![0; if slot > 31 { self.0 + 1 } else { self.0 }])
    }
    fn parse(&self, _: &[u8], _: usize) -> ev3_runtime::telemetry::row::Parsed {
        ev3_runtime::telemetry::row::Parsed::value(Reading::Number(0.0))
    }
}

#[test]
fn row_registry__refuses_bytecode_that_cannot_go_out_on_the_hid_fallback_at_its_widest_reference() {
    let mut registry = RowRegistry::new();
    let mut short = reg_row("test.short");
    short.codec = std::sync::Arc::new(Sized(56));
    let mut long = reg_row("test.long");
    long.codec = std::sync::Arc::new(Sized(57));
    assert!(registry.register(short).is_ok());
    assert!(
        registry
            .register(long)
            .unwrap_err()
            .to_string()
            .contains("bytecode")
    );
}

#[test]
fn row_registry__refuses_a_repeating_row_whose_divider_is_not_a_whole_number_of_ticks() {
    // A divider is a whole number by type here; zero is the one value left to refuse.
    let mut registry = RowRegistry::new();
    let error = registry.register(reg_row("test.d0").every(0)).unwrap_err();
    assert!(error.to_string().contains("divider"));
}

#[test]
fn row_registry__leaves_nothing_registered_when_a_row_is_refused() {
    let mut registry = RowRegistry::new();
    assert!(registry.register(row("test.wide").bytes(60, 4)).is_err());
    assert!(registry.get("test.wide").is_none());
    assert!(registry.list().is_empty());
}

// ── EV3 row catalogue ───────────────────────────────────────────────

#[test]
fn ev3_row_catalogue__names_every_row_in_the_namespaced_format_once() {
    let ids: Vec<String> = all_ev3_rows().into_iter().map(|r| r.id).collect();
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
    assert!(ids.iter().any(|id| id == "ports.sensor.4.value"));
    assert!(ids.iter().any(|id| id == "ports.motor.D.occupancy"));
    // Every id passes registration, which checks the format.
    let mut registry = RowRegistry::new();
    for r in all_ev3_rows() {
        registry.register(r).unwrap();
    }
}

#[test]
fn ev3_row_catalogue__reads_a_sensor_value_with_input_readsi_not_the_one_byte_input_read() {
    let sensor = &rows_by_id()["ports.sensor.2.value"];
    assert_eq!(sensor.emit(0).unwrap()[0], opcode::INPUT_READ_SI);
    assert_eq!(opcode::INPUT_READ_SI, 0x9d);
}

#[test]
fn ev3_row_catalogue__numbers_motor_ports_16_19_for_occupancy_and_0_3_for_tacho() {
    let occupancy = motor_occupancy_row(2, 5, 0).emit(0).unwrap();
    let tacho = rows_by_id()["ports.motor.C.tacho"].emit(0).unwrap();
    assert_eq!(
        [occupancy[0], occupancy[1]],
        [opcode::INPUT_DEVICE, input_device_sub::GET_TYPEMODE]
    );
    assert_eq!(occupancy[3], 18);
    assert_eq!(tacho[2], 2);
}

#[test]
fn ev3_row_catalogue__reads_the_radios_and_the_pairing_count_with_com_get_on_the_right_hardware() {
    let rows = rows_by_id();
    let expect = |id: &str, subcode: u8, hardware: u8| {
        assert_eq!(
            rows[id].emit(5).unwrap(),
            [opcode::COM_GET, subcode, hardware, 0x65],
            "{id}"
        );
    };
    expect(
        "system.bluetooth.on",
        com_get_sub::GET_ON_OFF,
        com_hardware::BT,
    );
    expect(
        "system.bluetooth.visible",
        com_get_sub::GET_VISIBLE,
        com_hardware::BT,
    );
    expect(
        "system.bluetooth.peers",
        com_get_sub::FAVOUR_ITEMS,
        com_hardware::BT,
    );
    expect(
        "system.wifi.on",
        com_get_sub::GET_ON_OFF,
        com_hardware::WIFI,
    );
    expect(
        "system.wifi.present",
        com_get_sub::GET_PRESENT,
        com_hardware::WIFI,
    );
    assert_eq!(
        [
            com_get_sub::GET_ON_OFF,
            com_get_sub::GET_VISIBLE,
            com_get_sub::GET_PRESENT
        ],
        [1, 2, 15]
    );
}

#[test]
fn ev3_row_catalogue__parses_a_radio_flag_as_a_boolean_and_the_pairing_count_as_a_number() {
    let rows = rows_by_id();
    let payload = [1u8, 0, 3];
    assert_eq!(
        rows["system.bluetooth.on"].parse(&payload, 0, 1).value,
        Reading::Flag(true)
    );
    assert_eq!(
        rows["system.wifi.on"].parse(&payload, 1, 1).value,
        Reading::Flag(false)
    );
    assert_eq!(
        rows["system.bluetooth.peers"].parse(&payload, 2, 1).value,
        Reading::Number(3.0)
    );
}

#[test]
fn ev3_row_catalogue__never_asks_get_on_off_of_the_usb_hardware() {
    let forbidden = [opcode::COM_GET, com_get_sub::GET_ON_OFF, com_hardware::USB];
    for r in all_ev3_rows() {
        let bytes = r.emit(0).unwrap();
        assert!(
            !bytes.windows(3).any(|w| w == forbidden),
            "{} asks GET_ON_OFF of USB",
            r.id
        );
    }
}

#[test]
fn ev3_row_catalogue__keeps_the_mode_an_occupancy_row_reads_beside_the_type_code() {
    let parsed = sensor_occupancy_row(0, 5, 0).parse(&[0, 0, 30, 2], 2, 1000);
    assert_eq!(parsed.value, Reading::Number(30.0));
    assert_eq!(parsed.mode, Some(2));
}

#[test]
fn ev3_row_catalogue__emits_the_masters_own_port_rows_exactly_as_before_the_chain_rows_existed() {
    let rows = rows_by_id();
    let bytes = |id: &str| rows[id].emit(4).unwrap();
    assert_eq!(
        bytes("ports.sensor.1.value"),
        [opcode::INPUT_READ_SI, 0, 0, 0, 0, 0x64]
    );
    assert_eq!(
        bytes("ports.sensor.3.occupancy"),
        [
            opcode::INPUT_DEVICE,
            input_device_sub::GET_TYPEMODE,
            0,
            2,
            0x64,
            0x65
        ]
    );
    assert_eq!(
        bytes("ports.motor.B.occupancy"),
        [
            opcode::INPUT_DEVICE,
            input_device_sub::GET_TYPEMODE,
            0,
            17,
            0x64,
            0x65
        ]
    );
    assert_eq!(
        bytes("ports.motor.B.tacho"),
        [opcode::OUTPUT_GET_COUNT, 0, 1, 0x64]
    );
}

#[test]
fn ev3_row_catalogue__cuts_the_brick_name_at_its_terminator() {
    // The firmware never clears a direct command's globals: an earlier reply's leftovers follow
    // the terminator, and must not reach the name.
    let mut payload = b"AAA\0WIFINET".to_vec();
    payload.resize(16, b'x');
    assert_eq!(
        rows_by_id()["system.brickName"].parse(&payload, 0, 1).value,
        Reading::Text("AAA".into())
    );
}

// ── daisy-chain rows ────────────────────────────────────────────────

const TYPE_NONE: u8 = 126;
const TYPE_UNKNOWN: u8 = 125;
const COLOR: u8 = 29;
const LARGE_MOTOR: u8 = 7;

fn depth_of(devices: &[(usize, u8)]) -> Reading {
    let mut list = vec![TYPE_NONE; 33];
    for &(index, kind) in devices {
        list[index] = kind;
    }
    list[32] = 1;
    chain_depth_row(5).parse(&list, 0, 1).value
}

#[test]
fn daisy_chain_rows__reads_the_whole_chain_with_one_input_device_list_of_32_entries() {
    let r = chain_depth_row(5);
    assert_eq!(r.id, "chain.depth");
    assert_eq!(r.tier, Tier::Event);
    assert_eq!((r.result.bytes, r.result.alignment), (33, 1));
    let mut expected = vec![opcode::INPUT_DEVICE_LIST, 0x81, 32];
    expected.extend(global_ref(0).unwrap());
    expected.extend(global_ref(32).unwrap());
    assert_eq!(r.emit(0).unwrap(), expected);
}

#[test]
fn daisy_chain_rows__takes_the_depth_from_the_deepest_layer_with_a_device_sensor_or_motor() {
    assert_eq!(depth_of(&[]), Reading::Number(0.0), "nothing anywhere");
    assert_eq!(
        depth_of(&[(0, COLOR), (16, LARGE_MOTOR)]),
        Reading::Number(0.0),
        "the master's own ports"
    );
    assert_eq!(depth_of(&[(4, COLOR)]), Reading::Number(1.0));
    assert_eq!(
        depth_of(&[(10, COLOR)]),
        Reading::Number(2.0),
        "layer 2 with layer 1 empty"
    );
    assert_eq!(
        depth_of(&[(25, LARGE_MOTOR)]),
        Reading::Number(2.0),
        "a motor alone on layer 2"
    );
    assert_eq!(depth_of(&[(31, LARGE_MOTOR)]), Reading::Number(3.0));
    assert_eq!(
        depth_of(&[(4, TYPE_UNKNOWN)]),
        Reading::Number(1.0),
        "identifying is there"
    );
}

#[test]
fn daisy_chain_rows__reads_a_members_sensor_port_by_layer_and_port_with_the_port_named_by_both() {
    let rows = rows_by_id();
    let occupancy = &rows["chain.2.sensor.3.occupancy"];
    let value = &rows["chain.2.sensor.3.value"];
    assert_eq!(occupancy.port.as_deref(), Some("2:3"));
    assert_eq!(occupancy.layer, Some(2));
    assert!(occupancy.reports_occupancy);
    assert_eq!(
        occupancy.emit(4).unwrap(),
        [
            opcode::INPUT_DEVICE,
            input_device_sub::GET_TYPEMODE,
            2,
            2,
            0x64,
            0x65
        ]
    );
    assert_eq!(value.port.as_deref(), Some("2:3"));
    assert_eq!(value.layer, Some(2));
    assert_eq!(
        value.emit(4).unwrap(),
        [opcode::INPUT_READ_SI, 2, 2, 0, 0, 0x64]
    );
}

#[test]
fn daisy_chain_rows__reads_a_members_motor_type_and_never_its_tacho() {
    let rows = rows_by_id();
    let occupancy = &rows["chain.1.motor.A.occupancy"];
    assert_eq!(occupancy.port.as_deref(), Some("1:A"));
    assert_eq!(
        occupancy.emit(4).unwrap(),
        [
            opcode::INPUT_DEVICE,
            input_device_sub::GET_TYPEMODE,
            1,
            16,
            0x64,
            0x65
        ]
    );
    assert!(rows.keys().all(|id| !(id.starts_with("chain.")
        && id.contains(".motor.")
        && !id.ends_with(".occupancy"))));
}

#[test]
fn daisy_chain_rows__offers_every_member_layer_and_puts_the_depth_row_last() {
    let ids: Vec<String> = all_ev3_rows().into_iter().map(|r| r.id).collect();
    for layer in 1..=3 {
        for port in ["1", "2", "3", "4"] {
            assert!(ids.contains(&format!("chain.{layer}.sensor.{port}.occupancy")));
            assert!(ids.contains(&format!("chain.{layer}.sensor.{port}.value")));
        }
        for port in ["A", "B", "C", "D"] {
            assert!(ids.contains(&format!("chain.{layer}.motor.{port}.occupancy")));
        }
    }
    assert_eq!(ids.last().unwrap(), "chain.depth");
    let at = |id: &str| ids.iter().position(|x| x == id).unwrap();
    assert!(at("chain.1.sensor.1.value") < at("ports.motor.A.tacho"));
}

#[test]
fn daisy_chain_rows__lists_a_members_rows_with_their_layer_and_reads_its_sensor_in_the_mode_asked()
{
    let registry = ev3_row_registry();
    let listed = serde_json::to_value(registry.list()).unwrap();
    let member = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "chain.1.sensor.1.value")
        .unwrap();
    assert_eq!(
        member,
        &serde_json::json!({"id": "chain.1.sensor.1.value", "tier": "sampled", "port": "1:1", "layer": 1})
    );
    assert!(registry.mode_ports().contains("1:1"));
    let in_mode = registry.in_mode("chain.1.sensor.1.value", 2).unwrap();
    assert_eq!(
        in_mode.emit(4).unwrap(),
        [opcode::INPUT_READ_SI, 1, 0, 0, 2, 0x64]
    );
}

// ── port state ──────────────────────────────────────────────────────

#[test]
fn port_state__names_the_five_states_by_the_firmwares_codes() {
    assert_eq!(port_state_of(Some(126)), PortState::Empty);
    assert_eq!(port_state_of(Some(125)), PortState::Identifying);
    assert_eq!(port_state_of(Some(127)), PortState::Error);
    assert_eq!(port_state_of(Some(124)), PortState::Terminal);
    assert_eq!(port_state_of(Some(30)), PortState::Known);
    assert_eq!(port_state_of(Some(7)), PortState::Known);
}

#[test]
fn port_state__says_a_port_nothing_has_reported_on_yet_is_unreported_not_empty() {
    assert_eq!(port_state_of(None), PortState::Unreported);
}

#[test]
fn port_state__shows_any_other_code_at_or_above_124_as_not_readable() {
    assert_eq!(port_state_of(Some(128)), PortState::NotReadable);
    assert_eq!(port_state_of(Some(200)), PortState::NotReadable);
}

#[test]
fn port_state__treats_an_unlisted_iic_device_100_as_a_known_device() {
    assert_eq!(port_state_of(Some(100)), PortState::Known);
}

#[test]
fn port_state__reads_a_value_only_from_a_known_port() {
    for code in [0, 7, 30, 33, 100, 123] {
        assert!(is_readable_type(code), "{code}");
    }
    for code in [124, 125, 126, 127, 128, 200] {
        assert!(!is_readable_type(code), "{code}");
    }
}

// ── the program row ─────────────────────────────────────────────────

#[test]
fn the_program_row__is_an_event_row_of_one_byte_that_every_read_brick_carries() {
    let registry = ev3_row_registry();
    let r = registry.get("program.user.running").unwrap();
    assert_eq!(r.tier, Tier::Event);
    assert_eq!((r.result.bytes, r.result.alignment), (1, 1));
}

#[test]
fn the_program_row__asks_what_the_program_status_command_asks_into_its_own_global_slot() {
    let status = build_command(&BrickCommand::ProgramStatus).unwrap();
    let registry = ev3_row_registry();
    assert_eq!(
        registry
            .get("program.user.running")
            .unwrap()
            .emit(0)
            .unwrap(),
        status.payload[2..]
    );
}

#[test]
fn the_program_row__reads_running_only_from_running_and_anything_else_as_not_running() {
    let registry = ev3_row_registry();
    let r = registry.get("program.user.running").unwrap();
    let read = |status: u8| r.parse(&[status], 0, 5).value;
    assert_eq!(read(program_status::RUNNING), Reading::Flag(true));
    assert_eq!(read(program_status::STOPPED), Reading::Flag(false));
    assert_eq!(read(0x20), Reading::Flag(false));
}

// ── tick throttle ───────────────────────────────────────────────────

const SETTINGS: ThrottleSettings = ThrottleSettings {
    enabled: true,
    window_size: 5,
    tail_factor: 3.0,
    step: 1.5,
    max_slowdown: 4.0,
    calm_windows: 2,
};

/// A link whose usual round trip is 10 ms: the limit is 30 ms.
fn throttle(settings: ThrottleSettings) -> TickThrottle {
    TickThrottle::new(settings, 10.0).unwrap()
}

/// Feeds round trips; returns the factor after each one that changed it.
fn feed(t: &mut TickThrottle, trips: &[f64]) -> Vec<f64> {
    let mut changed = Vec::new();
    for &ms in trips {
        if t.observe(ms) {
            changed.push(t.factor());
        }
    }
    changed
}

fn window(ms: f64, n: usize) -> Vec<f64> {
    vec![ms; n]
}

fn windows(parts: &[(f64, usize)]) -> Vec<f64> {
    parts.iter().flat_map(|&(ms, n)| window(ms, n)).collect()
}

#[test]
fn tick_throttle__leaves_a_quiet_brick_alone() {
    let mut t = throttle(SETTINGS);
    assert!(feed(&mut t, &windows(&[(8.0, 5), (12.0, 5), (29.0, 5)])).is_empty());
    assert_eq!(t.factor(), 1.0);
}

#[test]
fn tick_throttle__slows_a_step_at_the_end_of_a_window_whose_p95_is_over_the_limit_not_before() {
    let mut t = throttle(SETTINGS);
    assert!(
        feed(&mut t, &[8.0, 8.0, 8.0, 40.0]).is_empty(),
        "mid-window: nothing decided"
    );
    assert_eq!(feed(&mut t, &[40.0]), [1.5]);
}

#[test]
fn tick_throttle__does_not_slow_for_one_spike_in_a_window_only_for_a_tail() {
    let mut t = throttle(ThrottleSettings {
        window_size: 20,
        ..SETTINGS
    });
    assert!(
        feed(&mut t, &windows(&[(6.0, 19), (200.0, 1)])).is_empty(),
        "one stall in twenty"
    );
    assert_eq!(
        feed(&mut t, &windows(&[(6.0, 18), (37.0, 2)])),
        [1.5],
        "two are: Port View"
    );
}

#[test]
fn tick_throttle__keeps_slowing_a_step_a_window_up_to_max_slowdown_and_no_further() {
    let mut t = throttle(SETTINGS);
    assert_eq!(feed(&mut t, &window(50.0, 25)), [1.5, 2.25, 3.375, 4.0]);
    assert_eq!(t.factor(), 4.0);
}

#[test]
fn tick_throttle__speeds_back_a_step_after_calm_windows_never_past_the_plan() {
    let mut t = throttle(SETTINGS);
    feed(&mut t, &window(50.0, 10));
    assert_eq!(t.factor(), 2.25);
    assert!(
        feed(&mut t, &window(8.0, 5)).is_empty(),
        "one calm window is not enough"
    );
    assert_eq!(feed(&mut t, &window(8.0, 5)), [1.5]);
    assert_eq!(feed(&mut t, &window(8.0, 10)), [1.0]);
    assert!(
        feed(&mut t, &window(8.0, 10)).is_empty(),
        "not faster than the plan"
    );
}

#[test]
fn tick_throttle__comes_back_down_from_the_ceiling_to_exactly_the_plan() {
    let mut t = throttle(SETTINGS);
    feed(&mut t, &window(50.0, 25));
    assert_eq!(t.factor(), 4.0);
    let steps = feed(&mut t, &window(8.0, 40));
    assert_eq!(*steps.last().unwrap(), 1.0, "came down as {steps:?}");
}

#[test]
fn tick_throttle__starts_counting_calm_windows_afresh_after_a_slow_one() {
    let mut t = throttle(SETTINGS);
    feed(&mut t, &window(50.0, 5));
    assert_eq!(
        feed(&mut t, &windows(&[(8.0, 5), (50.0, 5), (8.0, 5)])),
        [2.25]
    );
    assert_eq!(t.factor(), 2.25);
}

#[test]
fn tick_throttle__when_disabled_never_moves_the_tick_but_still_reports_the_numbers() {
    let mut t = throttle(ThrottleSettings {
        enabled: false,
        ..SETTINGS
    });
    assert!(feed(&mut t, &window(50.0, 10)).is_empty());
    let state = t.state();
    assert_eq!(
        (
            state.factor,
            state.limit_ms,
            state.p95_ms,
            state.stalls,
            state.window_samples
        ),
        (1.0, 30.0, Some(50.0), 5, 0)
    );
}

#[test]
fn tick_throttle__reports_the_last_windows_p95_its_stalls_and_how_full_the_next_is() {
    let mut t = throttle(SETTINGS);
    feed(&mut t, &[8.0, 30.0, 31.0, 40.0, 10.0, 12.0, 13.0]);
    let state = t.state();
    assert_eq!(
        (
            state.factor,
            state.limit_ms,
            state.p95_ms,
            state.stalls,
            state.window_samples
        ),
        (1.5, 30.0, Some(40.0), 2, 2)
    );
}

#[test]
fn tick_throttle__takes_new_settings_at_once_a_lower_ceiling_pulls_the_tick_down_to_it() {
    let mut t = throttle(SETTINGS);
    feed(&mut t, &window(50.0, 15));
    assert_eq!(t.factor(), 3.375);
    assert!(
        t.configure(ThrottleSettings {
            max_slowdown: 2.0,
            ..SETTINGS
        })
        .unwrap()
    );
    assert_eq!(t.factor(), 2.0);
    assert!(
        t.configure(ThrottleSettings {
            enabled: false,
            ..SETTINGS
        })
        .unwrap()
    );
    assert_eq!(t.factor(), 1.0);
    let error = t
        .configure(ThrottleSettings {
            step: 1.0,
            ..SETTINGS
        })
        .unwrap_err();
    assert!(error.to_string().contains("step"));
}

#[test]
fn tick_throttle__starts_afresh_under_new_settings() {
    let mut t = throttle(ThrottleSettings {
        window_size: 20,
        ..SETTINGS
    });
    feed(&mut t, &window(8.0, 20));
    feed(&mut t, &windows(&[(8.0, 18), (40.0, 1)]));
    t.configure(ThrottleSettings {
        window_size: 5,
        tail_factor: 6.0,
        ..SETTINGS
    })
    .unwrap();
    let state = t.state();
    assert_eq!(
        (
            state.factor,
            state.limit_ms,
            state.p95_ms,
            state.stalls,
            state.window_samples
        ),
        (1.0, 60.0, None, 0, 0)
    );
    assert!(
        feed(&mut t, &window(40.0, 5)).is_empty(),
        "five frames under the new rules, within 60 ms"
    );
}

#[test]
fn tick_throttle__knows_each_links_usual_round_trip_and_assumes_the_slowest_for_one_it_does_not_know()
 {
    assert_eq!(typical_round_trip_ms(Some(Transport::Usb)), 10.0);
    assert_eq!(typical_round_trip_ms(Some(Transport::Tcp)), 60.0);
    assert_eq!(typical_round_trip_ms(Some(Transport::Bt)), 130.0);
    assert_eq!(typical_round_trip_ms(Some(Transport::Mock)), 10.0);
    assert_eq!(typical_round_trip_ms(None), 130.0);
}

// ── telemetry cadence ───────────────────────────────────────────────

#[test]
fn telemetry_cadence__gives_bluetooth_the_slowest_tick_because_it_has_the_least_to_give() {
    let bt = cadence_for(Some(Transport::Bt));
    for other in [Transport::Usb, Transport::Tcp] {
        assert!(bt.foreground_ms > cadence_for(Some(other)).foreground_ms);
        assert!(bt.floor_ms > cadence_for(Some(other)).floor_ms);
    }
    assert_eq!((bt.foreground_ms, bt.floor_ms), (500, 250));
    assert_eq!(
        (
            cadence_for(Some(Transport::Usb)).foreground_ms,
            cadence_for(Some(Transport::Usb)).floor_ms
        ),
        (100, 50)
    );
    assert_eq!(
        (
            cadence_for(Some(Transport::Tcp)).foreground_ms,
            cadence_for(Some(Transport::Tcp)).floor_ms
        ),
        (200, 100)
    );
}

#[test]
fn telemetry_cadence__never_lets_a_floor_sit_above_its_own_target() {
    for t in [
        Transport::Usb,
        Transport::Tcp,
        Transport::Bt,
        Transport::Mock,
    ] {
        let c = cadence_for(Some(t));
        assert!(c.floor_ms <= c.foreground_ms);
    }
}

#[test]
fn telemetry_cadence__treats_an_unknown_transport_as_the_slowest_one_measured() {
    assert_eq!(cadence_for(None), cadence_for(Some(Transport::Bt)));
}

// ── telemetry settings ──────────────────────────────────────────────

#[test]
fn telemetry_settings__take_their_defaults_from_the_settings_spec() {
    let stale = StaleSettings::default();
    assert_eq!((stale.stale_factor, stale.stale_timeout_ms), (3.0, 10000.0));
    let t = ThrottleSettings::default();
    assert_eq!(
        t,
        ThrottleSettings {
            enabled: true,
            window_size: 20,
            tail_factor: 3.0,
            step: 1.5,
            max_slowdown: 4.0,
            calm_windows: 3
        }
    );
    assert_eq!(
        ProgramPresetSettings::default().program_running_tick_ms,
        200.0
    );
}

#[test]
fn telemetry_settings__refuse_a_value_out_of_range_naming_it() {
    assert!(
        StaleSettings {
            stale_factor: 0.5,
            stale_timeout_ms: 0.0
        }
        .check()
        .unwrap_err()
        .to_string()
        .contains("staleFactor")
    );
    assert!(
        StaleSettings {
            stale_factor: 1.0,
            stale_timeout_ms: -1.0
        }
        .check()
        .unwrap_err()
        .to_string()
        .contains("staleTimeoutMs")
    );
    assert!(
        ThrottleSettings {
            window_size: 4,
            ..SETTINGS
        }
        .check()
        .unwrap_err()
        .to_string()
        .contains("windowSize")
    );
    assert!(
        ThrottleSettings {
            calm_windows: 0,
            ..SETTINGS
        }
        .check()
        .unwrap_err()
        .to_string()
        .contains("calmWindows")
    );
    assert!(
        ProgramPresetSettings {
            program_running_tick_ms: -1.0
        }
        .check()
        .is_err()
    );
    assert!(
        ProgramPresetSettings {
            program_running_tick_ms: 0.0
        }
        .check()
        .is_ok(),
        "0 turns it off"
    );
}

#[test]
fn lifetimes__give_a_row_a_new_lifetime_without_changing_what_it_reads() {
    let original = row("a");
    let slowed = original.with_lifetime(Lifetime::Repeating { divider: 4 });
    assert_eq!(slowed.lifetime, Lifetime::Repeating { divider: 4 });
    assert_eq!(slowed.emit(3).unwrap(), original.emit(3).unwrap());
    assert_eq!(original.lifetime, Lifetime::Repeating { divider: 1 });
}
