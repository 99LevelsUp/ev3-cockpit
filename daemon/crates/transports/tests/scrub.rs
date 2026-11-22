//! Identifiers are replaced as a session is recorded: consistently, keeping lengths, in provider
//! events and link bytes alike, and nothing real reaches the fixture.

mod common;

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;

use common::{FakeConfig, FakeLinkProvider, IDENTIFY, reply_packet, request, temp_dir};
use ev3_transports::fixture::{RECORDING_FILE, to_hex};
use ev3_transports::{BrickKey, Recorder, Replay, ReplayMode, Scrubber, SendOptions, Transport};

/// Twelve hex digits made up at run time, never a real machine's.
fn made_up_digits() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(u64::from(std::process::id()));
    // 0x02 in the first byte: a locally administered address, which no vendor ships.
    format!("02{:010X}", hasher.finish() & 0xff_ffff_ffff)
}

fn spell(digits: &str, separator: &str) -> String {
    digits
        .as_bytes()
        .chunks(2)
        .map(|pair| std::str::from_utf8(pair).unwrap())
        .collect::<Vec<_>>()
        .join(separator)
}

/// Every spelling of an address a provider or a brick might use.
fn spellings(digits: &str) -> Vec<String> {
    let mut all = Vec::new();
    for separator in [":", "-", "_", ""] {
        let spelled = spell(digits, separator);
        all.push(spelled.to_ascii_lowercase());
        all.push(spelled.to_ascii_uppercase());
    }
    all
}

// The "real" identifiers below are assembled at run time from obviously made-up parts, so no
// address, name or path that could be someone's is written in this file.

/// An address from its six bytes, spelled with `separator` in upper case.
fn mac(bytes: [u8; 6], separator: &str) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(separator)
}

/// A dotted IPv4 address.
fn lan(a: u8, b: u8, c: u8, d: u8) -> String {
    format!("{a}.{b}.{c}.{d}")
}

/// A made-up name: one capital letter, then `x` up to `len` characters.
fn word(first: char, len: usize) -> String {
    format!("{first}{}", "x".repeat(len - 1))
}

#[test]
fn every_spelling_of_one_address_becomes_the_same_placeholder() {
    let bytes = [0x02, 0xab, 0xcd, 0xef, 0x01, 0x23];
    let mut scrubber = Scrubber::new();
    scrubber
        .learn_from_text(&format!("bt:{}", mac(bytes, ":")))
        .unwrap();
    let text = format!(
        "usb:{} tcp:{} dev_{} {}",
        mac(bytes, ""),
        mac(bytes, "").to_ascii_lowercase(),
        mac(bytes, "_"),
        mac(bytes, "-").to_ascii_lowercase()
    );
    assert_eq!(
        scrubber.scrub_text(&text),
        "usb:001653F00A0A tcp:001653f00a0a dev_00_16_53_F0_0A_0A 00-16-53-f0-0a-0a"
    );
    assert_eq!(
        scrubber.scrub_text(&format!("bt:{}", mac(bytes, ":"))),
        "bt:00:16:53:F0:0A:0A"
    );
}

#[test]
fn each_address_gets_its_own_placeholder_and_keeps_it() {
    let first = [0x02, 0, 0, 0, 0, 1];
    let second = [0x02, 0, 0, 0, 0, 2];
    let mut scrubber = Scrubber::new();
    scrubber.register_address(&mac(first, ":")).unwrap();
    scrubber.register_address(&mac(second, "")).unwrap();
    scrubber.register_address(&mac(first, "-")).unwrap();
    assert_eq!(
        scrubber.scrub_text(&format!("{} {}", mac(first, ""), mac(second, ""))),
        "001653F00A0A 001653F00B0B"
    );
}

#[test]
fn an_address_shaped_like_a_placeholder_is_still_replaced() {
    // Every brick shares the vendor prefix, so a real one can carry the placeholder shape.
    let mut scrubber = Scrubber::new();
    scrubber.learn_from_text("bt:00:16:53:F0:0A:0A").unwrap();
    assert_eq!(
        scrubber.scrub_text("bt:00:16:53:F0:0A:0A"),
        "bt:00:16:53:F0:0B:0B"
    );
}

