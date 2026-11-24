//! Rules of `src/core/protocol` that no TypeScript test pins. Each test is named
//! `<module>__<rule>`; the expected bytes are worked out by hand from the TypeScript source and
//! the firmware notes in it, never taken from this crate's output.

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::bytecode::read_fixed_c_string;
use ev3_protocol::commands::{
    FIRMWARE_BUFFER_BYTES, MAX_PROTOCOL_PACKET_BYTES, MAX_WRITE_CHUNK_BYTES, SYSTEM_ENVELOPE_BYTES,
    is_blank_peer_name, max_first_chunk_bytes,
};
use ev3_protocol::packet::{
    command, is_valid_brick_name, reply, system_status, verify_reply_counter,
};
use ev3_protocol::responses::parse_listing;
use ev3_protocol::responses::{FsEntry, FsEntryKind};
use ev3_protocol::{
    BrickCommand, BrickResponse, Ev3Packet, build_command, decode_ev3_packet, encode_ev3_packet,
    extract_length_prefixed_packet, parse_response,
};

fn payload_of(cmd: BrickCommand) -> Vec<u8> {
    build_command(&cmd).unwrap().payload
}

fn lcs(text: &str) -> Vec<u8> {
    let mut out = vec![0x84];
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    out
}

fn cstr(text: &str) -> Vec<u8> {
    let mut out = text.as_bytes().to_vec();
    out.push(0);
    out
}

fn parse(cmd: BrickCommand, packet_type: u8, payload: &[u8]) -> BrickResponse {
    let packet = Ev3Packet {
        message_counter: 1,
        packet_type,
        payload,
    };
    parse_response(&cmd, &packet).unwrap()
}

fn parse_err(cmd: BrickCommand, packet_type: u8, payload: &[u8]) -> String {
    let packet = Ev3Packet {
        message_counter: 1,
        packet_type,
        payload,
    };
    parse_response(&cmd, &packet)
        .unwrap_err()
        .message()
        .to_owned()
}

// ── Packets ─────────────────────────────────────────────────────────

#[test]
fn packet__encodes_length_counter_type_then_payload() {
    let encoded = encode_ev3_packet(0x0102, 0x80, &[0xaa, 0xbb]).unwrap();
    // body = counter 2 + type 1 + payload 2 = 5
    assert_eq!(encoded, [0x05, 0x00, 0x02, 0x01, 0x80, 0xaa, 0xbb]);
}

#[test]
fn packet__refuses_a_payload_the_16_bit_length_cannot_describe() {
    assert!(encode_ev3_packet(1, 0, &vec![0; 0xffff - 2]).is_err());
    assert!(encode_ev3_packet(1, 0, &vec![0; 0xffff - 3]).is_ok());
}

#[test]
fn packet__refuses_an_oversized_reply_and_never_reads_past_its_length() {
    // Declares a 3-byte body but carries 5 bytes of body.
    let long = [0x03, 0x00, 0x01, 0x00, 0x02, 0xaa, 0xbb];
    assert!(decode_ev3_packet(&long).is_err());
}

#[test]
fn packet__refuses_a_truncated_reply() {
    // Declares a 5-byte body but carries 3.
    let short = [0x05, 0x00, 0x01, 0x00, 0x02];
    assert!(decode_ev3_packet(&short).is_err());
    assert!(decode_ev3_packet(&[]).is_err());
}

#[test]
fn packet__extract_waits_for_the_whole_declared_length() {
    // Declares a 5-byte body (7 bytes in all) but only 6 have arrived.
    assert!(extract_length_prefixed_packet(&[0x05, 0x00, 1, 0, 2, 0xaa]).is_none());
    let (packet, rest) = extract_length_prefixed_packet(&[0x03, 0x00, 1, 0, 2]).unwrap();
    assert_eq!(packet, [0x03, 0x00, 1, 0, 2]);
    assert!(rest.is_empty());
}

#[test]
fn packet__a_reply_with_a_foreign_message_counter_is_reported_as_such() {
    let reply = encode_ev3_packet(8, reply::DIRECT_REPLY, &[]).unwrap();
    assert!(verify_reply_counter(&reply, 8, "USB").is_ok());
    let err = verify_reply_counter(&reply, 7, "USB").unwrap_err();
    assert_eq!(
        err.message(),
        "USB reply counter mismatch: expected 7, got 8."
    );
}

#[test]
fn packet__a_reply_too_short_to_hold_a_counter_reads_as_minus_one() {
    let err = verify_reply_counter(&[0x01, 0x00, 0x05], 1, "TCP").unwrap_err();
    assert_eq!(
        err.message(),
        "TCP reply counter mismatch: expected 1, got -1."
    );
}

