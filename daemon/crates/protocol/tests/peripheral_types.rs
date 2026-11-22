//! Ports of `src/__tests__/peripheralTypes.test.ts`, plus the one peripheral assertion of
//! `portState.test.ts` (code 100).

#![allow(non_snake_case)] // test names are <describe>__<it>, mapping to the TypeScript tests

use ev3_protocol::PeripheralType as P;
use ev3_protocol::{peripheral_type_of, type_code_of};

#[test]
fn peripheral_vocabulary__names_the_ev3_devices_by_the_firmwares_codes() {
    assert_eq!(peripheral_type_of(7), P::LargeMotor);
    assert_eq!(peripheral_type_of(8), P::MediumMotor);
    assert_eq!(peripheral_type_of(16), P::TouchSensor);
    assert_eq!(peripheral_type_of(29), P::ColorSensor);
    assert_eq!(peripheral_type_of(30), P::UltrasonicSensor);
    assert_eq!(peripheral_type_of(32), P::GyroSensor);
    assert_eq!(peripheral_type_of(33), P::InfraredSensor);
}

#[test]
fn peripheral_vocabulary__names_the_port_states_the_firmware_reports_instead_of_a_device() {
    assert_eq!(peripheral_type_of(124), P::Terminal);
    assert_eq!(peripheral_type_of(125), P::Identifying);
    assert_eq!(peripheral_type_of(126), P::None);
    assert_eq!(peripheral_type_of(127), P::Error);
}

#[test]
fn peripheral_vocabulary__names_a_third_party_device_by_its_range_and_anything_else_as_unrecognised_never_guessing()
 {
    assert_eq!(peripheral_type_of(50), P::ThirdParty);
    assert_eq!(peripheral_type_of(98), P::ThirdParty);
    assert_eq!(peripheral_type_of(42), P::Unrecognised);
    assert_eq!(peripheral_type_of(200), P::Unrecognised);
}

#[test]
fn peripheral_vocabulary__maps_every_name_the_mock_configuration_uses_back_to_a_code() {
    for name in [
        P::LargeMotor,
        P::MediumMotor,
        P::TouchSensor,
        P::ColorSensor,
        P::UltrasonicSensor,
    ] {
        let code = type_code_of(name).unwrap_or_else(|| panic!("{} has no code", name.name()));
        assert_eq!(peripheral_type_of(code), name);
    }
    assert_eq!(type_code_of(P::ThirdParty), None, "a range is not one code");
}

#[test]
fn port_state__treats_an_iic_device_the_firmwares_list_does_not_name_100_as_a_known_device() {
    assert_eq!(peripheral_type_of(100), P::IicUnlisted);
}

#[test]
fn peripheral_vocabulary__names_are_the_kebab_case_ones_the_mock_uses() {
    // The names travel to the telemetry rows and the mock configuration, so their spelling is
    // part of the vocabulary. Spelled out from `peripheralTypes.ts`.
    let table = [
        (P::NxtTouchSensor, "nxt-touch-sensor"),
        (P::NxtLightSensor, "nxt-light-sensor"),
        (P::NxtSoundSensor, "nxt-sound-sensor"),
        (P::NxtColorSensor, "nxt-color-sensor"),
        (P::NxtUltrasonicSensor, "nxt-ultrasonic-sensor"),
        (P::NxtTemperatureSensor, "nxt-temperature-sensor"),
        (P::LargeMotor, "large-motor"),
        (P::MediumMotor, "medium-motor"),
        (P::NewTachoMotor, "new-tacho-motor"),
        (P::TouchSensor, "touch-sensor"),
        (P::ColorSensor, "color-sensor"),
        (P::UltrasonicSensor, "ultrasonic-sensor"),
        (P::GyroSensor, "gyro-sensor"),
        (P::InfraredSensor, "infrared-sensor"),
        (P::EnergyMeter, "energy-meter"),
        (P::NxtTestSensor, "nxt-test-sensor"),
        (P::NxtIicSensor, "nxt-iic-sensor"),
        (P::IicUnlisted, "iic-unlisted"),
        (P::ThirdParty, "third-party"),
        (P::Terminal, "terminal"),
        (P::Identifying, "identifying"),
        (P::None, "none"),
        (P::Error, "error"),
        (P::Unrecognised, "unrecognised"),
    ];
    for (variant, name) in table {
        assert_eq!(variant.name(), name);
    }
    // And the codes of the table in `peripheralTypes.ts`.
    let codes = [
        (1, P::NxtTouchSensor),
        (2, P::NxtLightSensor),
        (3, P::NxtSoundSensor),
        (4, P::NxtColorSensor),
        (5, P::NxtUltrasonicSensor),
        (6, P::NxtTemperatureSensor),
        (9, P::NewTachoMotor),
        (99, P::EnergyMeter),
        (101, P::NxtTestSensor),
        (123, P::NxtIicSensor),
    ];
    for (code, variant) in codes {
        assert_eq!(peripheral_type_of(code), variant);
        assert_eq!(type_code_of(variant), Some(code));
    }
    assert_eq!(type_code_of(P::Unrecognised), None);
}
