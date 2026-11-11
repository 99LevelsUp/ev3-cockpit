/**
 * Every system command and `opFILE` / `opFILENAME` subcode of firmware 1.09d is declared
 * (IMPLEMENTATION_PLAN 4.6.13), so a capability the survey found — `BEGIN_GETFILE` for tailing a
 * log a program is writing, mailboxes, the trusted Bluetooth PIN — is not lost again. Values from
 * `c_com/source/c_com.h` 91–107 and `lms2012/source/bytecodes.h` (opFILE and opFILENAME tables).
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { EV3_SYSTEM, FILE_SUB, FILENAME_SUB } from '../protocol/ev3Packet';

describe('Firmware codes are declared (4.6.13)', () => {
	it('declares every system command', () => {
		assert.deepEqual({ ...EV3_SYSTEM }, {
			BEGIN_DOWNLOAD: 0x92, CONTINUE_DOWNLOAD: 0x93, BEGIN_UPLOAD: 0x94, CONTINUE_UPLOAD: 0x95,
			BEGIN_GETFILE: 0x96, CONTINUE_GETFILE: 0x97, CLOSE_FILEHANDLE: 0x98, LIST_FILES: 0x99,
			CONTINUE_LIST_FILES: 0x9a, CREATE_DIR: 0x9b, DELETE_FILE: 0x9c, LIST_OPEN_HANDLES: 0x9d,
			WRITEMAILBOX: 0x9e, BLUETOOTHPIN: 0x9f, ENTERFWUPDATE: 0xa0, SETBUNDLEID: 0xa1, SETBUNDLESEEDID: 0xa2,
		});
	});

	it('declares every opFILE subcode', () => {
		assert.deepEqual({ ...FILE_SUB }, {
			OPEN_APPEND: 0, OPEN_READ: 1, OPEN_WRITE: 2, READ_VALUE: 3, WRITE_VALUE: 4, READ_TEXT: 5, WRITE_TEXT: 6,
			CLOSE: 7, LOAD_IMAGE: 8, GET_HANDLE: 9, MAKE_FOLDER: 10, GET_POOL: 11, SET_LOG_SYNC_TIME: 12,
			GET_FOLDERS: 13, GET_LOG_SYNC_TIME: 14, GET_SUBFOLDER_NAME: 15, WRITE_LOG: 16, CLOSE_LOG: 17,
			GET_IMAGE: 18, GET_ITEM: 19, GET_CACHE_FILES: 20, PUT_CACHE_FILE: 21, GET_CACHE_FILE: 22,
			DEL_CACHE_FILE: 23, DEL_SUBFOLDER: 24, GET_LOG_NAME: 25, OPEN_LOG: 27, READ_BYTES: 28,
			WRITE_BYTES: 29, REMOVE: 30, MOVE: 31,
		});
	});

	it('declares every opFILENAME subcode', () => {
		assert.deepEqual({ ...FILENAME_SUB }, {
			EXIST: 16, TOTALSIZE: 17, SPLIT: 18, MERGE: 19, CHECK: 20, PACK: 21, UNPACK: 22, GET_FOLDERNAME: 23,
		});
	});
});
