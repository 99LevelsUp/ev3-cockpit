//! Ports of `src/__tests__/programCommands.test.ts`: the program and shell direct commands,
//! pinned byte for byte. Names are `<describe>__<it>` in snake case.

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::packet::{command, reply};
use ev3_protocol::{BrickCommand, BrickResponse, Ev3Packet, build_command, parse_response};

const PATH: &str = "../prjs/Demo/Demo.rbf";

/// LCS: 0x84, the bytes, a terminating zero.
fn lcs(text: &str) -> Vec<u8> {
    let mut out = vec![0x84];
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    out
}

fn reply_of(payload: &[u8]) -> Ev3Packet<'_> {
    Ev3Packet {
        message_counter: 1,
        packet_type: reply::DIRECT_REPLY,
        payload,
    }
}

#[test]
fn program_and_shell__loads_an_image_into_the_user_slot_and_starts_it_the_reply_carrying_the_size()
{
    let encoded = build_command(&BrickCommand::ProgramRun { path: PATH.into() }).unwrap();

    assert_eq!(encoded.packet_type, command::DIRECT_COMMAND_REPLY);
    let mut expected = vec![
        0x08, 0x00, // 8 global bytes, no locals
        0xc0, 0x08, 0x01, // FILE LOAD_IMAGE USER_SLOT
    ];
    expected.extend(lcs(PATH));
    expected.extend([0x60, 0x64]); // name -> GV0(0) size, GV0(4) address
    expected.extend([0x03, 0x01, 0x60, 0x64, 0x00]); // PROGRAM_START USER_SLOT size address debug 0
    assert_eq!(encoded.payload, expected);
}

#[test]
fn program_and_shell__reads_the_size_of_the_loaded_image_0_when_the_file_is_not_on_the_brick() {
    let cmd = BrickCommand::ProgramRun { path: PATH.into() };

    let first = parse_response(&cmd, &reply_of(&[0x2c, 0x01, 0, 0, 0x10, 0x20, 0, 0])).unwrap();
    assert_eq!(first, BrickResponse::ProgramRun { image_bytes: 300 });
    let second = parse_response(&cmd, &reply_of(&[0, 0, 0, 0, 0, 0, 0, 0])).unwrap();
    assert_eq!(second, BrickResponse::ProgramRun { image_bytes: 0 });
}

#[test]
fn program_and_shell__refuses_an_empty_path_before_anything_is_sent() {
    assert!(
        build_command(&BrickCommand::ProgramRun {
            path: String::new()
        })
        .is_err()
    );
}

#[test]
fn program_and_shell__stops_the_user_slot_only_never_slot_0_all_slots_the_brick_ui_too() {
    let encoded = build_command(&BrickCommand::ProgramStop).unwrap();
    assert_eq!(encoded.payload, [0x00, 0x00, 0x02, 0x01]);
}

#[test]
fn program_and_shell__asks_for_the_user_slots_status_and_reads_running_0x10_or_stopped_0x40() {
    let cmd = BrickCommand::ProgramStatus;

    assert_eq!(
        build_command(&cmd).unwrap().payload,
        [0x01, 0x00, 0x0c, 0x16, 0x01, 0x60]
    );
    assert_eq!(
        parse_response(&cmd, &reply_of(&[0x10])).unwrap(),
        BrickResponse::ProgramStatus {
            running: true,
            status: 0x10
        }
    );
    assert_eq!(
        parse_response(&cmd, &reply_of(&[0x40])).unwrap(),
        BrickResponse::ProgramStatus {
            running: false,
            status: 0x40
        }
    );
}

#[test]
fn program_and_shell__stops_in_an_emergency_as_the_bricks_own_power_off_does_user_slot_debug_slot_every_motor()
 {
    let encoded = build_command(&BrickCommand::ProgramEmergencyStop).unwrap();
    assert_eq!(
        encoded.payload,
        [
            0x00, 0x00, //
            0x02, 0x01, // PROGRAM_STOP USER_SLOT
            0x02, 0x04, // PROGRAM_STOP DEBUG_SLOT
            0x99, 0x0d, 0x3f, // INPUT_DEVICE STOP_ALL layer -1 (every brick in a chain)
        ]
    );
}

#[test]
fn program_and_shell__runs_a_shell_command_and_reads_its_exit_status() {
    let cmd = BrickCommand::SystemRun {
        command: "echo hi".into(),
    };

    let mut expected = vec![0x04, 0x00, 0x60];
    expected.extend(lcs("echo hi"));
    expected.push(0x60);
    assert_eq!(build_command(&cmd).unwrap().payload, expected);
    assert_eq!(
        parse_response(&cmd, &reply_of(&[0x00, 0x01, 0x00, 0x00])).unwrap(),
        BrickResponse::SystemRun { status: 256 }
    );
}

#[test]
fn program_and_shell__refuses_an_empty_shell_command_before_anything_is_sent() {
    let cmd = BrickCommand::SystemRun {
        command: "  ".into(),
    };
    assert!(build_command(&cmd).is_err());
}
