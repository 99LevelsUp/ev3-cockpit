//! Base64 (RFC 4648, standard alphabet, padded): how file content crosses the wire. The client
//! reads it with the same code, from the contract crate.

pub use ev3_contract::base64::{decode, encode};