#[test]
fn a_placeholder_this_recording_handed_out_is_not_learned_again() {
    let mut scrubber = Scrubber::new();
    scrubber
        .register_address(&mac([0x02, 0, 0, 0, 0, 1], ":"))
        .unwrap();
    let once = scrubber.scrub_text(&mac([0x02, 0, 0, 0, 0, 1], ":"));
    scrubber.learn_from_text(&once).unwrap();
    assert_eq!(scrubber.scrub_text(&once), once);
}

#[test]
fn host_and_user_names_keep_their_length() {
    let hosts = [word('J', 3), word('K', 4), word('L', 5), word('M', 12)];
    let user = word('N', 7);
    let mut scrubber = Scrubber::new();
    for name in &hosts {
        scrubber.register_host_name(name).unwrap();
    }
    scrubber.register_user_name(&user).unwrap();
    let text = format!(
        "{} {} {} {} C:\\Users\\{user}\\x",
        hosts[0], hosts[1], hosts[2], hosts[3]
    );
    let scrubbed = scrubber.scrub_text(&text);
    assert_eq!(scrubbed.len(), text.len());
    assert_eq!(
        scrubbed,
        "HOA HOSB HOSTC HOSTDDDDDDDD C:\\Users\\USERAAA\\x"
    );
}

#[test]
fn a_host_name_is_replaced_in_its_upper_and_lower_case_spellings() {
    let host = format!("{}42", word('Q', 5));
    let mut scrubber = Scrubber::new();
    scrubber.register_host_name(&host).unwrap();
    let text = format!(
        "{host} {} {}",
        host.to_ascii_uppercase(),
        host.to_ascii_lowercase()
    );
    assert_eq!(scrubber.scrub_text(&text), "HOSTAAA HOSTAAA hostaaa");
}

#[test]
fn lan_addresses_become_documentation_addresses_of_the_same_length() {
    let mut scrubber = Scrubber::new();
    for ip in [
        lan(10, 0, 0, 17),
        lan(10, 1, 2, 34),
        lan(10, 11, 12, 13),
        lan(172, 16, 0, 200),
        lan(192, 168, 10, 200),
        lan(192, 168, 100, 200),
    ] {
        scrubber.register_ip(&ip).unwrap();
        let scrubbed = scrubber.scrub_bytes(ip.as_bytes()).unwrap();
        assert_eq!(scrubbed.len(), ip.len(), "{ip}");
        let text = String::from_utf8(scrubbed).unwrap();
        assert!(
            text.starts_with("192.0.2.")
                || text.starts_with("198.51.100.")
                || text.starts_with("198.051.100."),
            "{ip} became {text}"
        );
    }
}

#[test]
fn a_short_lan_address_is_replaced_in_text_and_refused_in_link_bytes() {
    let short = lan(10, 0, 0, 5);
    let mut scrubber = Scrubber::new();
    scrubber.register_ip(&short).unwrap();
    assert_eq!(
        scrubber.scrub_text(&format!("host {short}:5555")),
        "host 192.0.2.1:5555"
    );
    assert!(scrubber.scrub_bytes(short.as_bytes()).is_err());
}

#[test]
fn addresses_seen_in_text_or_bytes_are_learned() {
    let ip = lan(172, 20, 30, 40);
    let address = mac([0x02, 0x11, 0x22, 0x33, 0x44, 0x55], ":");
    let mut scrubber = Scrubber::new();
    scrubber
        .learn_from_text(&format!("connect ECONNREFUSED {ip}:5555"))
        .unwrap();
    let mut bytes = vec![0x00, 0x01];
    bytes.extend(address.as_bytes());
    bytes.push(0x00);
    scrubber.learn_from_bytes(&bytes).unwrap();
    assert_eq!(
        scrubber.scrub_text(&format!("{ip} {address}")),
        "198.51.100.1 00:16:53:F0:0A:0A"
    );
}