#[test]
fn packet__brick_name_set_is_ascii_letters_digits_underscore_and_hyphen() {
    assert!(is_valid_brick_name("Az09_-"));
    // A byte of 128 or more, a dot, a space and the empty name are all outside the set.
    for name in ["\u{e9}", "a.b", "a b", ""] {
        assert!(!is_valid_brick_name(name), "{name:?}");
    }
}

#[test]
fn packet__system_status_names_resolve_and_unknown_codes_do_not() {
    assert_eq!(
        system_status::name_of(system_status::END_OF_FILE),
        Some("END_OF_FILE")
    );
    assert_eq!(
        system_status::name_of(system_status::ILLEGAL_CONNECTION),
        Some("ILLEGAL_CONNECTION")
    );
    assert_eq!(system_status::name_of(0x0d), None);
}

// ── Command encoders ────────────────────────────────────────────────

#[test]
fn commands__telemetry_frame_is_sent_unchanged_as_a_direct_command_with_reply() {
    let frame = vec![0x02, 0x00, 0x81, 0x01, 0x60];
    let encoded = build_command(&BrickCommand::TelemetryFrame {
        payload: frame.clone(),
    })
    .unwrap();
    assert_eq!(encoded.packet_type, command::DIRECT_COMMAND_REPLY);
    assert_eq!(encoded.payload, frame);
}

#[test]
fn commands__battery_reads_volts_amps_then_the_level_byte_last() {
    assert_eq!(
        payload_of(BrickCommand::Battery),
        [
            0x09, 0x00, // 9 global bytes
            0x81, 0x01, 0x60, // UI_READ GET_VBATT -> GV0(0)
            0x81, 0x02, 0x64, // UI_READ GET_IBATT -> GV0(4)
            0x81, 0x12, 0x68, // UI_READ GET_LBATT -> GV0(8)
        ]
    );
}

#[test]
fn commands__buttons_reads_six_buttons_with_op_ui_button() {
    assert_eq!(
        payload_of(BrickCommand::Buttons),
        [
            0x06, 0x00, //
            0x83, 0x09, 0x01, 0x60, //
            0x83, 0x09, 0x02, 0x61, //
            0x83, 0x09, 0x03, 0x62, //
            0x83, 0x09, 0x04, 0x63, //
            0x83, 0x09, 0x05, 0x64, //
            0x83, 0x09, 0x06, 0x65,
        ]
    );
}

#[test]
fn commands__info_reads_name_then_os_hw_fw_and_builds_into_their_slots() {
    assert_eq!(
        payload_of(BrickCommand::Info),
        [
            72, 0x00, //
            0xd3, 0x0d, 0x10, 0x60, // COM_GET GET_BRICKNAME len 16 -> GV0(0)
            0x81, 0x03, 0x10, 0x70, // GET_OS_VERS len 16 -> GV0(16)
            0x81, 0x09, 0x08, 0xe1, 32, // GET_HW_VERS len 8 -> GV1(32)
            0x81, 0x0a, 0x08, 0xe1, 40, // GET_FW_VERS len 8 -> GV1(40)
            0x81, 0x0c, 0x0c, 0xe1, 48, // GET_OS_BUILD len 12 -> GV1(48)
            0x81, 0x0b, 0x0c, 0xe1, 60, // GET_FW_BUILD len 12 -> GV1(60)
        ]
    );
}

#[test]
fn commands__ports_reads_types_modes_si_values_and_tachos_into_48_global_bytes() {
    let mut expected = vec![48, 0x00];
    // Sensor type/mode: INPUT_DEVICE GET_TYPEMODE layer 0, port, GV0(2i), GV0(2i+1)
    for i in 0u8..4 {
        expected.extend([0x99, 0x05, 0x00, i, 0x60 + 2 * i, 0x60 + 2 * i + 1]);
    }
    // Motor type/mode: ports 16..19 land in the ports slots 8..15
    for i in 0u8..4 {
        expected.extend([
            0x99,
            0x05,
            0x00,
            16 + i,
            0x60 + 8 + 2 * i,
            0x60 + 8 + 2 * i + 1,
        ]);
    }
    // Sensor SI: INPUT_READ_SI layer, port, type hint 0, mode hint 0, GV0(16 + 4i)
    for i in 0u8..4 {
        expected.extend([0x9d, 0x00, i, 0x00, 0x00, 0x60 + 16 + 4 * i]);
    }
    // Motor tacho: OUTPUT_GET_COUNT layer, port, GV1(32 + 4i)
    for i in 0u8..4 {
        expected.extend([0xb3, 0x00, i, 0xe1, 32 + 4 * i]);
    }
    assert_eq!(payload_of(BrickCommand::Ports), expected);
    assert_eq!(expected.len(), 94);
}

#[test]
fn commands__set_name_vector() {
    assert_eq!(
        payload_of(BrickCommand::SetName {
            name: "AAA2".into()
        }),
        [0x00, 0x00, 0xd4, 0x08, 0x84, b'A', b'A', b'A', b'2', 0x00]
    );
}

