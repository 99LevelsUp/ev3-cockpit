//! Protocol limits asserted by the transfer tests: `fileTransfer.test.ts` (continuation chunk)
//! and `transferLedger.test.ts` (slot numbers past the firmware's table).

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::BrickCommand;
use ev3_protocol::build_command;

const HANDLE: u8 = 3;

#[test]
fn file_transfer_writes__encodes_a_continuation_chunk_over_the_stock_1017_and_refuses_one_past_the_protocol()
 {
    let ok = BrickCommand::FsContinueWrite {
        handle: HANDLE,
        chunk: vec![0; 4089],
    };
    assert!(build_command(&ok).is_ok());
    let too_big = BrickCommand::FsContinueWrite {
        handle: HANDLE,
        chunk: vec![0; 0x10000],
    };
    let err = build_command(&too_big).unwrap_err();
    assert!(err.message().contains("protocol"), "{err}");
}

#[test]
fn transfer_ledger__never_puts_a_slot_number_past_the_firmwares_table_on_the_wire() {
    let close = |handle| BrickCommand::FsCloseHandle { handle };
    let err = build_command(&close(64)).unwrap_err();
    assert!(err.message().contains("0..63"), "{err}");
    let err = build_command(&BrickCommand::FsContinueWrite {
        handle: 200,
        chunk: vec![0; 1],
    })
    .unwrap_err();
    assert!(err.message().contains("0..63"), "{err}");
    assert!(build_command(&close(63)).is_ok());
}