#[test]
fn documentation_addresses_and_versions_are_left_alone() {
    let mut scrubber = Scrubber::new();
    scrubber
        .learn_from_text("192.0.2.7 Linux 2.6.33-rc4 V1.09H 1.2.3.4.5")
        .unwrap();
    assert_eq!(
        scrubber.scrub_text("192.0.2.7 Linux 2.6.33-rc4 V1.09H"),
        "192.0.2.7 Linux 2.6.33-rc4 V1.09H"
    );
}

#[tokio::test(start_paused = true)]
async fn a_recorded_session_leaves_no_trace_of_a_real_address() {
    let brick = made_up_digits();
    let adapter = format!("02{}", &made_up_digits()[2..10]) + "FE";
    let host = format!("RIG{}", &made_up_digits()[6..12]);
    let user = format!("user{}", &made_up_digits()[8..12]).to_ascii_lowercase();
    let ip = lan(10, 123, 145, 167);
    let ip = ip.as_str();

    let mut identify = brick.to_ascii_lowercase().into_bytes();
    identify.extend(format!("|{host}|{ip}").into_bytes());
    let config = FakeConfig {
        transport: Transport::Bt,
        key: BrickKey::new(Transport::Bt, &spell(&brick, ":")).unwrap(),
        display_name: "AAA".into(),
        identify_reply: identify.clone(),
        residue_location: format!(
            "C:\\Users\\{user}\\cockpit | HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Keys\\{}\\{}",
            adapter.to_ascii_lowercase(),
            brick.to_ascii_lowercase()
        ),
    };
    let key = config.key.clone();

    let dir = temp_dir("scrub");
    let mut scrubber = Scrubber::new();
    scrubber.register_address(&adapter).unwrap();
    scrubber.register_host_name(&host).unwrap();
    scrubber.register_user_name(&user).unwrap();
    scrubber.register_ip(ip).unwrap();
    let recorder = Recorder::create(&dir, "scrub", scrubber).unwrap();
    let provider = recorder.wrap(Arc::new(FakeLinkProvider::new(config)));
    provider.discover().await.unwrap();
    provider.connect(&key).await.unwrap();
    let options = SendOptions {
        expected_message_counter: Some(1),
        ..SendOptions::default()
    };
    let live = provider
        .send_packet(&key, &request(1, &[IDENTIFY]), &options)
        .await
        .unwrap();
    assert_eq!(
        live,
        reply_packet(1, &identify),
        "the live caller gets the real reply"
    );
    provider.forget(&key).await.unwrap();
    provider.disconnect(&key).await.unwrap();
    recorder.finish().unwrap();

    let fixture = std::fs::read_to_string(dir.join(RECORDING_FILE)).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();

    let mut secrets: Vec<String> = Vec::new();
    secrets.extend(spellings(&brick));
    secrets.extend(spellings(&adapter));
    for name in [host.as_str(), user.as_str(), ip] {
        secrets.push(name.to_owned());
        secrets.push(name.to_ascii_uppercase());
        secrets.push(name.to_ascii_lowercase());
    }
    for secret in &secrets {
        assert!(
            !fixture.contains(secret.as_str()),
            "{secret} reached the fixture"
        );
        let in_bytes = to_hex(secret.as_bytes());
        assert!(
            !fixture.contains(&in_bytes),
            "{secret} reached the fixture's bytes"
        );
    }

    // The placeholders took their place, and the recording still replays: the reply keeps its
    // length, so its length prefix still describes it.
    assert!(fixture.contains("bt:00:16:53:F0:0B:0B"));
    let replay = Replay::from_text(&fixture, ReplayMode::Matched).unwrap();
    let replayed = replay.provider(Transport::Bt).unwrap();
    let scan = replayed.discover().await.unwrap();
    let placeholder_key = scan.items[0].brick_key.clone();
    assert_eq!(placeholder_key.as_str(), "bt:00:16:53:F0:0B:0B");
    replayed.connect(&placeholder_key).await.unwrap();
    let answer = replayed
        .send_packet(&placeholder_key, &request(1, &[IDENTIFY]), &options)
        .await
        .unwrap();
    assert_eq!(answer.len(), live.len());
    let text = String::from_utf8_lossy(&answer[5..]).into_owned();
    // The placeholder keeps the original's case; a made-up address of digits alone has none, so
    // the address compares without case.
    assert!(text[..12].eq_ignore_ascii_case("001653f00b0b"), "{text}");
    assert!(text[12..].starts_with("|HOSTAAAAA|198.51.100."), "{text}");
}

