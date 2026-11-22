//! Bluetooth on real hardware, run by hand: `cargo test -p ev3-transports --test bt_hw --
//! --ignored --nocapture`. Needs a paired brick that is switched on with Bluetooth on.
//!
//! Passive except for one short session: discovery, an inquiry, presence over the paired bricks,
//! then a connect to the first paired brick that answered and a few listings of the projects
//! folder. Never pairs, unpairs or forgets. Prints no address: bricks are named by their place in
//! the list.
#![cfg(windows)]

use std::time::{Duration, Instant};

use ev3_transports::bt_windows::WindowsBtProvider;
use ev3_transports::{SendOptions, TransportProvider};

/// A system command that lists `/home/root/lms2012/prjs/`, numbered `counter`.
fn listing(counter: u16) -> Vec<u8> {
    let mut body = counter.to_le_bytes().to_vec();
    body.push(0x01); // system command, reply wanted
    body.push(0x99); // LIST_FILES
    body.extend_from_slice(&1000u16.to_le_bytes());
    body.extend_from_slice(b"/home/root/lms2012/prjs/\0");
    let mut packet = u16::try_from(body.len()).unwrap().to_le_bytes().to_vec();
    packet.extend_from_slice(&body);
    packet
}

/// What Windows' cache says about the bricks it knows: paired, and connected now. Counts only.
#[test]
#[ignore = "needs a Bluetooth radio"]
fn the_cache_says_which_bricks_windows_is_connected_to() {
    use ev3_transports::bt::{format_mac, is_lego_mac};
    let devices = ev3_transports::bt_windows::discovery::list_devices().expect("cache");
    let bricks: Vec<_> = devices
        .iter()
        .filter(|d| is_lego_mac(&format_mac(d.address)))
        .collect();
    for (index, brick) in bricks.iter().enumerate() {
        println!(
            "cache: brick #{index} remembered={} authenticated={} connected={}",
            brick.remembered, brick.authenticated, brick.connected
        );
    }
}

/// What WinRT's two queries return on this host: the paired list from the records, and what a
/// live watcher on unpaired devices hears in five seconds, bricks or not. Counts only.
#[test]
#[ignore = "needs a Bluetooth radio"]
fn winrt_queries_see_paired_and_nearby_devices() {
    use ev3_transports::bt::is_lego_mac;
    // Each on a thread of its own that ends after it, as the daemon runs one every minute.
    let inquire_on_own_thread = |window| {
        std::thread::spawn(move || ev3_transports::bt_windows::discovery::inquire(window))
            .join()
            .expect("the inquiry thread")
            .expect("inquiry")
    };
    inquire_on_own_thread(Duration::from_secs(2));
    println!("winrt: first inquiry done");
    let heard = inquire_on_own_thread(Duration::from_secs(5));
    let count = |paired: bool, lego: bool| {
        heard
            .iter()
            .filter(|b| b.paired == paired && is_lego_mac(&b.mac) == lego)
            .count()
    };
    println!(
        "winrt: paired {} bricks + {} other; unpaired heard {} bricks + {} other; with signal {}",
        count(true, true),
        count(true, false),
        count(false, true),
        count(false, false),
        heard.iter().filter(|b| b.signal.is_some()).count()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a paired EV3 brick switched on, with Bluetooth on"]
async fn discovers_checks_presence_connects_and_lists() {
    let provider = WindowsBtProvider::system();

    let started = Instant::now();
    let scan = provider.discover().await.expect("discovery");
    let paired: Vec<_> = scan
        .items
        .iter()
        .filter(|i| i.paired == Some(true))
        .collect();
    println!(
        "discovery: {} bricks, {} paired, in {} ms",
        scan.items.len(),
        paired.len(),
        started.elapsed().as_millis()
    );

    println!(
        "radio name: {}",
        if provider.radio_name().await.is_some() {
            "present"
        } else {
            "none"
        }
    );

    let started = Instant::now();
    provider.run_inquiry().await;
    println!(
        "inquiry: {} unpaired bricks heard, in {} ms; stopped: {:?}",
        provider.presence().unpaired_bricks().len(),
        started.elapsed().as_millis(),
        provider.presence().unavailable_reason()
    );

    let mut heard = None;
    for (index, item) in paired.iter().enumerate() {
        let started = Instant::now();
        let answered = provider
            .check_presence(&item.brick_key)
            .await
            .expect("presence");
        println!(
            "presence: paired brick #{index} answered={answered} in {} ms",
            started.elapsed().as_millis()
        );
        if answered && heard.is_none() {
            heard = Some(item.brick_key.clone());
        }
    }
    let Some(brick) = heard else {
        println!("no paired brick answered; nothing to connect to");
        return;
    };

    let started = Instant::now();
    provider.connect(&brick).await.expect("connect");
    println!("connect: {} ms", started.elapsed().as_millis());

    let rounds = 10u16;
    let started = Instant::now();
    for counter in 1..=rounds {
        let reply = provider
            .send_packet(
                &brick,
                &listing(counter),
                &SendOptions {
                    timeout: Some(Duration::from_secs(5)),
                    expected_message_counter: Some(counter),
                },
            )
            .await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                // Tell a dead link from a brick that only refuses system commands: a direct
                // command (opNop, reply wanted) goes through the brick's VM instead.
                let nop = [0x06, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01];
                let direct = provider
                    .send_packet(
                        &brick,
                        &nop,
                        &SendOptions {
                            timeout: Some(Duration::from_secs(5)),
                            expected_message_counter: Some(100),
                        },
                    )
                    .await;
                println!(
                    "listing #{counter} failed ({}); a direct command then: {:?}",
                    error.message,
                    direct.map(|reply| reply.get(4).copied())
                );
                provider.disconnect(&brick).await.unwrap();
                provider.dispose().await;
                panic!("listing: {error:?}");
            }
        };
        assert_eq!(u16::from_le_bytes([reply[2], reply[3]]), counter);
        assert_eq!(reply[4], 0x03, "system reply, not an error reply");
        assert!(
            reply[6] == 0x00 || reply[6] == 0x08,
            "status {:#04x}",
            reply[6]
        );
    }
    let seconds = started.elapsed().as_secs_f64();
    println!(
        "listings: {rounds} in {seconds:.2} s = {:.1}/s",
        f64::from(rounds) / seconds
    );
    provider.disconnect(&brick).await.unwrap();
    provider.dispose().await;
    println!("done");
}
