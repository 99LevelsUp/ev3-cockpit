//! Ports of `src/__tests__/ev3Protocol.test.ts`, one Rust test per TypeScript `it`. A test is
//! named `<describe>__<it>` in snake case. Expected bytes are the TypeScript's.

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::bytecode::*;
use ev3_protocol::packet::{command, reply, system, system_status};
use ev3_protocol::responses::ButtonsState;
use ev3_protocol::responses::parse_listing;
use ev3_protocol::{
    BrickCommand, BrickResponse, Ev3Packet, build_command, decode_ev3_packet, encode_ev3_packet,
    extract_length_prefixed_packet, parse_response,
};

fn make_reply(packet_type: u8, payload: &[u8]) -> Ev3Packet<'_> {
    Ev3Packet {
        message_counter: 1,
        packet_type,
        payload,
    }
}

// ── Bytecode encoding ───────────────────────────────────────────────

#[test]
fn bytecode_integer_encoding__uint16le_encodes_0x1234() {
    assert_eq!(uint16le(0x1234), [0x34, 0x12]);
}

#[test]
fn bytecode_integer_encoding__uint32le_encodes_0xdeadbeef() {
    assert_eq!(uint32le(0xdead_beef), [0xef, 0xbe, 0xad, 0xde]);
}

#[test]
fn bytecode_integer_encoding__read_uint16le_round_trips() {
    assert_eq!(read_uint16le(&uint16le(42), 0).unwrap(), 42);
}

#[test]
fn bytecode_integer_encoding__read_uint32le_round_trips() {
    assert_eq!(read_uint32le(&uint32le(123_456), 0).unwrap(), 123_456);
}

#[test]
fn bytecode_integer_encoding__read_int32le_reads_negative_values() {
    assert_eq!(read_int32le(&(-500i32).to_le_bytes(), 0).unwrap(), -500);
}

#[test]
fn bytecode_integer_encoding__read_float32le_reads_floating_point() {
    let val = read_float32le(&3.25f32.to_le_bytes(), 0).unwrap();
    assert!((val - 3.25).abs() < 0.01);
}

#[test]
fn bytecode_integer_encoding__throws_on_insufficient_bytes() {
    assert!(read_uint32le(&[0; 2], 0).is_err());
    assert!(read_float32le(&[0; 3], 0).is_err());
}

