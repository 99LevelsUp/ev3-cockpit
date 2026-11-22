//! What is plugged into a port, by name.
//!
//! The firmware reports a type code (`opINPUT_DEVICE`/`GET_TYPEMODE`). The codes are the ones in
//! `bytecodes.h` of firmware 1.09d (`TYPE_*`). The names are the ones the mock configuration
//! uses, so the mock and the brick speak one vocabulary.
//!
//! A closed vocabulary cannot name a device nobody has heard of. So a code outside it is
//! `Unrecognised`, never a guess, and the raw code always travels beside the name.

/// A port occupant, from the one shared vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PeripheralType {
    NxtTouchSensor,
    NxtLightSensor,
    NxtSoundSensor,
    NxtColorSensor,
    NxtUltrasonicSensor,
    NxtTemperatureSensor,
    LargeMotor,
    MediumMotor,
    NewTachoMotor,
    TouchSensor,
    ColorSensor,
    UltrasonicSensor,
    GyroSensor,
    InfraredSensor,
    EnergyMeter,
    NxtTestSensor,
    NxtIicSensor,
    /// `TYPE_IIC_UNKNOWN` 100: an IIC device the firmware's type list does not name; it stays so
    /// (`c_input.c` 3029-3047).
    IicUnlisted,
    ThirdParty,
    /// `TYPE_TERMINAL`: the port has a console on it, not a peripheral.
    Terminal,
    /// `TYPE_UNKNOWN`: something is plugged in and still identifying; reading it blocks.
    Identifying,
    /// `TYPE_NONE`: the port is empty.
    None,
    /// `TYPE_ERROR`: something is plugged in and its type is invalid.
    Error,
    /// A code this vocabulary does not know.
    Unrecognised,
}

impl PeripheralType {
    /// The kebab-case name the mock configuration and the telemetry rows use.
    pub fn name(self) -> &'static str {
        match self {
            Self::NxtTouchSensor => "nxt-touch-sensor",
            Self::NxtLightSensor => "nxt-light-sensor",
            Self::NxtSoundSensor => "nxt-sound-sensor",
            Self::NxtColorSensor => "nxt-color-sensor",
            Self::NxtUltrasonicSensor => "nxt-ultrasonic-sensor",
            Self::NxtTemperatureSensor => "nxt-temperature-sensor",
            Self::LargeMotor => "large-motor",
            Self::MediumMotor => "medium-motor",
            Self::NewTachoMotor => "new-tacho-motor",
            Self::TouchSensor => "touch-sensor",
            Self::ColorSensor => "color-sensor",
            Self::UltrasonicSensor => "ultrasonic-sensor",
            Self::GyroSensor => "gyro-sensor",
            Self::InfraredSensor => "infrared-sensor",
            Self::EnergyMeter => "energy-meter",
            Self::NxtTestSensor => "nxt-test-sensor",
            Self::NxtIicSensor => "nxt-iic-sensor",
            Self::IicUnlisted => "iic-unlisted",
            Self::ThirdParty => "third-party",
            Self::Terminal => "terminal",
            Self::Identifying => "identifying",
            Self::None => "none",
            Self::Error => "error",
            Self::Unrecognised => "unrecognised",
        }
    }
}

/// `TYPE_*` codes, `bytecodes.h`, firmware 1.09d.
const BY_CODE: [(u8, PeripheralType); 22] = [
    (1, PeripheralType::NxtTouchSensor),
    (2, PeripheralType::NxtLightSensor),
    (3, PeripheralType::NxtSoundSensor),
    (4, PeripheralType::NxtColorSensor),
    (5, PeripheralType::NxtUltrasonicSensor),
    (6, PeripheralType::NxtTemperatureSensor),
    (7, PeripheralType::LargeMotor), // TYPE_TACHO, "EV3/NXT tacho motor"
    (8, PeripheralType::MediumMotor), // TYPE_MINITACHO
    (9, PeripheralType::NewTachoMotor), // TYPE_NEWTACHO
    (16, PeripheralType::TouchSensor),
    (29, PeripheralType::ColorSensor),
    (30, PeripheralType::UltrasonicSensor),
    (32, PeripheralType::GyroSensor),
    (33, PeripheralType::InfraredSensor),
    (99, PeripheralType::EnergyMeter),
    // TYPE_IIC_UNKNOWN: not in the firmware's IIC list, not "still identifying".
    (100, PeripheralType::IicUnlisted),
    (101, PeripheralType::NxtTestSensor),
    (123, PeripheralType::NxtIicSensor),
    (124, PeripheralType::Terminal),
    (125, PeripheralType::Identifying),
    (126, PeripheralType::None),
    (127, PeripheralType::Error),
];

const THIRD_PARTY_START: u8 = 50;
const THIRD_PARTY_END: u8 = 98;

/// The name for a type code the firmware reported.
pub fn peripheral_type_of(code: u8) -> PeripheralType {
    if let Some((_, known)) = BY_CODE.iter().find(|(candidate, _)| *candidate == code) {
        return *known;
    }
    if (THIRD_PARTY_START..=THIRD_PARTY_END).contains(&code) {
        return PeripheralType::ThirdParty;
    }
    PeripheralType::Unrecognised
}

/// The type code for a name; `None` for a name that stands for a range or for no code.
pub fn type_code_of(name: PeripheralType) -> Option<u8> {
    BY_CODE
        .iter()
        .find(|(_, candidate)| *candidate == name)
        .map(|(code, _)| *code)
}
