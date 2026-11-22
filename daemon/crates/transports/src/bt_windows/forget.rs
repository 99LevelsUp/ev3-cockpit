//! Forgetting a brick on Windows: removing its pairing, and naming what Windows keeps after.

use crate::bt::describe_address;
use crate::provider::ForgetResidue;

/// `ERROR_NOT_FOUND`, 1168: `BluetoothRemoveDevice` found no such device.
pub const ERROR_NOT_FOUND: u32 = 1168;

/// Reads what `BluetoothRemoveDevice` answered. A device Windows does not have is already
/// unpaired, which is what the caller asked for.
pub fn unpair_result(code: u32) -> Result<(), String> {
    match code {
        0 | ERROR_NOT_FOUND => Ok(()),
        code => Err(format!(
            "Windows refused to remove the pairing (error {code})."
        )),
    }
}

/// What Windows keeps of a brick after the unpair. Reported, never removed: the registry key is
/// owned by SYSTEM, and the cockpit does not work around that.
pub fn windows_residue(mac: &str) -> Vec<ForgetResidue> {
    // Twelve hex digits, lower case, no separators: how the subkeys under `Parameters\Devices`
    // are spelled.
    let subkey: String = mac
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect::<String>()
        .to_ascii_lowercase();
    vec![
        ForgetResidue {
            location: format!(
                "HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\{subkey}"
            ),
            // Measured: the key survives BluetoothRemoveDevice and Settings' own Remove.
            reason: "Windows keeps this key after unpairing; it is owned by SYSTEM and the \
                     cockpit does not change it."
                .into(),
        },
        ForgetResidue {
            location: format!(
                "Windows' in-memory Bluetooth device record for {}",
                describe_address(mac)
            ),
            reason: "Windows keeps it until it next restarts; until then a scan may still list \
                     the brick, unpaired."
                .into(),
        },
    ]
}

/// Removes the pairing of the device at `address`; Windows' own code.
pub fn remove_device(address: u64) -> u32 {
    use windows_sys::Win32::Devices::Bluetooth::{
        BLUETOOTH_ADDRESS, BLUETOOTH_ADDRESS_0, BluetoothRemoveDevice,
    };
    let target = BLUETOOTH_ADDRESS {
        Anonymous: BLUETOOTH_ADDRESS_0 { ullLong: address },
    };
    // SAFETY: `target` is a live BLUETOOTH_ADDRESS for the duration of the call.
    unsafe { BluetoothRemoveDevice(&raw const target) }
}
