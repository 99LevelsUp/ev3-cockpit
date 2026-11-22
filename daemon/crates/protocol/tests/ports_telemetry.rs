//! Ports of `src/__tests__/portsTelemetry.test.ts`: the ports command and its parser. Names are
//! `<describe>__<it>` in snake case.

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::PeripheralType as P;
use ev3_protocol::packet::{opcode, reply};
use ev3_protocol::responses::PortReading;
use ev3_protocol::{BrickCommand, BrickResponse, Ev3Packet, build_command, parse_response};

/// A ports reply: 8 bytes sensor type/mode, 8 motor, 16 sensor SI, 16 tacho.
#[derive(Default)]
struct PortsPayload {
    sensor_types: Option<[u8; 4]>,
    motor_types: Option<[u8; 4]>,
    sensor_values: [f32; 4],
    tachos: [i32; 4],
}

impl PortsPayload {
    fn bytes(&self) -> Vec<u8> {
        let mut payload = vec![0u8; 48];
        let sensor_types = self.sensor_types.unwrap_or([126; 4]);
        let motor_types = self.motor_types.unwrap_or([126; 4]);
        for i in 0..4 {
            payload[i * 2] = sensor_types[i];
            payload[8 + i * 2] = motor_types[i];
            payload[16 + i * 4..20 + i * 4].copy_from_slice(&self.sensor_values[i].to_le_bytes());
            payload[32 + i * 4..36 + i * 4].copy_from_slice(&self.tachos[i].to_le_bytes());
        }
        payload
    }
}

fn parse_ports(payload: &[u8]) -> (Vec<PortReading>, Vec<PortReading>) {
    let packet = Ev3Packet {
        message_counter: 1,
        packet_type: reply::DIRECT_REPLY,
        payload,
    };
    match parse_response(&BrickCommand::Ports, &packet).unwrap() {
        BrickResponse::Ports {
            motor_ports,
            sensor_ports,
        } => (sensor_ports, motor_ports),
        other => panic!("expected ports, got {other:?}"),
    }
}

#[test]
fn ports_command__reads_sensors_with_op_input_readsi_not_op_input_read() {
    // 0x9A is opINPUT_READ, whose output parameter is PAR8: a single percent byte.
    let payload = build_command(&BrickCommand::Ports).unwrap().payload;
    assert!(
        payload.contains(&opcode::INPUT_READ_SI),
        "the ports command must contain the SI read opcode"
    );
    assert_eq!(
        opcode::INPUT_READ_SI,
        0x9d,
        "opINPUT_READSI per the firmware opcode table"
    );
    assert!(
        !payload.contains(&0x9a),
        "0x9A is opINPUT_READ and returns one byte, not a float"
    );
}

#[test]
fn ports_response_device_types__names_the_codes_the_bricks_actually_report() {
    let payload = PortsPayload {
        sensor_types: Some([16, 29, 30, 32]),
        ..Default::default()
    };
    let (sensors, _) = parse_ports(&payload.bytes());
    let names: Vec<_> = sensors.iter().map(|p| p.peripheral_type).collect();
    assert_eq!(
        names,
        [
            Some(P::TouchSensor),
            Some(P::ColorSensor),
            Some(P::UltrasonicSensor),
            Some(P::GyroSensor)
        ]
    );
}

#[test]
fn ports_response_device_types__separates_the_nxt_touch_sensor_from_the_ev3_one() {
    let payload = PortsPayload {
        sensor_types: Some([1, 33, 126, 126]),
        ..Default::default()
    };
    let (sensors, _) = parse_ports(&payload.bytes());
    assert_eq!(sensors[0].peripheral_type, Some(P::NxtTouchSensor));
    assert_eq!(sensors[1].peripheral_type, Some(P::InfraredSensor));
}

#[test]
fn ports_response_device_types__names_both_motor_types() {
    let payload = PortsPayload {
        motor_types: Some([7, 8, 126, 126]),
        ..Default::default()
    };
    let (_, motors) = parse_ports(&payload.bytes());
    let names: Vec<_> = motors.iter().map(|p| p.peripheral_type).collect();
    assert_eq!(
        names,
        [Some(P::LargeMotor), Some(P::MediumMotor), None, None]
    );
}