#[test]
fn commands__bluetooth_flag_vectors() {
    assert_eq!(
        payload_of(BrickCommand::SetBluetooth { on: true }),
        [0x00, 0x00, 0xd4, 0x01, 0x02, 0x01]
    );
    assert_eq!(
        payload_of(BrickCommand::SetBluetoothVisible { visible: false }),
        [0x00, 0x00, 0xd4, 0x02, 0x02, 0x00]
    );
}

#[test]
fn commands__bluetooth_peer_index_that_lc0_cannot_hold_is_refused() {
    assert!(build_command(&BrickCommand::BluetoothPeer { index: 31 }).is_ok());
    assert!(build_command(&BrickCommand::BluetoothPeer { index: 32 }).is_err());
}

#[test]
fn commands__blank_peer_name_is_empty_or_whitespace_only() {
    assert!(is_blank_peer_name(""));
    assert!(is_blank_peer_name(" \t "));
    assert!(!is_blank_peer_name(" a "));
}

#[test]
fn commands__fs_list_and_read_ask_for_a_1012_byte_chunk() {
    // 1012 = 0x03F4
    let mut list = vec![0x99, 0xf4, 0x03];
    list.extend(cstr("/home"));
    assert_eq!(
        payload_of(BrickCommand::FsList {
            path: "/home".into()
        }),
        list
    );

    let mut read = vec![0x94, 0xf4, 0x03];
    read.extend(cstr("/home/a"));
    assert_eq!(
        payload_of(BrickCommand::FsRead {
            path: "/home/a".into()
        }),
        read
    );
}

#[test]
fn commands__fs_write_carries_the_utf8_length_path_and_content() {
    // "hé" is 3 bytes of UTF-8.
    let mut expected = vec![0x92, 0x03, 0x00, 0x00, 0x00];
    expected.extend(cstr("/t"));
    expected.extend("hé".as_bytes());
    assert_eq!(
        payload_of(BrickCommand::FsWrite {
            path: "/t".into(),
            content: "hé".into()
        }),
        expected
    );
}

#[test]
fn commands__fs_delete_vector() {
    let mut expected = vec![0x9c];
    expected.extend(cstr("/t"));
    assert_eq!(
        payload_of(BrickCommand::FsDelete { path: "/t".into() }),
        expected
    );
}

#[test]
fn commands__fs_exists_size_and_free_space_vectors() {
    let mut exists = vec![0x01, 0x00, 0xc6, 0x10];
    exists.extend(lcs("/p"));
    exists.push(0x60);
    assert_eq!(
        payload_of(BrickCommand::FsExists { path: "/p".into() }),
        exists
    );

    let mut size = vec![0x08, 0x00, 0xc6, 0x11];
    size.extend(lcs("/p"));
    size.extend([0x60, 0x64]);
    assert_eq!(payload_of(BrickCommand::FsSize { path: "/p".into() }), size);

    assert_eq!(
        payload_of(BrickCommand::FsFreeSpace),
        [0x08, 0x00, 0xc5, 0x60, 0x64]
    );
}

#[test]
fn commands__fs_make_directory_copy_and_remove_tree_vectors() {
    let mut mkdir = vec![0x01, 0x00, 0xc0, 0x0a];
    mkdir.extend(lcs("/d"));
    mkdir.push(0x60);
    assert_eq!(
        payload_of(BrickCommand::FsMakeDirectory { path: "/d".into() }),
        mkdir
    );

    let mut copy = vec![0x00, 0x00, 0xc0, 0x1f];
    copy.extend(lcs("/a"));
    copy.extend(lcs("/b"));
    assert_eq!(
        payload_of(BrickCommand::FsCopy {
            from: "/a".into(),
            to: "/b".into()
        }),
        copy
    );

    let mut rm = vec![0x00, 0x00, 0xc0, 0x1e];
    rm.extend(lcs("/d"));
    assert_eq!(
        payload_of(BrickCommand::FsRemoveTree { path: "/d".into() }),
        rm
    );
}

#[test]
fn commands__transfer_step_vectors() {
    let mut begin_write = vec![0x92, 0x10, 0x00, 0x00, 0x00];
    begin_write.extend(cstr("/f"));
    begin_write.extend([1, 2, 3]);
    assert_eq!(
        payload_of(BrickCommand::FsBeginWrite {
            path: "/f".into(),
            total_bytes: 16,
            chunk: vec![1, 2, 3]
        }),
        begin_write
    );
    assert_eq!(
        payload_of(BrickCommand::FsContinueWrite {
            handle: 5,
            chunk: vec![9, 8]
        }),
        [0x93, 0x05, 9, 8]
    );

    let mut begin_read = vec![0x94, 0x00, 0x04];
    begin_read.extend(cstr("/f"));
    assert_eq!(
        payload_of(BrickCommand::FsBeginRead {
            path: "/f".into(),
            want_bytes: 0x0400
        }),
        begin_read
    );
    assert_eq!(
        payload_of(BrickCommand::FsContinueRead {
            handle: 5,
            want_bytes: 0x0102
        }),
        [0x95, 0x05, 0x02, 0x01]
    );
    assert_eq!(
        payload_of(BrickCommand::FsCloseHandle { handle: 5 }),
        [0x98, 0x05]
    );
    assert_eq!(
        payload_of(BrickCommand::FsListContinue {
            handle: 5,
            want_bytes: 0x0102
        }),
        [0x9a, 0x05, 0x02, 0x01]
    );
}

