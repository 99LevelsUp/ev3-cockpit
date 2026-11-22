//! The daisy chain below a brick, from the chain depth the telemetry read: one member per layer,
//! each with what it can do, fixed from what was measured.

use ev3_runtime::{ChainDepth, chain_of};

fn depth(depth: u8, stale: bool) -> Option<ChainDepth> {
    Some(ChainDepth { depth, stale })
}

#[test]
fn knows_nothing_of_a_chain_whose_depth_has_not_been_read_unknown_not_empty() {
    let chain = chain_of("AAA", None);
    assert!(!chain.read);
    assert!(chain.members.is_empty());
    assert_eq!(chain.brick_id, "AAA");
}

#[test]
fn knows_a_brick_with_nothing_below_it() {
    let chain = chain_of("AAA", depth(0, false));
    assert!(chain.read);
    assert!(chain.members.is_empty());
    assert!(!chain.stale);
}

#[test]
fn lists_one_member_per_layer_down_to_the_depth_each_with_what_it_can_do() {
    let chain = chain_of("AAA", depth(2, false));
    let layers: Vec<u64> = chain.members.iter().map(|m| m.layer).collect();
    assert_eq!(layers, [1, 2]);
    for member in &chain.members {
        let can = &member.capabilities;
        assert!(can.sensors, "sensor types and values cross the chain");
        assert!(
            !can.motor_readout,
            "a motor position never crosses the chain"
        );
        assert!(!can.files);
        assert!(!can.programs);
        assert!(!can.name);
    }
}

#[test]
fn vouches_for_motor_types_only_on_the_layers_measured_not_on_layer_three() {
    let chain = chain_of("AAA", depth(3, false));
    let motor_types: Vec<bool> = chain
        .members
        .iter()
        .map(|m| m.capabilities.motor_types)
        .collect();
    assert_eq!(motor_types, [true, true, false]);
}

#[test]
fn says_when_the_depth_it_was_built_from_is_stale() {
    assert!(chain_of("AAA", depth(1, true)).stale);
}
