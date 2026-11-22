//! Bluetooth on Windows: Winsock RFCOMM, SDP presence, discovery, WinRT pairing and forget.

pub mod discovery;
pub mod forget;
pub mod pairing;
pub mod provider;
pub mod sdp;
pub mod winsock;

pub use provider::{BluetoothPlatform, BtWindowsSettings, SystemBluetooth, WindowsBtProvider};
