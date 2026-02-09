// Empty EV3 bytecode program fixture captured from stock brick:
// /home/root/lms2012/prjs/Empty/Empty.rbf
//
// Decoded using official EV3 VM layout and opcodes:
// - resources/01_LEGO_Official_Developer_Kits/EV3_Firmware_Developer_Kit.md
// - resources/11_Firmware/ev3_firmware_109d_developer_edition/lmssrc/adk/lmststasm/lmstypes.h
// - resources/11_Firmware/ev3_firmware_109d_developer_edition/lmssrc/adk/lmsasm/bytecodes.h
// - resources/11_Firmware/ev3_firmware_109d_developer_edition/lmssrc/adk/lmsasm/bytecodes.c
export const EMPTY_RBF_BYTES = new Uint8Array([
	// IMGHEAD
	// Sign='LEGO', ImageSize=176, VersionInfo=0, NumberOfObjects=4, GlobalBytes=34
	0x4c, 0x45, 0x47, 0x4f, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x22, 0x00, 0x00, 0x00,

	// OBJHEAD #1 (VMTHREAD): Offset=64, Owner=0, Trigger=0, LocalBytes=0
	0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	// OBJHEAD #2 (SUBCALL): Offset=118, Owner=0, Trigger=1, LocalBytes=1
	0x76, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
	// OBJHEAD #3 (VMTHREAD): Offset=125, Owner=0, Trigger=0, LocalBytes=1
	0x7d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
	// OBJHEAD #4 (VMTHREAD): Offset=154, Owner=0, Trigger=0, LocalBytes=8
	0x9a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,

	// Object #1 @64
	0xa2, 0x00, 0x0f,                               // opOUTPUT_RESET(LC0(0)=LAYER_0, LC0(15)=A|B|C|D)         // reset all outputs on layer 0
	0x99, 0x0a, 0x3f,                               // opINPUT_DEVICE(LC0(10)=CLR_ALL, LC0(-1)=all ports)      // clear configuration of all input ports
	0x87, 0x6c,                                     // opTIMER_READ(GV0(12))                                    // store current timer in global[12]
	0x33, 0x81, 0x7b, 0x70,                         // opMOVE8_F(LC1(123), GV0(16))                             // global[16] = 123.0f
	0x33, 0x81, 0x32, 0x74,                         // opMOVE8_F(LC1(50), GV0(20))                              // global[20] = 50.0f
	0x33, 0x81, 0x64, 0x78,                         // opMOVE8_F(LC1(100), GV0(24))                             // global[24] = 100.0f
	0xc1, 0x04, 0x10, 0x7c,                         // opARRAY(LC0(4)=CREATEF, LC0(16), GV0(28))                // create float array[16] in global[28]
	0xc1, 0x06, 0x7c, 0x83, 0x00, 0x00, 0x96, 0x42, // opARRAY(LC0(6)=FILL, GV0(28), LC4F(70.0))                // fill array in global[28] with value 70.0
	0xc1, 0x01, 0x10, 0x7e,                         // opARRAY(LC0(1)=CREATE8, LC0(16), GV0(30))                // create byte array[16] in global[30]
	0xc1, 0x06, 0x7e, 0x01,                         // opARRAY(LC0(6)=FILL, GV0(30), LC0(1))                    // fill byte array in global[30] with ones
	0x30, 0x01, 0xe1, 0x20,                         // opMOVE8_8(LC0(1), GV1(32))                               // global8[32] = 1
	0x30, 0x01, 0xe1, 0x21,                         // opMOVE8_8(LC0(1), GV1(33))                               // global8[33] = 1
	0x05, 0x03,                                     // opOBJECT_START(LC0(3))                                   // start object #3
	0x0b,                                           // opSLEEP()                                                 // put current thread to sleep
	0x40, 0x3d,                                     // opJR(LC0(-3))                                             // jump back to SLEEP (infinite loop)
	0x0a,                                           // opOBJECT_END()                                            // end of object

	// Object #2 @118 (SUBCALL)
	0x01,                                           // opNOP()                                                   // do nothing (padding)
	0x40, 0x30,                                     // opJR(LC0(-16))                                            // jump by -16 bytes (inner loop handling)
	0x01,                                           // opNOP()                                                   // do nothing (alignment/padding)
	0x40, 0x08,                                     // opJR(LC0(8))                                              // jump forward by 8 bytes
	0x0a,                                           // opOBJECT_END()                                            // return from subcall

	// Object #3 @125
	0x09, 0x02, 0x01, 0x40,                         // opCALL(LC0(2), PARNO(1), LV0(0))                         // call subcall #2 and store result in local[0]
	0x41, 0x40, 0x39,                               // opJR_FALSE(LV0(0), LC0(-7))                              // if local[0] == false, jump back
	0x26, 0x68, 0x83, 0xfe, 0xff, 0xff, 0xff, 0x68, // opAND32(GV0(8), LC4(-2), GV0(8))                          // global[8] &= 0xFFFFFFFE (clear bit 0)
	0x05, 0x04,                                     // opOBJECT_START(LC0(4))                                   // start object #4
	0x07, 0x04,                                     // opOBJECT_WAIT(LC0(4))                                    // wait for object #4 to finish
	0x09, 0x02, 0x01, 0x40,                         // opCALL(LC0(2), PARNO(1), LV0(0))                         // call subcall #2 again
	0x42, 0x40, 0x39,                               // opJR_TRUE(LV0(0), LC0(-7))                               // if local[0] == true, jump back
	0x40, 0x24,                                     // opJR(LC0(-28))                                            // repeat main loop of object #3
	0x0a,                                           // opOBJECT_END()                                            // end of object

	// Object #4 @154
	0x12, 0x60, 0x01, 0x60,                         // opADD32(GV0(0), LC0(1), GV0(0))                          // global[0] = global[0] + 1
	0x3a, 0x01, 0x40,                               // opMOVE32_32(LC0(1), LV0(0))                              // local[0] = 1
	0x26, 0x40, 0x68, 0x44,                         // opAND32(LV0(0), GV0(8), LV0(4))                          // local[4] = local[0] & global[8]
	0x72, 0x44, 0x00, 0x02,                         // opJR_NEQ32(LV0(4), LC0(0), LC0(2))                       // if local[4] != 0, skip PROGRAM_STOP
	0x02, 0x3f,                                     // opPROGRAM_STOP(LC0(-1))                                  // stop the entire program
	0x12, 0x64, 0x01, 0x64,                         // opADD32(GV0(4), LC0(1), GV0(4))                          // global[4] = global[4] + 1
	0x0a                                            // opOBJECT_END()                                            // end of object
]);

export const EMPTY_RBF_META = {
	sourcePath: '/home/root/lms2012/prjs/Empty/Empty.rbf',
	byteLength: 176
} as const;
