//! Opt-in check against a real brick on the cable: open the first EV3, list its projects
//! folder, round-trip a 100 kB file through the provider and the protocol crate, delete it.
//!
//! Run by hand with a brick on USB and nothing else holding it, one check at a time (two links
//! to one brick at once take each other's replies):
//! `cargo test -p ev3-transports --test usb_hardware -- --ignored --nocapture --test-threads=1`
//!
//! Prints only the backend, the frame and the speeds: a USB brick key carries the brick's serial,
//! so no key, discovery item or connect message is printed.

use std::time::Instant;

use ev3_protocol::packet::{command, reply, system, system_status};
use ev3_protocol::{decode_ev3_packet, encode_ev3_packet};
use ev3_transports::usb::{UsbProviderOptions, UsbTransportProvider};
use ev3_transports::{BrickKey, SendOptions, TransportProvider};

const FOLDER: &str = "/home/root/lms2012/prjs/";
const FILE: &str = "/home/root/lms2012/prjs/ev3usbcheck.bin";
const FILE_BYTES: usize = 100 * 1024;

struct Session<'a> {
    provider: &'a UsbTransportProvider,
    key: BrickKey,
    counter: u16,
}

impl Session<'_> {
    /// One system command; returns the reply payload after the echoed command byte and the
    /// status: `(status, data)`.
    async fn system(&mut self, payload: &[u8]) -> (u8, Vec<u8>) {
        self.counter = self.counter.wrapping_add(1);
        let request = encode_ev3_packet(
            u32::from(self.counter),
            command::SYSTEM_COMMAND_REPLY,
            payload,
        )
        .unwrap();
        let options = SendOptions {
            expected_message_counter: Some(self.counter),
            ..SendOptions::default()
        };
        let answer = self
            .provider
            .send_packet(&self.key, &request, &options)
            .await
            .map_err(|error| error.code)
            .expect("exchange failed");
        let packet = decode_ev3_packet(&answer).unwrap();
        assert_eq!(
            packet.packet_type,
            reply::SYSTEM_REPLY,
            "system error reply"
        );
        assert_eq!(packet.payload[0], payload[0], "echoed command");
        (packet.payload[1], packet.payload[2..].to_vec())
    }
}

