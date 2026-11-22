//! The daisy chain below a brick, and what a brick in it can do: the one place that decides it.
//!
//! Nothing here is asked of the brick, because the stock firmware offers nothing to ask: no host
//! operation that reads a name, files or programs takes a layer (`opCOM_GET` and the system
//! commands have none), and a member's motor position does not cross the chain. So each answer is
//! fixed from what was measured. A firmware that answers one of these for a member gets its probe
//! added here, and the answer is then read from the brick; the shape clients see stays.
//!
//! The chain itself is derived, never stored: it is whatever the brick's chain depth, as the
//! telemetry last read it, says, so it cannot outlive the wiring it describes. Unknown until the
//! depth has been read, which is not the same as a brick with nothing below it.

use ev3_contract::{ChainMember, ChainMemberCapabilities, ContractChain};

/// Layers on which a motor's type read right in every one of three rewirings, with motors of
/// different types (firmware 1.10E). Layer 3 was out of reach of three bricks, and an earlier
/// reading once got a layer-2 motor wrong, so no other layer is vouched for.
const MOTOR_TYPES_MEASURED: [u8; 2] = [1, 2];

/// What the brick on `layer` below the master can do.
pub fn capabilities_of(layer: u8) -> ChainMemberCapabilities {
    ChainMemberCapabilities {
        sensors: true,
        motor_types: MOTOR_TYPES_MEASURED.contains(&layer),
        motor_readout: false,
        files: false,
        programs: false,
        name: false,
    }
}

/// The chain depth as the telemetry read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainDepth {
    /// How many bricks hang below the master.
    pub depth: u8,
    /// The value is an old reading the telemetry could not refresh.
    pub stale: bool,
}

/// The chain below `brick_id`: one member per layer down to the depth; `read` false and no
/// members while the depth is unknown.
pub fn chain_of(brick_id: &str, depth: Option<ChainDepth>) -> ContractChain {
    let members = depth
        .map(|d| {
            (1..=d.depth)
                .map(|layer| ChainMember {
                    layer: u64::from(layer),
                    capabilities: capabilities_of(layer),
                })
                .collect()
        })
        .unwrap_or_default();
    ContractChain {
        brick_id: brick_id.to_owned(),
        members,
        read: depth.is_some(),
        stale: depth.is_some_and(|d| d.stale),
    }
}