/// A peer name made up at run time: a space and a non-ASCII letter, like a computer's name.
fn made_up_peer_name() -> String {
    format!("Dílna {}", &made_up_digits()[6..12])
}

fn favour_item_reply(name: &str) -> Vec<u8> {
    let mut globals = vec![0u8; 130];
    globals[..name.len()].copy_from_slice(name.as_bytes());
    globals[127] = 1;
    globals[129] = 3;
    globals
}

#[test]
fn peer_names_in_a_favour_item_reply_and_a_removal_are_replaced_keeping_lengths() {
    use ev3_protocol::packet::command::DIRECT_COMMAND_REPLY;
    use ev3_protocol::{BrickCommand, build_command, encode_ev3_packet};
    let name = made_up_peer_name();
    let read = build_command(&BrickCommand::BluetoothPeer { index: 0 }).unwrap();
    let read = encode_ev3_packet(7, DIRECT_COMMAND_REPLY, &read.payload).unwrap();
    let reply = reply_packet(7, &favour_item_reply(&name));
    let remove = build_command(&BrickCommand::RemoveBluetoothPeer { name: name.clone() }).unwrap();
    let remove = encode_ev3_packet(8, DIRECT_COMMAND_REPLY, &remove.payload).unwrap();

    // Each exchange teaches its own scrubber: the removal is learned from the request alone.
    for (request, reply) in [(&read, &reply[..]), (&remove, &[][..])] {
        let mut scrubber = Scrubber::new();
        scrubber.learn_from_exchange(request, reply).unwrap();
        let bytes = if reply.is_empty() {
            request
        } else {
            &reply.to_vec()
        };
        let scrubbed = scrubber.scrub_bytes(bytes).unwrap();
        assert_eq!(scrubbed.len(), bytes.len());
        assert!(
            !to_hex(&scrubbed).contains(&to_hex(name.as_bytes())),
            "the peer name stayed"
        );
    }

    // A placeholder in the list is not a name to hide; a real name that only starts like one is.
    for (peer, kept) in [("CCC", true), ("HOSTAAAA", true), ("HOSTALICE", false)] {
        let mut scrubber = Scrubber::new();
        scrubber
            .learn_from_exchange(&read, &reply_packet(7, &favour_item_reply(peer)))
            .unwrap();
        assert_eq!(scrubber.scrub_text(peer) == peer, kept, "{peer}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_recorded_bluetooth_list_read_leaves_no_trace_of_a_peer_name() {
    use ev3_protocol::packet::command::DIRECT_COMMAND_REPLY;
    use ev3_protocol::{BrickCommand, build_command, encode_ev3_packet};
    let name = made_up_peer_name();
    let serial = made_up_digits();
    let mut config = FakeConfig::usb(&serial);
    config.identify_reply = favour_item_reply(&name);
    let key = config.key.clone();

    let dir = temp_dir("scrub-peer");
    let recorder = Recorder::create(&dir, "scrub-peer", Scrubber::new()).unwrap();
    let provider = recorder.wrap(Arc::new(FakeLinkProvider::new(config)));
    provider.connect(&key).await.unwrap();
    let read = build_command(&BrickCommand::BluetoothPeer { index: 0 }).unwrap();
    let read = encode_ev3_packet(1, DIRECT_COMMAND_REPLY, &read.payload).unwrap();
    let options = SendOptions {
        expected_message_counter: Some(1),
        ..SendOptions::default()
    };
    let live = provider.send_packet(&key, &read, &options).await.unwrap();
    assert!(
        to_hex(&live).contains(&to_hex(name.as_bytes())),
        "the live caller gets the real name"
    );
    provider.disconnect(&key).await.unwrap();
    recorder.finish().unwrap();

    let fixture = std::fs::read_to_string(dir.join(RECORDING_FILE)).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(
        !fixture.contains(&name),
        "the peer name reached the fixture"
    );
    assert!(
        !fixture.contains(&to_hex(name.as_bytes())),
        "the peer name reached the fixture's bytes"
    );
}