#[test]
fn commands__transfer_steps_refuse_a_handle_past_the_firmware_table() {
    for cmd in [
        BrickCommand::FsContinueRead {
            handle: 64,
            want_bytes: 1,
        },
        BrickCommand::FsListContinue {
            handle: 64,
            want_bytes: 1,
        },
    ] {
        let err = build_command(&cmd).unwrap_err();
        assert!(err.message().contains("0..63"), "{err}");
    }
}

#[test]
fn commands__begin_write_first_chunk_is_bounded_by_the_room_after_the_path() {
    // Envelope 6 + total 4 + path "/f\0" 3 leaves 65537 - 13 = 65524.
    assert_eq!(
        max_first_chunk_bytes("/f", MAX_PROTOCOL_PACKET_BYTES),
        65_524
    );
    let at_limit = BrickCommand::FsBeginWrite {
        path: "/f".into(),
        total_bytes: 70_000,
        chunk: vec![0; 65_524],
    };
    assert!(build_command(&at_limit).is_ok());
    let past = BrickCommand::FsBeginWrite {
        path: "/f".into(),
        total_bytes: 70_000,
        chunk: vec![0; 65_525],
    };
    let err = build_command(&past).unwrap_err();
    assert!(
        err.message()
            .contains("65524 bytes left after a 2-character path"),
        "{err}"
    );
}

#[test]
fn commands__begin_write_refuses_a_first_chunk_larger_than_the_declared_total() {
    let cmd = BrickCommand::FsBeginWrite {
        path: "/f".into(),
        total_bytes: 2,
        chunk: vec![0; 3],
    };
    let err = build_command(&cmd).unwrap_err();
    assert!(
        err.message().contains("exceeds the declared total of 2"),
        "{err}"
    );
}

#[test]
fn commands__continue_write_ceiling_is_the_protocol_less_envelope_and_handle() {
    let at_limit = BrickCommand::FsContinueWrite {
        handle: 1,
        chunk: vec![0; 65_530],
    };
    assert!(build_command(&at_limit).is_ok());
    let past = BrickCommand::FsContinueWrite {
        handle: 1,
        chunk: vec![0; 65_531],
    };
    assert!(build_command(&past).is_err());
}

#[test]
fn commands__firmware_buffer_constants() {
    assert_eq!(FIRMWARE_BUFFER_BYTES, 1024);
    assert_eq!(SYSTEM_ENVELOPE_BYTES, 6);
    assert_eq!(MAX_WRITE_CHUNK_BYTES, 1017);
    // The room left after a path for the first chunk on the stock firmware.
    assert_eq!(max_first_chunk_bytes("abc", FIRMWARE_BUFFER_BYTES), 1010);
}

#[test]
fn commands__every_command_has_a_distinct_kind_name() {
    let kinds = [
        BrickCommand::Battery.kind(),
        BrickCommand::FsFreeSpace.kind(),
        BrickCommand::ProgramEmergencyStop.kind(),
        BrickCommand::FsListContinue {
            handle: 0,
            want_bytes: 0,
        }
        .kind(),
    ];
    assert_eq!(
        kinds,
        [
            "battery",
            "fs:freeSpace",
            "program:emergencyStop",
            "fs:listContinue"
        ]
    );
}

// ── Response parsers ────────────────────────────────────────────────

#[test]
fn responses__telemetry_frame_reply_is_handed_back_as_bytes() {
    let got = parse(
        BrickCommand::TelemetryFrame { payload: vec![] },
        reply::DIRECT_REPLY,
        &[1, 2, 3],
    );
    assert_eq!(
        got,
        BrickResponse::TelemetryFrame {
            payload: vec![1, 2, 3]
        }
    );
}

#[test]
fn responses__settings_and_stops_acknowledge_with_a_bare_reply() {
    let ack = |cmd| parse(cmd, reply::DIRECT_REPLY, &[]);
    assert_eq!(
        ack(BrickCommand::SetName { name: "A".into() }),
        BrickResponse::SetName
    );
    assert_eq!(
        ack(BrickCommand::SetBluetooth { on: true }),
        BrickResponse::SetBluetooth
    );
    assert_eq!(
        ack(BrickCommand::SetBluetoothVisible { visible: true }),
        BrickResponse::SetBluetoothVisible
    );
    assert_eq!(ack(BrickCommand::ProgramStop), BrickResponse::ProgramStop);
    assert_eq!(
        ack(BrickCommand::ProgramEmergencyStop),
        BrickResponse::ProgramEmergencyStop
    );
}