#[test]
fn bytecode_concat_bytes__concatenates_multiple_arrays() {
    assert_eq!(
        concat_bytes(&[&[1, 2], &[3], &[4, 5, 6]]),
        [1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn bytecode_concat_bytes__handles_empty_arrays() {
    assert_eq!(concat_bytes(&[&[1], &[], &[2]]), [1, 2]);
}

#[test]
fn bytecode_lc_encodings__lc0_encodes_small_positive_values() {
    assert_eq!(lc0(5).unwrap(), [5]);
    assert_eq!(lc0(0).unwrap(), [0]);
    assert_eq!(lc0(31).unwrap(), [31]);
}

#[test]
fn bytecode_lc_encodings__lc0_throws_on_out_of_range_values() {
    assert!(lc0(32).is_err());
    assert!(lc0(-32).is_err());
    // The TypeScript's third case, `lc0(1.5)`, cannot be written: the argument is an integer.
}

#[test]
fn bytecode_lc_encodings__lc1_encodes_medium_values() {
    assert_eq!(lc1(100).unwrap(), [0x81, 100]);
    assert_eq!(lc1(-1).unwrap(), [0x81, 0xff]);
}

#[test]
fn bytecode_lc_encodings__lc1_throws_on_out_of_range() {
    assert!(lc1(128).is_err());
    assert!(lc1(-129).is_err());
}

#[test]
fn bytecode_lc_encodings__lc2_encodes_large_values() {
    let result = lc2(1000).unwrap();
    assert_eq!(result[0], 0x82);
    assert_eq!(i16::from_le_bytes([result[1], result[2]]), 1000);
}

#[test]
fn bytecode_lc_encodings__lc2_encodes_negative_values() {
    let result = lc2(-1000).unwrap();
    assert_eq!(i16::from_le_bytes([result[1], result[2]]), -1000);
}

#[test]
fn bytecode_string_encoding__c_string_produces_null_terminated_utf8() {
    assert_eq!(c_string("abc"), [0x61, 0x62, 0x63, 0x00]);
}

#[test]
fn bytecode_string_encoding__lcs_prepends_0x84_prefix() {
    let result = lcs("hi");
    assert_eq!(result[0], 0x84);
    assert_eq!(result[result.len() - 1], 0x00);
}

#[test]
fn bytecode_gv_encodings__gv0_encodes_small_offsets() {
    assert_eq!(gv0(0).unwrap(), [0x60]);
    assert_eq!(gv0(5).unwrap(), [0x65]);
    assert_eq!(gv0(31).unwrap(), [0x7f]);
}

#[test]
fn bytecode_gv_encodings__gv0_throws_on_out_of_range() {
    assert!(gv0(32).is_err());
    // `gv0(-1)` cannot be written: the offset is unsigned.
}

#[test]
fn bytecode_gv_encodings__gv1_encodes_larger_offsets() {
    assert_eq!(gv1(32).unwrap(), [0xe1, 32]);
    assert_eq!(gv1(255).unwrap(), [0xe1, 255]);
}

#[test]
fn bytecode_gv_encodings__gv1_throws_on_out_of_range() {
    assert!(gv1(256).is_err());
    // `gv1(-1)` cannot be written: the offset is unsigned.
}

#[test]
fn bytecode_read_fixed_c_string__reads_null_terminated_string_from_buffer() {
    assert_eq!(
        read_fixed_c_string(&[0x41, 0x42, 0x00, 0xff, 0xff], 0, 5),
        "AB"
    );
}

#[test]
fn bytecode_read_fixed_c_string__handles_no_null_terminator() {
    assert_eq!(read_fixed_c_string(&[0x41, 0x42, 0x43], 0, 3), "ABC");
}

#[test]
fn bytecode_read_fixed_c_string__returns_empty_for_offset_beyond_buffer() {
    assert_eq!(read_fixed_c_string(&[1, 2], 10, 5), "");
}

// ── Packet framing ──────────────────────────────────────────────────

#[test]
fn packet_round_trip__round_trips_a_direct_command() {
    let payload = [0x81, 0x02, 0x60];
    let encoded = encode_ev3_packet(42, command::DIRECT_COMMAND_REPLY, &payload).unwrap();
    let decoded = decode_ev3_packet(&encoded).unwrap();

    assert_eq!(decoded.message_counter, 42);
    assert_eq!(decoded.packet_type, command::DIRECT_COMMAND_REPLY);
    assert_eq!(decoded.payload, payload);
}

#[test]
fn packet_round_trip__round_trips_a_packet_with_no_payload() {
    let encoded = encode_ev3_packet(1, command::DIRECT_COMMAND_NO_REPLY, &[]).unwrap();
    let decoded = decode_ev3_packet(&encoded).unwrap();

    assert_eq!(decoded.message_counter, 1);
    assert_eq!(decoded.packet_type, command::DIRECT_COMMAND_NO_REPLY);
    assert!(decoded.payload.is_empty());
}

#[test]
fn packet_round_trip__wraps_message_counter_to_16_bits() {
    let encoded = encode_ev3_packet(0x10042, reply::DIRECT_REPLY, &[]).unwrap();
    assert_eq!(decode_ev3_packet(&encoded).unwrap().message_counter, 0x0042);
}

#[test]
fn packet_round_trip__throws_on_too_short_packet() {
    assert!(decode_ev3_packet(&[1, 2, 3]).is_err());
}

#[test]
fn packet_round_trip__throws_on_length_mismatch() {
    let bad = [0xff, 0x00, 0x01, 0x00, 0x02];
    assert!(decode_ev3_packet(&bad).is_err());
}

#[test]
fn packet_extract_length_prefixed__extracts_a_complete_packet() {
    let pkt = encode_ev3_packet(1, 0x00, &[0xaa]).unwrap();
    let buf = concat_bytes(&[&pkt, &[0xbb, 0xcc]]);

    let (packet, remaining) = extract_length_prefixed_packet(&buf).unwrap();
    assert_eq!(packet, pkt);
    assert_eq!(remaining, [0xbb, 0xcc]);
}

#[test]
fn packet_extract_length_prefixed__returns_null_for_incomplete_data() {
    assert!(extract_length_prefixed_packet(&[0x10, 0x00]).is_none());
}

#[test]
fn packet_extract_length_prefixed__returns_null_for_empty_buffer() {
    assert!(extract_length_prefixed_packet(&[]).is_none());
}

// ── Command builder ─────────────────────────────────────────────────

fn build(cmd: BrickCommand) -> ev3_protocol::EncodedCommand {
    build_command(&cmd).unwrap()
}

#[test]
fn commands_build_command__builds_battery_command_as_direct_command_with_reply() {
    let result = build(BrickCommand::Battery);
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    assert!(!result.payload.is_empty());
}

#[test]
fn commands_build_command__builds_ports_command_as_direct_command_with_reply() {
    let result = build(BrickCommand::Ports);
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    // Global allocation header should be 48 bytes
    assert_eq!(read_uint16le(&result.payload, 0).unwrap(), 48);
}

#[test]
fn commands_build_command__builds_buttons_command_as_direct_command_with_reply() {
    let result = build(BrickCommand::Buttons);
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    assert_eq!(read_uint16le(&result.payload, 0).unwrap(), 6);
}

#[test]
fn commands_build_command__asks_the_brick_for_its_own_name_not_the_os_version() {
    let result = build(BrickCommand::Info);
    assert_eq!(result.payload[2], 0xd3, "expected opCOM_GET");
    assert_eq!(result.payload[3], 0x0d, "expected GET_BRICKNAME subcode");
}

#[test]
fn commands_build_command__names_the_radio_before_the_flag_when_switching_bluetooth() {
    let result = build(BrickCommand::SetBluetooth { on: true });
    assert_eq!(result.payload[2], 0xd4, "expected opCOM_SET");
    assert_eq!(result.payload[3], 0x01, "expected SET_ON_OFF subcode");
    assert_eq!(
        result.payload[4], 0x02,
        "expected HW_BT as the first argument"
    );
    assert_eq!(
        result.payload[5], 0x01,
        "expected the on flag as the second argument"
    );
}

#[test]
fn commands_build_command__switches_visibility_through_its_own_subcode_same_argument_shape() {
    let result = build(BrickCommand::SetBluetoothVisible { visible: false });
    assert_eq!(result.payload[2], 0xd4, "expected opCOM_SET");
    assert_eq!(result.payload[3], 0x02, "expected SET_VISIBLE subcode");
    assert_eq!(
        result.payload[4], 0x02,
        "expected HW_BT as the first argument"
    );
    assert_eq!(
        result.payload[5], 0x00,
        "expected the cleared flag as the second argument"
    );
}

#[test]
fn commands_build_command__asks_for_a_reply_when_writing_a_setting_though_it_reads_nothing_back() {
    for cmd in [
        BrickCommand::SetName {
            name: "AAA2".into(),
        },
        BrickCommand::SetBluetooth { on: false },
        BrickCommand::SetBluetoothVisible { visible: true },
    ] {
        let kind = cmd.kind();
        assert_eq!(
            build(cmd).packet_type,
            command::DIRECT_COMMAND_REPLY,
            "{kind} must expect a reply"
        );
    }
}

#[test]
fn commands_build_command__sends_the_new_name_as_a_string_parameter() {
    let result = build(BrickCommand::SetName {
        name: "AAA2".into(),
    });
    assert_eq!(result.payload[2], 0xd4, "expected opCOM_SET");
    assert_eq!(result.payload[3], 0x08, "expected SET_BRICKNAME subcode");
    assert_eq!(result.payload[4], 0x84, "expected an LCS string marker");
    assert_eq!(
        &result.payload[5..9],
        b"AAA2",
        "expected the name itself to follow"
    );
}

#[test]
fn commands_build_command__refuses_a_name_the_firmware_would_reject_in_silence() {
    let long = BrickCommand::SetName {
        name: "x".repeat(119),
    };
    assert!(build_command(&long).is_err());
    let fits = BrickCommand::SetName {
        name: "x".repeat(118),
    };
    assert!(build_command(&fits).is_ok());
}

#[test]
fn commands_build_command__refuses_a_character_outside_the_firmwares_name_set() {
    for name in ["my brick", "Kostička", "a.b", ""] {
        let cmd = BrickCommand::SetName { name: name.into() };
        assert!(build_command(&cmd).is_err(), "expected \"{name}\" refused");
    }
    let ok = BrickCommand::SetName {
        name: "Robot_2-B".into(),
    };
    assert!(build_command(&ok).is_ok());
}

#[test]
fn commands_build_command__counts_the_bluetooth_peers_with_favour_items_on_the_bluetooth_hardware()
{
    let result = build(BrickCommand::BluetoothPeerCount);
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    assert_eq!(
        result.payload,
        [
            0x01, 0x00, // one global byte
            0xd3, 0x0a, // opCOM_GET, FAVOUR_ITEMS
            0x02, // HW_BT
            0x60, // GV0(0): the count
        ]
    );
}

#[test]
fn commands_build_command__reads_one_bluetooth_peer_by_index_asking_for_the_longest_name_a_direct_command_can_hold()
 {
    let result = build(BrickCommand::BluetoothPeer { index: 1 });
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    assert_eq!(
        result.payload,
        [
            130, 0x00, // 127 name bytes + paired + connected + type
            0xd3, 0x0b, // opCOM_GET, FAVOUR_ITEM
            0x02, // HW_BT
            0x01, // the index
            0x81, 127,  // LC1(127): the name length
            0x60, // GV0(0): the name
            0xe1, 127, // GV1(127): paired
            0xe1, 128, // GV1(128): connected
            0xe1, 129, // GV1(129): type
        ]
    );
}

#[test]
fn commands_build_command__removes_a_bluetooth_peer_with_op_com_remove_the_bluetooth_hardware_and_the_name_as_a_string()
 {
    let result = build(BrickCommand::RemoveBluetoothPeer { name: "PC1".into() });
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    assert_eq!(
        result.payload,
        [
            0x00, 0x00, // no globals
            0xd6, // opCOM_REMOVE
            0x02, // HW_BT
            0x84, 0x50, 0x43, 0x31, 0x00, // LCS "PC1"
        ]
    );
}

#[test]
fn commands_build_command__refuses_to_remove_a_peer_by_an_empty_or_blank_name() {
    for name in ["", "   "] {
        let cmd = BrickCommand::RemoveBluetoothPeer { name: name.into() };
        assert!(build_command(&cmd).is_err(), "expected \"{name}\" refused");
    }
}

#[test]
fn commands_build_command__removes_a_peer_whose_name_has_a_space_and_a_diacritic_sent_as_utf8() {
    let result = build(BrickCommand::RemoveBluetoothPeer {
        name: "Učebna PC".into(),
    });
    let mut expected = vec![0x02, 0x84];
    expected.extend_from_slice("Učebna PC".as_bytes());
    expected.push(0x00);
    assert_eq!(&result.payload[3..], expected);
}

#[test]
fn commands_build_command__reads_buttons_through_op_ui_button_not_op_ui_read() {
    let result = build(BrickCommand::Buttons);
    assert_eq!(result.payload[2], 0x83, "expected opUI_BUTTON");
    assert_eq!(result.payload[3], 0x09, "expected PRESSED subcode");
    assert!(!result.payload.contains(&0x81), "opUI_READ must not appear");
}

#[test]
fn commands_build_command__builds_info_command_as_direct_command_with_reply() {
    let result = build(BrickCommand::Info);
    assert_eq!(result.packet_type, command::DIRECT_COMMAND_REPLY);
    // brick name 16 + OS 16 + HW 8 + FW 8 + OS build 12 + FW build 12
    assert_eq!(read_uint16le(&result.payload, 0).unwrap(), 72);
}

#[test]
fn commands_build_command__builds_fs_list_as_system_command() {
    let result = build(BrickCommand::FsList {
        path: "/home".into(),
    });
    assert_eq!(result.packet_type, command::SYSTEM_COMMAND_REPLY);
}

#[test]
fn commands_build_command__builds_fs_write_as_system_command() {
    let result = build(BrickCommand::FsWrite {
        path: "/test.txt".into(),
        content: "hello".into(),
    });
    assert_eq!(result.packet_type, command::SYSTEM_COMMAND_REPLY);
}

#[test]
fn commands_build_command__builds_fs_delete_as_system_command() {
    let result = build(BrickCommand::FsDelete {
        path: "/test.txt".into(),
    });
    assert_eq!(result.packet_type, command::SYSTEM_COMMAND_REPLY);
}

// ── Response parser ─────────────────────────────────────────────────

#[test]
fn responses_parse_response__parses_battery_response_as_percent_volts_and_amps() {
    // Layout measured on a real brick: [0..3] volts, [4..7] amps, [8] percent.
    let mut payload = [0u8; 9];
    payload[0..4].copy_from_slice(&8.3598f32.to_le_bytes());
    payload[4..8].copy_from_slice(&0.1433f32.to_le_bytes());
    payload[8] = 100;

    let result = parse_response(
        &BrickCommand::Battery,
        &make_reply(reply::DIRECT_REPLY, &payload),
    )
    .unwrap();

    let BrickResponse::Battery {
        level,
        voltage,
        current_amps,
    } = result
    else {
        panic!("expected battery");
    };
    assert_eq!(level, 100);
    assert!((voltage - 8.3598).abs() < 0.001);
    assert!((current_amps - 0.1433).abs() < 0.001);
}

#[test]
fn responses_parse_response__rejects_a_truncated_battery_reply_instead_of_reporting_0_percent() {
    let err = parse_response(
        &BrickCommand::Battery,
        &make_reply(reply::DIRECT_REPLY, &[0; 4]),
    )
    .unwrap_err();
    assert!(err.message().contains("Malformed battery reply"), "{err}");
}

#[test]
fn responses_parse_response__parses_a_listing_past_the_7_byte_system_reply_header() {
    // Real reply began 99 08 42 00 00 00 00 then the listing.
    let mut payload = vec![0x99, 0x08, 0x42, 0x00, 0x00, 0x00, 0x00];
    payload.extend_from_slice(b"tetris/\nSUMO/\n");

    let result = parse_response(
        &BrickCommand::FsList { path: "/x/".into() },
        &make_reply(reply::SYSTEM_REPLY, &payload),
    )
    .unwrap();

    let BrickResponse::FsList { listing, .. } = result else {
        panic!("expected fs:list");
    };
    let entries = parse_listing(&listing);
    let shape: Vec<_> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.kind, e.bytes, e.md5.clone()))
        .collect();
    use ev3_protocol::responses::FsEntryKind::Directory;
    assert_eq!(
        shape,
        [
            ("tetris", Directory, None, None),
            ("SUMO", Directory, None, None)
        ]
    );
}

#[test]
fn responses_parse_response__parses_buttons_response() {
    let result = parse_response(
        &BrickCommand::Buttons,
        &make_reply(reply::DIRECT_REPLY, &[1, 0, 0, 0, 1, 0]),
    )
    .unwrap();
    let BrickResponse::Buttons(state) = result else {
        panic!("expected buttons");
    };
    assert!(state.up);
    assert!(!state.enter);
    assert!(state.left);
    assert_eq!(
        state,
        ButtonsState {
            up: true,
            left: true,
            ..ButtonsState::default()
        }
    );
}

#[test]
fn responses_parse_response__parses_ports_response_with_all_empty() {
    let payload = [126u8; 48];
    let result = parse_response(
        &BrickCommand::Ports,
        &make_reply(reply::DIRECT_REPLY, &payload),
    )
    .unwrap();
    let BrickResponse::Ports {
        motor_ports,
        sensor_ports,
    } = result
    else {
        panic!("expected ports");
    };
    assert_eq!(sensor_ports.len(), 4);
    assert_eq!(motor_ports.len(), 4);
}

#[test]
fn responses_parse_response__throws_on_direct_reply_error() {
    let err = parse_response(
        &BrickCommand::Battery,
        &make_reply(reply::DIRECT_REPLY_ERROR, &[]),
    )
    .unwrap_err();
    assert!(
        err.message()
            .to_lowercase()
            .contains("direct command error"),
        "{err}"
    );
}

#[test]
fn responses_parse_response__refuses_a_battery_level_outside_the_documented_0_100_range() {
    let mut payload = [0u8; 9];
    payload[8] = 200;
    let err = parse_response(
        &BrickCommand::Battery,
        &make_reply(reply::DIRECT_REPLY, &payload),
    )
    .unwrap_err();
    assert!(err.message().contains("not a percentage"), "{err}");
}

#[test]
fn responses_parse_response__accepts_a_battery_level_at_the_top_of_the_range() {
    let mut payload = [0u8; 9];
    payload[8] = 100;
    let result = parse_response(
        &BrickCommand::Battery,
        &make_reply(reply::DIRECT_REPLY, &payload),
    )
    .unwrap();
    let BrickResponse::Battery { level, .. } = result else {
        panic!("expected battery");
    };
    assert_eq!(level, 100);
}

#[test]
fn responses_parse_response__names_the_status_from_a_system_reply_error() {
    // The payload opens with the echoed system command, so the status is the second byte.
    let payload = [system::LIST_FILES, system_status::ILLEGAL_PATH];
    let err = parse_response(
        &BrickCommand::FsList {
            path: "/bad".into(),
        },
        &make_reply(reply::SYSTEM_REPLY_ERROR, &payload),
    )
    .unwrap_err();
    assert!(
        err.message()
            .contains("system command error for 'fs:list': ILLEGAL_PATH"),
        "{err}"
    );
}

#[test]
fn responses_parse_response__parses_fs_write_response() {
    let result = parse_response(
        &BrickCommand::FsWrite {
            path: "/test".into(),
            content: "x".into(),
        },
        &make_reply(reply::SYSTEM_REPLY, &[0x00]),
    )
    .unwrap();
    assert_eq!(result, BrickResponse::FsWrite);
}

#[test]
fn responses_parse_response__parses_fs_delete_response() {
    let result = parse_response(
        &BrickCommand::FsDelete {
            path: "/test".into(),
        },
        &make_reply(reply::SYSTEM_REPLY, &[0x00]),
    )
    .unwrap();
    assert_eq!(result, BrickResponse::FsDelete { deleted: true });
}

#[test]
fn responses_parse_response__parses_the_bluetooth_peer_count() {
    let result = parse_response(
        &BrickCommand::BluetoothPeerCount,
        &make_reply(reply::DIRECT_REPLY, &[3]),
    )
    .unwrap();
    assert_eq!(result, BrickResponse::BluetoothPeerCount { count: 3 });
}

#[test]
fn responses_parse_response__parses_a_bluetooth_peer_name_paired_connected_and_type() {
    let mut payload = [0xaau8; 130];
    let name = "Učebna PC ".as_bytes();
    payload[..name.len()].copy_from_slice(name);
    payload[name.len()] = 0;
    payload[127] = 1; // paired
    payload[128] = 0; // connected
    payload[129] = 3; // ICON_PC
    let result = parse_response(
        &BrickCommand::BluetoothPeer { index: 1 },
        &make_reply(reply::DIRECT_REPLY, &payload),
    )
    .unwrap();
    // The trailing space stays: the name is matched and removed byte for byte.
    assert_eq!(
        result,
        BrickResponse::BluetoothPeer {
            name: "Učebna PC ".into(),
            paired: true,
            connected: false,
            peer_type: 3,
        }
    );
}

#[test]
fn responses_parse_response__parses_a_connected_bluetooth_peer() {
    let mut payload = [0u8; 130];
    payload[..3].copy_from_slice(b"EV3");
    payload[127] = 1;
    payload[128] = 1;
    payload[129] = 5; // ICON_BRICK
    let result = parse_response(
        &BrickCommand::BluetoothPeer { index: 0 },
        &make_reply(reply::DIRECT_REPLY, &payload),
    )
    .unwrap();
    let BrickResponse::BluetoothPeer {
        connected,
        peer_type,
        ..
    } = result
    else {
        panic!("expected a peer");
    };
    assert!(connected);
    assert_eq!(peer_type, 5);
}

#[test]
fn responses_parse_response__acknowledges_a_peer_removal_with_a_bare_reply() {
    let result = parse_response(
        &BrickCommand::RemoveBluetoothPeer { name: "PC1".into() },
        &make_reply(reply::DIRECT_REPLY, &[]),
    )
    .unwrap();
    assert_eq!(result, BrickResponse::RemoveBluetoothPeer);
}