fn with_path(head: &[u8], path: &str) -> Vec<u8> {
    let mut payload = head.to_vec();
    payload.extend_from_slice(path.as_bytes());
    payload.push(0);
    payload
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs an EV3 on USB"]
async fn round_trips_a_file_through_the_first_ev3_on_the_cable() {
    let provider = UsbTransportProvider::new(UsbProviderOptions::default());
    let scan = provider.discover().await.map_err(|e| e.code).unwrap();
    let key = scan
        .items
        .first()
        .expect("no EV3 on the USB bus")
        .brick_key
        .clone();
    let started = Instant::now();
    provider
        .connect(&key)
        .await
        .map_err(|error| error.code)
        .expect("connect failed");
    let frame = provider.max_packet_bytes(&key).unwrap();
    println!(
        "connected in {} ms over {:?}, {frame}-byte frames",
        started.elapsed().as_millis(),
        provider.backend_for(&key).unwrap()
    );
    let mut session = Session {
        provider: &provider,
        key: key.clone(),
        counter: 0,
    };

    let mut list = vec![system::LIST_FILES];
    list.extend_from_slice(&1000u16.to_le_bytes());
    let (status, listing) = session.system(&with_path(&list, FOLDER)).await;
    println!("listing: status {status}, {} bytes", listing.len());
    assert!(status == system_status::OK || status == system_status::END_OF_FILE);

    let content: Vec<u8> = (0..FILE_BYTES).map(|i| (i * 7 + 3) as u8).collect();

    // Write: BEGIN_DOWNLOAD names the file, CONTINUE_DOWNLOAD carries frame-sized chunks.
    let started = Instant::now();
    let mut begin = vec![system::BEGIN_DOWNLOAD];
    begin.extend_from_slice(&u32::try_from(FILE_BYTES).unwrap().to_le_bytes());
    let (status, data) = session.system(&with_path(&begin, FILE)).await;
    assert_eq!(status, system_status::OK, "BEGIN_DOWNLOAD");
    let handle = data[0];
    for part in content.chunks(frame - 7) {
        let mut next = vec![system::CONTINUE_DOWNLOAD, handle];
        next.extend_from_slice(part);
        let (status, _) = session.system(&next).await;
        assert!(
            status == system_status::OK || status == system_status::END_OF_FILE,
            "CONTINUE_DOWNLOAD status {status}"
        );
    }
    let write_secs = started.elapsed().as_secs_f64();

    // Read: BEGIN_UPLOAD returns the size and the first chunk, CONTINUE_UPLOAD the rest.
    let started = Instant::now();
    let mut up = vec![system::BEGIN_UPLOAD];
    up.extend_from_slice(&u16::try_from(frame - 12).unwrap().to_le_bytes());
    let (mut status, data) = session.system(&with_path(&up, FILE)).await;
    assert!(status == system_status::OK || status == system_status::END_OF_FILE);
    let size = usize::try_from(u32::from_le_bytes([data[0], data[1], data[2], data[3]])).unwrap();
    let handle = data[4];
    let mut back = data[5..].to_vec();
    while back.len() < size && status == system_status::OK {
        let want = (frame - 8).min(size - back.len());
        let mut next = vec![system::CONTINUE_UPLOAD, handle];
        next.extend_from_slice(&u16::try_from(want).unwrap().to_le_bytes());
        let (got, data) = session.system(&next).await;
        status = got;
        assert!(
            status == system_status::OK || status == system_status::END_OF_FILE,
            "CONTINUE_UPLOAD status {status}"
        );
        back.extend_from_slice(&data[1..]);
    }
    let read_secs = started.elapsed().as_secs_f64();
    back.truncate(size);

    let (status, _) = session
        .system(&with_path(&[system::DELETE_FILE], FILE))
        .await;
    println!("delete: status {status}");
    assert_eq!(back, content, "read-back differs");

    let kb = FILE_BYTES as f64 / 1024.0;
    println!(
        "write {:.0} KB/s ({write_secs:.2} s); read {:.0} KB/s ({read_secs:.2} s)",
        kb / write_secs,
        kb / read_secs
    );
    provider.disconnect(&key).await.unwrap();
    provider.dispose().await;
}

/// The HID fallback on its own: one listing that fits a 64-byte report each way.
#[cfg(any(windows, target_os = "linux"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs an EV3 on USB"]
async fn lists_the_programs_folder_over_the_hid_fallback() {
    use std::sync::Arc;
    use std::time::Duration;

    use ev3_transports::usb::{HidLink, UsbLink, hidapi_backend::HidapiBackend};

    let link = HidLink::open(Arc::new(HidapiBackend), None, Duration::from_secs(1))
        .await
        .expect("HID open failed");
    let mut list = vec![system::LIST_FILES];
    list.extend_from_slice(&40u16.to_le_bytes());
    let request =
        encode_ev3_packet(1, command::SYSTEM_COMMAND_REPLY, &with_path(&list, FOLDER)).unwrap();
    let options = SendOptions {
        expected_message_counter: Some(1),
        ..SendOptions::default()
    };
    let answer = link
        .send(&request, &options)
        .await
        .map_err(|error| error.message)
        .unwrap();
    let packet = decode_ev3_packet(&answer).unwrap();
    assert_eq!(packet.packet_type, reply::SYSTEM_REPLY);
    println!(
        "HID listing: {}-byte packets, status {}, {} bytes",
        link.max_packet_bytes().unwrap(),
        packet.payload[1],
        packet.payload.len()
    );
    link.close().await;
}