#[test]
fn responses__info_reads_name_and_versions_and_falls_back_to_ev3() {
    let mut payload = vec![0u8; 72];
    payload[..3].copy_from_slice(b"AAA");
    payload[16..25].copy_from_slice(b"Linux 2.6");
    payload[40..45].copy_from_slice(b"1.09E");
    assert_eq!(
        parse(BrickCommand::Info, reply::DIRECT_REPLY, &payload),
        BrickResponse::Info {
            display_name: "AAA".into(),
            firmware_version: Some("1.09E".into()),
            os_version: Some("Linux 2.6".into()),
        }
    );
    assert_eq!(
        parse(BrickCommand::Info, reply::DIRECT_REPLY, &[0u8; 72]),
        BrickResponse::Info {
            display_name: "EV3".into(),
            firmware_version: None,
            os_version: None
        }
    );
}

#[test]
fn bytecode__fixed_c_string_is_trimmed_and_cut_at_the_slot() {
    assert_eq!(read_fixed_c_string(b"  AB  \0zz", 0, 9), "AB");
    // The slot is 3 bytes long, so the terminator past it is never reached.
    assert_eq!(read_fixed_c_string(b"ABCDEF", 0, 3), "ABC");
}

#[test]
fn responses__buttons_beyond_a_short_payload_read_as_not_pressed() {
    let got = parse(BrickCommand::Buttons, reply::DIRECT_REPLY, &[1]);
    let BrickResponse::Buttons(state) = got else {
        panic!()
    };
    assert!(state.up);
    assert!(!state.back);
}

#[test]
fn responses__ports_with_a_short_payload_reads_missing_slots_as_empty() {
    // Only the first sensor's type fits; everything else is an empty port.
    let got = parse(BrickCommand::Ports, reply::DIRECT_REPLY, &[30]);
    let BrickResponse::Ports {
        motor_ports,
        sensor_ports,
    } = got
    else {
        panic!()
    };
    assert_eq!(sensor_ports[0].type_code, Some(30));
    assert_eq!(
        sensor_ports[0].value, None,
        "the value slot is past the payload"
    );
    assert!(sensor_ports[1..].iter().all(|p| p.type_code.is_none()));
    assert!(motor_ports.iter().all(|p| p.type_code.is_none()));
    assert_eq!(sensor_ports[0].port, "1");
    assert_eq!(motor_ports[3].port, "D");
}

#[test]
fn responses__short_direct_replies_are_refused() {
    let cases: [(BrickCommand, &[u8], &str); 6] = [
        (
            BrickCommand::ProgramRun { path: "p".into() },
            &[0; 7],
            "Malformed program:run reply",
        ),
        (
            BrickCommand::ProgramStatus,
            &[],
            "Malformed program:status reply",
        ),
        (
            BrickCommand::SystemRun {
                command: "x".into(),
            },
            &[0; 3],
            "Malformed system:run reply",
        ),
        (
            BrickCommand::BluetoothPeerCount,
            &[],
            "Malformed brick:bluetoothPeerCount reply",
        ),
        (
            BrickCommand::BluetoothPeer { index: 0 },
            &[0; 129],
            "Malformed brick:bluetoothPeer reply",
        ),
        (
            BrickCommand::FsExists { path: "p".into() },
            &[],
            "Malformed fs:exists reply",
        ),
    ];
    for (cmd, payload, expected) in cases {
        let message = parse_err(cmd, reply::DIRECT_REPLY, payload);
        assert!(message.contains(expected), "{message}");
    }
}

/// The globals of a read from an offset: size at 0, exists at 16, data from 20.
fn read_from_reply(exists: bool, size: u32, data: &[u8], max: u16) -> Vec<u8> {
    let mut globals = vec![0xAA; 20 + usize::from(max)];
    globals[..4].copy_from_slice(&size.to_le_bytes());
    globals[16] = u8::from(exists);
    globals[20..20 + data.len()].copy_from_slice(data);
    globals
}

fn read_from(offset: u32, max_bytes: u16) -> BrickCommand {
    BrickCommand::FsReadFrom {
        path: "/p".into(),
        offset,
        max_bytes,
    }
}

