//! The beacon path is the only place untrusted network bytes enter a provider. These tests pin
//! what the cache accepts, bounds and forgets, with the expected values taken from the
//! TypeScript behavior (beacon discovery tests and the transport constants), on a paused clock.

use std::net::Ipv4Addr;
use std::time::Duration;

use ev3_transports::tcp::beacon::{
    BEACON_CACHE_MAX, BEACON_FRESH, BEACON_NAME_MAX, BeaconState, parse_beacon_message,
    to_broadcast_address,
};
use tokio::time::{Instant, advance};

fn beacon(serial: &str, name: &str, port: &str) -> Vec<u8> {
    format!("Serial-Number: {serial}\r\nPort: {port}\r\nName: {name}\r\nProtocol: EV3\r\n")
        .into_bytes()
}

fn ip(last: u8) -> Ipv4Addr {
    Ipv4Addr::new(192, 0, 2, last)
}

/// A twelve-digit serial that differs per `n`.
fn serial(n: usize) -> String {
    format!("001653{n:06x}")
}

fn hear(state: &mut BeaconState, datagram: &[u8], sender: Ipv4Addr) {
    state.accept_datagram(datagram, sender, Instant::now(), 1_000);
}

#[test]
fn parses_a_well_formed_announcement() {
    let parsed =
        parse_beacon_message(&String::from_utf8(beacon("001653aabbcc", "AAA", "5555")).unwrap())
            .unwrap();
    assert_eq!(parsed.serial_number, "001653aabbcc");
    assert_eq!(parsed.name, "AAA");
    assert_eq!(parsed.port, 5555);
    assert_eq!(parsed.protocol, "EV3");
}

#[test]
fn rejects_an_unusable_port_rather_than_guessing() {
    assert_eq!(
        parse_beacon_message("Serial-Number: x\r\nPort: 0\r\n"),
        None
    );
    assert_eq!(
        parse_beacon_message("Serial-Number: x\r\nPort: 99999\r\n"),
        None
    );
    assert_eq!(
        parse_beacon_message("Serial-Number: x\r\nPort: nonsense\r\n"),
        None
    );
    assert_eq!(parse_beacon_message("Serial-Number: x\r\n"), None);
}

#[test]
fn strips_control_characters_which_would_forge_log_lines() {
    let parsed = parse_beacon_message(
        "Serial-Number: 001653aabbcc\r\nPort: 5555\r\nName: evil\u{7}\u{1b}INJECTED\r\n",
    )
    .unwrap();
    assert_eq!(parsed.name, "evilINJECTED");
}

#[test]
fn a_two_hundred_byte_name_is_cut_to_thirty_two_bytes() {
    let text = format!(
        "Serial-Number: 001653aabbcc\r\nPort: 5555\r\nName: {}\r\n",
        "A".repeat(200)
    );
    let parsed = parse_beacon_message(&text).unwrap();
    assert_eq!(BEACON_NAME_MAX, 32);
    assert_eq!(parsed.name.len(), 32);
}

#[test]
fn the_name_is_cut_on_a_character_boundary() {
    // Two-byte characters: sixteen fit exactly, and a seventeenth must not be split.
    let text = format!(
        "Serial-Number: 001653aabbcc\r\nPort: 5555\r\nName: {}\r\n",
        "\u{e9}".repeat(40)
    );
    let parsed = parse_beacon_message(&text).unwrap();
    assert_eq!(parsed.name.chars().count(), 16);
    assert!(parsed.name.len() <= 32);
}

#[test]
fn broadcast_address_of_an_ordinary_lan_mask() {
    assert_eq!(
        to_broadcast_address(ip(154), Ipv4Addr::new(255, 255, 255, 0)),
        Some(ip(255))
    );
    assert_eq!(
        to_broadcast_address(Ipv4Addr::new(10, 1, 2, 3), Ipv4Addr::new(255, 255, 0, 0)),
        Some(Ipv4Addr::new(10, 1, 255, 255))
    );
}

#[test]
fn no_broadcast_for_a_32_bit_or_zero_or_too_wide_mask() {
    let a = Ipv4Addr::new(198, 51, 100, 81);
    assert_eq!(
        to_broadcast_address(a, Ipv4Addr::new(255, 255, 255, 255)),
        None
    );
    assert_eq!(to_broadcast_address(a, Ipv4Addr::new(0, 0, 0, 0)), None);
    assert_eq!(to_broadcast_address(a, Ipv4Addr::new(254, 0, 0, 0)), None);
}

#[tokio::test(start_paused = true)]
async fn a_brick_that_announces_is_listed() {
    let mut state = BeaconState::new();
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(10));
    let seen = state.fresh(Instant::now());
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].info.name, "AAA");
    assert_eq!(seen[0].info.ip, ip(10));
    assert_eq!(seen[0].received_epoch_ms, 1_000);
}

