//! Bluetooth on Linux through BlueZ: zbus for discovery, pairing and the radio, raw RFCOMM and
//! L2CAP sockets for data and presence.
//!
//! - [`bluez`]: the operations asked of BlueZ, behind one trait, and BlueZ's objects kept;
//! - [`system_bus`]: that trait over the real system bus;
//! - [`session`]: one bus connection, BlueZ's owner tracked across restarts;
//! - [`agent`]: pairing with an agent of the cockpit's own;
//! - [`rfcomm`]: the data path over a kernel RFCOMM socket;
//! - [`presence`]: the L2CAP presence probe and the discovery window;
//! - [`radio_watch`]: an adapter that stopped answering, restarted;
//! - [`access`]: what the provider needs from the runtime, and the bluetooth-group question;
//! - [`provider`]: the provider itself.

pub mod access;
pub mod agent;
pub mod bluez;
pub mod presence;
pub mod provider;
pub mod radio_watch;
pub mod rfcomm;
pub mod session;
pub mod system_bus;

pub use provider::{BtLinuxParts, BtLinuxSettings, LinuxBtProvider};