#[test]
fn responses__fs_read_from_takes_only_what_lies_past_the_offset() {
    let data: Vec<u8> = (0..64).collect();
    // The data area also holds what the brick skipped: only size - offset of it is the file's.
    let reply = read_from_reply(true, 1010, &data, 64);
    assert_eq!(
        parse(read_from(1000, 64), reply::DIRECT_REPLY, &reply),
        BrickResponse::FsReadFrom {
            exists: true,
            size: 1010,
            chunk: data[..10].to_vec(),
        }
    );
    // More than asked for waits for the next read.
    let reply = read_from_reply(true, 5000, &data, 64);
    assert_eq!(
        parse(read_from(1000, 64), reply::DIRECT_REPLY, &reply),
        BrickResponse::FsReadFrom {
            exists: true,
            size: 5000,
            chunk: data.clone(),
        }
    );
    // A file no longer than the offset (it was replaced by a shorter one) gives nothing.
    let reply = read_from_reply(true, 500, &data, 64);
    assert_eq!(
        parse(read_from(1000, 64), reply::DIRECT_REPLY, &reply),
        BrickResponse::FsReadFrom {
            exists: true,
            size: 500,
            chunk: Vec::new(),
        }
    );
    // Missing: whatever the globals hold.
    let reply = read_from_reply(false, 77, &data, 64);
    assert_eq!(
        parse(read_from(0, 64), reply::DIRECT_REPLY, &reply),
        BrickResponse::FsReadFrom {
            exists: false,
            size: 0,
            chunk: Vec::new(),
        }
    );
    let message = parse_err(read_from(0, 64), reply::DIRECT_REPLY, &[0; 83]);
    assert!(message.contains("Malformed fs:readFrom reply"), "{message}");
}

#[test]
fn commands__fs_read_from_asks_for_the_globals_it_reads_and_refuses_what_does_not_fit() {
    let command = build_command(&read_from(65536, 992)).unwrap();
    assert_eq!(
        command.packet_type,
        ev3_protocol::packet::command::DIRECT_COMMAND_REPLY
    );
    // 20 bytes of layout and 992 of data: 1012, inside the firmware's 1024-byte buffer with the
    // reply's envelope.
    assert_eq!(&command.payload[..2], &1012u16.to_le_bytes());
    assert!(build_command(&read_from(0, 64)).unwrap().payload[..2] == 84u16.to_le_bytes());
    for refused in [read_from(0, 0), read_from(0, 993), read_from(u32::MAX, 64)] {
        assert!(build_command(&refused).is_err(), "{refused:?}");
    }
}

#[test]
fn responses__fs_exists_and_make_directory_read_one_byte() {
    let exists = |b| {
        parse(
            BrickCommand::FsExists { path: "p".into() },
            reply::DIRECT_REPLY,
            &[b],
        )
    };
    assert_eq!(exists(1), BrickResponse::FsExists { exists: true });
    assert_eq!(exists(0), BrickResponse::FsExists { exists: false });
    let made = parse(
        BrickCommand::FsMakeDirectory { path: "d".into() },
        reply::DIRECT_REPLY,
        &[1],
    );
    assert_eq!(made, BrickResponse::FsMakeDirectory { exists: true });
    let message = parse_err(
        BrickCommand::FsMakeDirectory { path: "d".into() },
        reply::DIRECT_REPLY,
        &[],
    );
    assert!(
        message.contains("Malformed fs:makeDirectory reply"),
        "{message}"
    );
}

#[test]
fn responses__fs_size_free_space_copy_and_remove_tree() {
    // Files first, then the kilobyte total.
    let size = parse(
        BrickCommand::FsSize { path: "p".into() },
        reply::DIRECT_REPLY,
        &[2, 0, 0, 0, 10, 0, 0, 0],
    );
    assert_eq!(
        size,
        BrickResponse::FsSize {
            kilobytes: 10,
            files: 2
        }
    );
    let free = parse(
        BrickCommand::FsFreeSpace,
        reply::DIRECT_REPLY,
        &[0x00, 0x01, 0, 0, 0x40, 0, 0, 0],
    );
    assert_eq!(
        free,
        BrickResponse::FsFreeSpace {
            total_kb: 256,
            free_kb: 64
        }
    );
    let message = parse_err(
        BrickCommand::FsSize { path: "p".into() },
        reply::DIRECT_REPLY,
        &[0; 7],
    );
    assert!(
        message.contains("Malformed fs:size reply: expected 8 bytes, got 7"),
        "{message}"
    );
    let message = parse_err(BrickCommand::FsFreeSpace, reply::DIRECT_REPLY, &[0; 7]);
    assert!(
        message.contains("Malformed fs:freeSpace reply"),
        "{message}"
    );
    assert_eq!(
        parse(
            BrickCommand::FsCopy {
                from: "a".into(),
                to: "b".into()
            },
            reply::DIRECT_REPLY,
            &[]
        ),
        BrickResponse::FsCopy
    );
    assert_eq!(
        parse(
            BrickCommand::FsRemoveTree { path: "a".into() },
            reply::DIRECT_REPLY,
            &[]
        ),
        BrickResponse::FsRemoveTree
    );
}

const MD5: &str = "0123456789ABCDEF0123456789abcdef";