#[tokio::test(start_paused = true)]
async fn an_announcement_whose_serial_is_not_an_ev3_identity_is_ignored() {
    let mut state = BeaconState::new();
    hear(
        &mut state,
        &beacon("not-a-serial", "Impostor", "5555"),
        ip(10),
    );
    hear(&mut state, &beacon("", "Nameless", "5555"), ip(11));
    hear(&mut state, &beacon("001653aabbc", "Short", "5555"), ip(12));
    hear(
        &mut state,
        &beacon("001653aabbccdd", "Long", "5555"),
        ip(13),
    );
    assert!(state.fresh(Instant::now()).is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_sixty_fifth_distinct_beacon_evicts_the_oldest() {
    let mut state = BeaconState::new();
    for n in 0..BEACON_CACHE_MAX {
        hear(&mut state, &beacon(&serial(n), "B", "5555"), ip(10));
        advance(Duration::from_millis(1)).await;
    }
    assert_eq!(state.fresh(Instant::now()).len(), 64);

    hear(&mut state, &beacon(&serial(64), "B", "5555"), ip(10));
    let seen = state.fresh(Instant::now());
    assert_eq!(seen.len(), 64);
    let serials: Vec<String> = seen.iter().map(|s| s.info.serial_number.clone()).collect();
    assert!(!serials.contains(&serial(0)), "the oldest is gone");
    assert!(serials.contains(&serial(1)));
    assert!(serials.contains(&serial(64)));
}

#[tokio::test(start_paused = true)]
async fn a_flood_never_grows_the_cache_past_its_cap() {
    let mut state = BeaconState::new();
    for n in 0..BEACON_CACHE_MAX + 20 {
        hear(&mut state, &beacon(&serial(n), "B", "5555"), ip(10));
        advance(Duration::from_millis(1)).await;
    }
    assert_eq!(state.fresh(Instant::now()).len(), BEACON_CACHE_MAX);
}

#[tokio::test(start_paused = true)]
async fn an_update_from_a_known_brick_does_not_evict_another() {
    let mut state = BeaconState::new();
    for n in 0..BEACON_CACHE_MAX {
        hear(&mut state, &beacon(&serial(n), "B", "5555"), ip(10));
        advance(Duration::from_millis(1)).await;
    }
    hear(&mut state, &beacon(&serial(0), "Renamed", "5555"), ip(10));
    let seen = state.fresh(Instant::now());
    assert_eq!(seen.len(), 64);
    assert!(seen.iter().any(|s| s.info.name == "Renamed"));
}

#[tokio::test(start_paused = true)]
async fn our_own_broadcast_is_not_a_brick() {
    let mut state = BeaconState::new();
    state.add_local_address(ip(5));
    // The echo of our own probe parses as nothing useful, but a copy of a real brick's text
    // sent from one of our own addresses must be ignored just the same.
    hear(&mut state, &beacon("001653aabbcc", "Echo", "5555"), ip(5));
    assert!(state.fresh(Instant::now()).is_empty());
    hear(&mut state, &[0x00], ip(5));
    assert!(state.fresh(Instant::now()).is_empty());
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(6));
    assert_eq!(state.fresh(Instant::now()).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_beacon_older_than_fifteen_seconds_drops_the_brick() {
    let mut state = BeaconState::new();
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(10));
    assert_eq!(BEACON_FRESH, Duration::from_secs(15));

    advance(BEACON_FRESH).await;
    assert_eq!(
        state.fresh(Instant::now()).len(),
        1,
        "exactly 15 s is still fresh"
    );

    advance(Duration::from_millis(1)).await;
    assert!(state.fresh(Instant::now()).is_empty());
    assert!(state.find_fresh("001653aabbcc", Instant::now()).is_none());
}

#[tokio::test(start_paused = true)]
async fn a_fresh_identity_is_never_repointed_at_another_address() {
    let mut state = BeaconState::new();
    hear(&mut state, &beacon("001653AABBCC", "AAA", "5555"), ip(10));
    advance(Duration::from_secs(1)).await;
    hear(
        &mut state,
        &beacon("001653aabbcc", "Forged", "6666"),
        ip(66),
    );

    let seen = state.fresh(Instant::now());
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].info.ip, ip(10), "the incumbent wins");
    // Two addresses claimed it, so nobody can say which is the brick.
    assert!(state.find_fresh("001653aabbcc", Instant::now()).is_none());
}

#[tokio::test(start_paused = true)]
async fn a_clash_expires_so_a_new_lease_does_not_lock_a_brick_out() {
    let mut state = BeaconState::new();
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(10));
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(11));
    assert!(state.find_fresh("001653aabbcc", Instant::now()).is_none());

    advance(BEACON_FRESH + Duration::from_millis(1)).await;
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(11));
    let found = state.find_fresh("001653aabbcc", Instant::now()).unwrap();
    assert_eq!(found.ip, ip(11));
}

#[tokio::test(start_paused = true)]
async fn scans_keep_the_listener_and_silence_releases_it() {
    let mut state = BeaconState::new();
    assert!(!state.note_scan(Instant::now()), "nobody listens yet");
    state.set_listening(true);
    hear(&mut state, &beacon("001653aabbcc", "AAA", "5555"), ip(10));

    advance(Duration::from_secs(10)).await;
    assert!(state.note_scan(Instant::now()));
    advance(Duration::from_secs(10)).await;
    assert!(
        !state.stop_if_idle(Instant::now()),
        "a scan 10 s ago keeps it"
    );

    advance(Duration::from_secs(6)).await;
    assert!(state.stop_if_idle(Instant::now()));
    assert!(!state.is_listening());
    assert!(
        state.fresh(Instant::now()).is_empty(),
        "what it heard goes with it"
    );
}