#[test]
fn ports_response_device_types__reports_an_unrecognised_code_rather_than_hiding_it_with_the_code_beside_the_name()
 {
    let payload = PortsPayload {
        sensor_types: Some([42, 126, 126, 126]),
        motor_types: Some([7, 126, 126, 126]),
        ..Default::default()
    };
    let (sensors, motors) = parse_ports(&payload.bytes());
    assert_eq!(sensors[0].peripheral_type, Some(P::Unrecognised));
    assert_eq!(sensors[0].type_code, Some(42));
    assert_eq!(motors[0].type_code, Some(7));
    assert_eq!(sensors[1].type_code, None, "an empty port carries no code");
}

#[test]
fn ports_response_device_types__speaks_the_one_vocabulary_the_mock_and_the_telemetry_rows_speak() {
    let payload = PortsPayload {
        sensor_types: Some([99, 126, 126, 126]),
        ..Default::default()
    };
    let (sensors, _) = parse_ports(&payload.bytes());
    assert_eq!(sensors[0].peripheral_type, Some(P::EnergyMeter));
}

#[test]
fn ports_response_status__distinguishes_a_device_that_is_still_identifying_itself_from_an_empty_port()
 {
    let payload = PortsPayload {
        sensor_types: Some([125, 126, 127, 30]),
        sensor_values: [42.0, 42.0, 42.0, 17.5],
        motor_types: Some([125, 126, 127, 7]),
        tachos: [42, 42, 42, -66],
    };
    let (sensors, motors) = parse_ports(&payload.bytes());

    assert_eq!(sensors[0].peripheral_type, Some(P::Identifying));
    assert_eq!(sensors[1].peripheral_type, None, "empty port has no type");
    assert_eq!(sensors[2].peripheral_type, Some(P::Error));

    assert_eq!(motors[0].peripheral_type, Some(P::Identifying));
    assert_eq!(motors[0].value, None);
    assert_eq!(motors[2].peripheral_type, Some(P::Error));
    assert_eq!(motors[2].value, None);
    assert_eq!(motors[3].value, Some(-66.0), "a real motor keeps its tacho");

    assert_eq!(sensors[0].value, None);
    assert_eq!(sensors[1].value, None);
    assert_eq!(sensors[2].value, None);
    assert_eq!(
        sensors[3].value,
        Some(17.5),
        "a real device keeps its reading"
    );
}

#[test]
fn ports_response_status__drops_a_nan_reading_instead_of_passing_it_on() {
    let payload = PortsPayload {
        sensor_types: Some([29, 126, 126, 126]),
        ..Default::default()
    };
    let mut bytes = payload.bytes();
    bytes[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
    let (sensors, _) = parse_ports(&bytes);

    assert_eq!(
        sensors[0].peripheral_type,
        Some(P::ColorSensor),
        "the device is still there"
    );
    assert_eq!(sensors[0].value, None);
}

#[test]
fn ports_response_status__drops_a_data32_nan_tacho_and_the_unit_with_it() {
    let payload = PortsPayload {
        motor_types: Some([7, 8, 126, 126]),
        tachos: [i32::MIN, -66, 0, 0],
        ..Default::default()
    };
    let (_, motors) = parse_ports(&payload.bytes());

    assert_eq!(motors[0].value, None);
    assert_eq!(motors[0].unit, None, "no reading means no unit either");
    assert_eq!(
        motors[1].value,
        Some(-66.0),
        "a negative tacho is a real position"
    );
    assert_eq!(motors[1].unit, Some("deg"));
}

#[test]
fn ports_response_status__never_reports_a_value_for_an_empty_port() {
    let payload = PortsPayload {
        sensor_values: [1.0, 2.0, 3.0, 4.0],
        tachos: [10, 20, 30, 40],
        ..Default::default()
    };
    let (sensors, motors) = parse_ports(&payload.bytes());

    for port in sensors.iter().chain(motors.iter()) {
        assert_eq!(port.peripheral_type, None);
        assert_eq!(port.value, None);
    }
}