fn entry(name: &str, kind: FsEntryKind, bytes: Option<u32>, md5: Option<&str>) -> FsEntry {
    FsEntry {
        name: name.into(),
        kind,
        bytes,
        md5: md5.map(str::to_owned),
    }
}

#[test]
fn responses__fs_list_reads_files_directories_and_lines_of_neither_shape() {
    let mut payload = vec![0x99, 0x08, 0x00, 0x00, 0x00, 0x00, 0x07];
    payload.extend(format!("{MD5} 0000002A my file.txt\nsub/\n../\nodd line\n\n").as_bytes());
    let got = parse(
        BrickCommand::FsList { path: "/".into() },
        reply::SYSTEM_REPLY,
        &payload,
    );
    let BrickResponse::FsList {
        listing,
        complete,
        handle,
    } = got
    else {
        panic!()
    };
    assert_eq!(
        parse_listing(&listing),
        [
            entry(
                "my file.txt",
                FsEntryKind::File,
                Some(42),
                Some("0123456789abcdef0123456789abcdef")
            ),
            entry("sub", FsEntryKind::Directory, None, None),
            entry("..", FsEntryKind::Directory, None, None),
            entry("odd line", FsEntryKind::Unknown, None, None),
        ]
    );
    // END_OF_FILE status marks the last page; the handle is byte 6.
    assert!(complete);
    assert_eq!(handle, Some(7));
}

#[test]
fn responses__fs_list_status_other_than_end_of_file_means_more_to_come() {
    let payload = [0x99, 0x00, 0, 0, 0, 0, 0x03];
    let got = parse(
        BrickCommand::FsList { path: "/".into() },
        reply::SYSTEM_REPLY,
        &payload,
    );
    let BrickResponse::FsList {
        listing,
        complete,
        handle,
    } = got
    else {
        panic!()
    };
    assert!(listing.is_empty());
    assert!(!complete);
    assert_eq!(handle, Some(3));
}

#[test]
fn responses__fs_list_file_line_with_a_bad_size_or_a_short_hash_is_unknown() {
    let bad_size = format!("{MD5} 0000002G name");
    let short_hash = "0123 0000002A name".to_owned();
    let no_name = format!("{MD5} 0000002A ");
    let mut payload = vec![0x99, 0x00, 0, 0, 0, 0, 0x03];
    payload.extend(
        format!("{bad_size}\n{short_hash}\n{no_name}\n\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\n").as_bytes(),
    );
    let got = parse(
        BrickCommand::FsList { path: "/".into() },
        reply::SYSTEM_REPLY,
        &payload,
    );
    let BrickResponse::FsList { listing, .. } = got else {
        panic!()
    };
    let entries = parse_listing(&listing);
    assert_eq!(entries.len(), 4);
    assert!(entries.iter().all(|e| e.kind == FsEntryKind::Unknown));
    assert_eq!(entries[0].name, bad_size);
}

#[test]
fn responses__fs_list_and_read_with_less_than_the_header_are_malformed_not_empty() {
    let list = parse_err(
        BrickCommand::FsList { path: "/".into() },
        reply::SYSTEM_REPLY,
        &[0x99, 0x08, 0, 0, 0, 0],
    );
    assert!(
        list.contains("Malformed fs:list reply: expected at least 7 bytes, got 6"),
        "{list}"
    );
    let read = parse_err(
        BrickCommand::FsRead { path: "/".into() },
        reply::SYSTEM_REPLY,
        &[0x94, 0x00],
    );
    assert!(read.contains("Malformed fs:read reply"), "{read}");
}

#[test]
fn responses__fs_read_returns_the_text_after_the_seven_byte_header() {
    let mut payload = vec![0x94, 0x08, 0x05, 0, 0, 0, 0x01];
    payload.extend("héllo".as_bytes());
    assert_eq!(
        parse(
            BrickCommand::FsRead { path: "/f".into() },
            reply::SYSTEM_REPLY,
            &payload
        ),
        BrickResponse::FsRead {
            content: "héllo".into()
        }
    );
}

#[test]
fn responses__fs_list_continue_has_a_three_byte_header() {
    let mut payload = vec![0x9a, 0x08, 0x09];
    payload.extend(b"sub/\n");
    let got = parse(
        BrickCommand::FsListContinue {
            handle: 9,
            want_bytes: 100,
        },
        reply::SYSTEM_REPLY,
        &payload,
    );
    assert_eq!(
        got,
        BrickResponse::FsListContinue {
            listing: b"sub/\n".to_vec(),
            complete: true,
            handle: 9
        }
    );
    let message = parse_err(
        BrickCommand::FsListContinue {
            handle: 9,
            want_bytes: 1,
        },
        reply::SYSTEM_REPLY,
        &[0x9a, 0x00],
    );
    assert!(
        message.contains("Malformed fs:listContinue reply: expected at least 3 bytes, got 2"),
        "{message}"
    );
}

