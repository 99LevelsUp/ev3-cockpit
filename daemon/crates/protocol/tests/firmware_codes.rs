//! Ports of `src/__tests__/firmwareCodes.test.ts`: every system command and `opFILE` /
//! `opFILENAME` subcode of firmware 1.09d is declared. Expected values are the TypeScript's.

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::packet::{file_sub, filename_sub, system};

#[test]
fn firmware_codes__declares_every_system_command() {
    let declared = [
        system::BEGIN_DOWNLOAD,
        system::CONTINUE_DOWNLOAD,
        system::BEGIN_UPLOAD,
        system::CONTINUE_UPLOAD,
        system::BEGIN_GETFILE,
        system::CONTINUE_GETFILE,
        system::CLOSE_FILEHANDLE,
        system::LIST_FILES,
        system::CONTINUE_LIST_FILES,
        system::CREATE_DIR,
        system::DELETE_FILE,
        system::LIST_OPEN_HANDLES,
        system::WRITEMAILBOX,
        system::BLUETOOTHPIN,
        system::ENTERFWUPDATE,
        system::SETBUNDLEID,
        system::SETBUNDLESEEDID,
    ];
    assert_eq!(
        declared,
        [
            0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
            0xa0, 0xa1, 0xa2
        ]
    );
}

#[test]
fn firmware_codes__declares_every_op_file_subcode() {
    let declared = [
        file_sub::OPEN_APPEND,
        file_sub::OPEN_READ,
        file_sub::OPEN_WRITE,
        file_sub::READ_VALUE,
        file_sub::WRITE_VALUE,
        file_sub::READ_TEXT,
        file_sub::WRITE_TEXT,
        file_sub::CLOSE,
        file_sub::LOAD_IMAGE,
        file_sub::GET_HANDLE,
        file_sub::MAKE_FOLDER,
        file_sub::GET_POOL,
        file_sub::SET_LOG_SYNC_TIME,
        file_sub::GET_FOLDERS,
        file_sub::GET_LOG_SYNC_TIME,
        file_sub::GET_SUBFOLDER_NAME,
        file_sub::WRITE_LOG,
        file_sub::CLOSE_LOG,
        file_sub::GET_IMAGE,
        file_sub::GET_ITEM,
        file_sub::GET_CACHE_FILES,
        file_sub::PUT_CACHE_FILE,
        file_sub::GET_CACHE_FILE,
        file_sub::DEL_CACHE_FILE,
        file_sub::DEL_SUBFOLDER,
        file_sub::GET_LOG_NAME,
        file_sub::OPEN_LOG,
        file_sub::READ_BYTES,
        file_sub::WRITE_BYTES,
        file_sub::REMOVE,
        file_sub::MOVE,
    ];
    // 26 is unused in firmware 1.09d, so the list skips it.
    assert_eq!(
        declared,
        [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 27, 28, 29, 30, 31
        ]
    );
}

#[test]
fn firmware_codes__declares_every_op_filename_subcode() {
    let declared = [
        filename_sub::EXIST,
        filename_sub::TOTALSIZE,
        filename_sub::SPLIT,
        filename_sub::MERGE,
        filename_sub::CHECK,
        filename_sub::PACK,
        filename_sub::UNPACK,
        filename_sub::GET_FOLDERNAME,
    ];
    assert_eq!(declared, [16, 17, 18, 19, 20, 21, 22, 23]);
}
