//! EV3 packets, bytecode, commands and replies, with no I/O.
//!
//! A port of the TypeScript protocol layer, rule by rule. Nothing here opens a link, reads a
//! clock or waits: bytes in, bytes out.

pub mod bytecode;
pub mod commands;
pub mod error;
pub mod packet;
pub mod peripherals;
pub mod responses;

pub use commands::{BrickCommand, EncodedCommand, build_command};
pub use error::ProtocolError;
pub use packet::{Ev3Packet, decode_ev3_packet, encode_ev3_packet, extract_length_prefixed_packet};
pub use peripherals::{PeripheralType, peripheral_type_of, type_code_of};
pub use responses::{BrickResponse, parse_response};