#[test]
fn responses__write_steps_report_the_handle_and_end_of_file() {
    let begin = parse(
        BrickCommand::FsBeginWrite {
            path: "p".into(),
            total_bytes: 1,
            chunk: vec![],
        },
        reply::SYSTEM_REPLY,
        &[0x92, 0x00, 0x04],
    );
    assert_eq!(
        begin,
        BrickResponse::FsBeginWrite {
            handle: 4,
            end_of_file: false
        }
    );
    let cont = parse(
        BrickCommand::FsContinueWrite {
            handle: 4,
            chunk: vec![],
        },
        reply::SYSTEM_REPLY,
        &[0x93, 0x08, 0x04],
    );
    assert_eq!(
        cont,
        BrickResponse::FsContinueWrite {
            handle: 4,
            end_of_file: true
        }
    );
    let message = parse_err(
        BrickCommand::FsBeginWrite {
            path: "p".into(),
            total_bytes: 1,
            chunk: vec![],
        },
        reply::SYSTEM_REPLY,
        &[0x92, 0x00],
    );
    assert!(
        message.contains("BEGIN_DOWNLOAD reply carried no file handle"),
        "{message}"
    );
    let message = parse_err(
        BrickCommand::FsContinueWrite {
            handle: 4,
            chunk: vec![],
        },
        reply::SYSTEM_REPLY,
        &[0x93, 0x00],
    );
    assert!(
        message.contains("CONTINUE_DOWNLOAD reply carried no file handle"),
        "{message}"
    );
    let message = parse_err(
        BrickCommand::FsContinueWrite {
            handle: 4,
            chunk: vec![],
        },
        reply::SYSTEM_REPLY,
        &[0x93],
    );
    assert!(
        message.contains("Malformed fs:continueWrite reply: expected at least 2 bytes, got 1"),
        "{message}"
    );
}

#[test]
fn responses__read_steps_report_size_handle_chunk_and_end_of_file() {
    let begin = parse(
        BrickCommand::FsBeginRead {
            path: "p".into(),
            want_bytes: 10,
        },
        reply::SYSTEM_REPLY,
        &[0x94, 0x08, 0x00, 0x01, 0x00, 0x00, 0x05, 0xaa, 0xbb],
    );
    assert_eq!(
        begin,
        BrickResponse::FsBeginRead {
            total_bytes: 256,
            handle: 5,
            end_of_file: true,
            chunk: vec![0xaa, 0xbb]
        }
    );
    let cont = parse(
        BrickCommand::FsContinueRead {
            handle: 5,
            want_bytes: 10,
        },
        reply::SYSTEM_REPLY,
        &[0x95, 0x00, 0x05, 0xcc],
    );
    assert_eq!(
        cont,
        BrickResponse::FsContinueRead {
            handle: 5,
            end_of_file: false,
            chunk: vec![0xcc]
        }
    );
    let message = parse_err(
        BrickCommand::FsBeginRead {
            path: "p".into(),
            want_bytes: 10,
        },
        reply::SYSTEM_REPLY,
        &[0x94, 0x00, 0, 0, 0, 0],
    );
    assert!(
        message.contains("Malformed BEGIN_UPLOAD reply: expected at least 7 bytes, got 6"),
        "{message}"
    );
    let message = parse_err(
        BrickCommand::FsContinueRead {
            handle: 5,
            want_bytes: 10,
        },
        reply::SYSTEM_REPLY,
        &[0x95, 0x00],
    );
    assert!(
        message.contains("CONTINUE_UPLOAD reply carried no file handle"),
        "{message}"
    );
}

#[test]
fn responses__close_handle_needs_only_the_echo_and_status() {
    assert_eq!(
        parse(
            BrickCommand::FsCloseHandle { handle: 1 },
            reply::SYSTEM_REPLY,
            &[0x98, 0x00]
        ),
        BrickResponse::FsCloseHandle
    );
    let message = parse_err(
        BrickCommand::FsCloseHandle { handle: 1 },
        reply::SYSTEM_REPLY,
        &[0x98],
    );
    assert!(
        message.contains("Malformed fs:closeHandle reply"),
        "{message}"
    );
}

#[test]
fn responses__a_system_reply_error_with_an_unnamed_or_missing_status_is_shown_in_hex() {
    let message = parse_err(
        BrickCommand::FsList { path: "/".into() },
        reply::SYSTEM_REPLY_ERROR,
        &[0x99, 0x2f],
    );
    assert!(message.ends_with("'fs:list': 0x2f"), "{message}");
    let message = parse_err(
        BrickCommand::FsList { path: "/".into() },
        reply::SYSTEM_REPLY_ERROR,
        &[0x99],
    );
    assert!(message.ends_with("'fs:list': 0xff"), "{message}");
}
