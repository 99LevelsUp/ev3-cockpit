//! Brick keys, ported rule by rule from the TypeScript core, and which providers a daemon may
//! build on which channel.

use ev3_transports::{
    BrickKey, ChannelKind, DaemonMode, ErrorCode, ProviderSource, Transport, provider_source,
};

#[test]
fn a_key_is_the_transport_a_separator_and_the_trimmed_identifier() {
    let key = BrickKey::new(Transport::Bt, "  00:16:53:F0:0A:0A ").unwrap();
    assert_eq!(key.as_str(), "bt:00:16:53:F0:0A:0A");
    assert_eq!(key.transport(), Transport::Bt);
    assert_eq!(key.id(), "00:16:53:F0:0A:0A");
}

#[test]
fn a_blank_identifier_is_refused() {
    let error = BrickKey::new(Transport::Usb, "   ").unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidBrickKey);
    assert_eq!(
        error.message,
        "Cannot build a brick key for usb from an empty identifier."
    );
}

#[test]
fn the_identifiers_case_is_kept() {
    let key = BrickKey::new(Transport::Mock, "MockBrick-a").unwrap();
    assert_eq!(key.id(), "MockBrick-a");
}

#[test]
fn parsing_splits_on_the_first_separator_only() {
    let key = BrickKey::parse("bt:00:16:53:F0:0B:0B").unwrap();
    assert_eq!(key.transport(), Transport::Bt);
    assert_eq!(key.id(), "00:16:53:F0:0B:0B");
}

#[test]
fn a_key_without_a_known_transport_or_an_identifier_is_refused() {
    for bad in ["", "usb", "usb:", ":abc", "serial:123", "USB:001653F00A0A"] {
        let error = BrickKey::parse(bad).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidBrickKey, "{bad}");
    }
}

#[test]
fn one_brick_has_one_hardware_identity_on_every_transport() {
    let usb = BrickKey::parse("usb:001653F00C0C").unwrap();
    let bt = BrickKey::parse("bt:00:16:53:F0:0C:0C").unwrap();
    let tcp = BrickKey::parse("tcp:001653f00c0c").unwrap();
    assert_eq!(usb.hardware_id().as_deref(), Some("001653F00C0C"));
    assert_eq!(bt.hardware_id(), usb.hardware_id());
    assert_eq!(tcp.hardware_id(), usb.hardware_id());
}

#[test]
fn an_identifier_that_is_not_twelve_hex_digits_has_no_hardware_identity() {
    for key in [
        "usb:001653F00C0",
        "usb:001653F00C0C0",
        "tcp:192.0.2.5",
        "mock:brick-1",
    ] {
        assert_eq!(BrickKey::parse(key).unwrap().hardware_id(), None, "{key}");
    }
}

#[test]
fn a_key_round_trips_through_its_serialized_form() {
    let key = BrickKey::parse("tcp:001653F00A0A").unwrap();
    let text = serde_json::to_string(&key).unwrap();
    assert_eq!(text, "\"tcp:001653F00A0A\"");
    assert_eq!(serde_json::from_str::<BrickKey>(&text).unwrap(), key);
    assert!(serde_json::from_str::<BrickKey>("\"nope\"").is_err());
}

#[test]
fn the_users_channel_runs_on_hardware_and_never_records() {
    assert_eq!(
        provider_source(ChannelKind::User, DaemonMode::Hardware),
        Ok(ProviderSource::Hardware { record: false })
    );
    let error = provider_source(ChannelKind::User, DaemonMode::Record).unwrap_err();
    assert!(error.message.contains("never records"), "{}", error.message);
}

#[test]
fn the_users_channel_refuses_replay() {
    let error = provider_source(ChannelKind::User, DaemonMode::Replay).unwrap_err();
    assert!(error.message.contains("never runs on recordings"));
}

#[test]
fn a_test_channel_opens_real_hardware_only_to_record() {
    let error = provider_source(ChannelKind::Test, DaemonMode::Hardware).unwrap_err();
    assert!(
        error.message.contains("never opens real hardware"),
        "{}",
        error.message
    );
    let source = provider_source(ChannelKind::Test, DaemonMode::Record).unwrap();
    assert_eq!(source, ProviderSource::Hardware { record: true });
    assert!(source.opens_hardware());
}

#[test]
fn a_test_channel_runs_on_replay_and_the_hello_says_so() {
    let source = provider_source(ChannelKind::Test, DaemonMode::Replay).unwrap();
    assert_eq!(source, ProviderSource::Replay);
    assert!(!source.opens_hardware());
    assert_eq!(source.hello_mode(), "replay");
    assert_eq!(
        ProviderSource::Hardware { record: true }.hello_mode(),
        "hardware"
    );
}
