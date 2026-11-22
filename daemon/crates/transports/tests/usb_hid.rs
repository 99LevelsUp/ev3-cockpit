//! The HID fallback link: one report per packet, the report id first, 64 bytes at most, and a
//! short write treated as the corruption it is.

mod usb_fake;

use std::sync::Arc;
use std::time::Duration;

use ev3_transports::SendOptions;
use ev3_transports::usb::{HidLink, UsbBackendKind, UsbLink};
use usb_fake::{FakeHid, command_of, reply_packet};

const SERIAL: &str = "001653AABBCC";

fn expecting(counter: u16) -> SendOptions {
    SendOptions {
        expected_message_counter: Some(counter),
        ..SendOptions::default()
    }
}

/// A report as the brick sends it: the packet, then zeros to 64 bytes.
fn report(packet: &[u8]) -> Vec<u8> {
    let mut report = vec![0u8; 64];
    report[..packet.len()].copy_from_slice(packet);
    report
}

async fn open(hid: &Arc<FakeHid>, serial: Option<&str>) -> Result<HidLink, String> {
    HidLink::open(
        hid.clone(),
        serial.map(str::to_owned),
        Duration::from_millis(500),
    )
    .await
}

fn two_bricks() -> Arc<FakeHid> {
    Arc::new(FakeHid::new(vec![
        FakeHid::brick("hid-1", "001653DDEEFF", None),
        FakeHid::brick("hid-2", SERIAL, None),
    ]))
}

#[tokio::test]
async fn opens_the_brick_whose_serial_was_asked_for() {
    let hid = two_bricks();
    let link = open(&hid, Some("001653aabbcc")).await.unwrap();
    assert_eq!(hid.log.lock().unwrap().opened, ["hid-2"]);
    assert_eq!(link.backend(), UsbBackendKind::Hid);
    assert_eq!(link.max_packet_bytes(), Some(64));
    assert_eq!(link.location(), None);
}

#[tokio::test]
async fn names_the_serial_it_could_not_find() {
    let hid = two_bricks();
    let error = open(&hid, Some("00165300000a")).await.err().unwrap();
    assert_eq!(
        error,
        "No EV3 USB HID device found for serial 00165300000A (vendor=0x0694, product=0x0005)."
    );
    let none = Arc::new(FakeHid::new(vec![]));
    assert_eq!(
        open(&none, None).await.err().unwrap(),
        "No EV3 USB HID device found (vendor=0x0694, product=0x0005)."
    );
}

#[tokio::test]
async fn writes_the_report_id_then_the_packet_padded_to_64_bytes() {
    let hid = two_bricks();
    hid.queue_report(report(&reply_packet(1, &[0x02, 0x00])));
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    let command = command_of(1, 16);
    let reply = link.send(&command, &expecting(1)).await.unwrap();
    assert_eq!(reply, reply_packet(1, &[0x02, 0x00]));

    let written = hid.log.lock().unwrap().written.clone();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0].len(), 65, "one report id plus 64 bytes");
    assert_eq!(written[0][0], 0);
    assert_eq!(&written[0][1..17], command.as_slice());
    assert!(written[0][17..].iter().all(|b| *b == 0));
}

#[tokio::test]
async fn refuses_a_packet_that_does_not_fit_one_report() {
    let hid = two_bricks();
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    let error = link
        .send(&command_of(1, 65), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB packet of 65 bytes exceeds the 64 bytes a HID write delivers on this transport. \
         Split it, or move bulk transfer to the libusb path."
    );
    assert!(hid.log.lock().unwrap().written.is_empty());
}

#[tokio::test]
async fn a_short_write_is_silent_corruption_and_fails() {
    // The OS drops the tail and the brick still advances its file pointer by the length the
    // packet declares, so a truncated upload would report success and land zero padding.
    let mut fake = FakeHid::new(vec![FakeHid::brick("hid-2", SERIAL, None)]);
    fake.write_reports = Some(33);
    let hid = Arc::new(fake);
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    let error = link
        .send(&command_of(1, 7), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB HID write delivered 33 of 65 bytes. Packets must stay within 64 bytes on this \
         transport."
    );
}

#[tokio::test]
async fn a_write_whose_count_the_backend_did_not_give_is_not_a_short_one() {
    // hidapi on Windows answers 0 for a write that completed at once.
    let mut fake = FakeHid::new(vec![FakeHid::brick("hid-2", SERIAL, None)]);
    fake.write_reports = Some(0);
    let hid = Arc::new(fake);
    hid.queue_report(report(&reply_packet(1, &[0x02])));
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
}

#[tokio::test]
async fn drops_a_report_id_left_in_front_of_the_reply() {
    let hid = two_bricks();
    let mut with_id = vec![0x00];
    with_id.extend(report(&reply_packet(1, &[0x02, 0x07])));
    hid.queue_report(with_id);
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    let reply = link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
    assert_eq!(reply, reply_packet(1, &[0x02, 0x07]));
}

#[tokio::test]
async fn a_reply_left_from_an_abandoned_exchange_is_dropped_when_the_next_request_goes_out() {
    let hid = two_bricks();
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    let silent = link
        .send(
            &command_of(1, 7),
            &SendOptions {
                timeout: Some(Duration::from_millis(50)),
                expected_message_counter: Some(1),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(silent.code, ev3_transports::ErrorCode::Timeout);
    hid.queue_report(report(&reply_packet(2, &[0x05])));
    let reply = link.send(&command_of(2, 7), &expecting(2)).await.unwrap();
    assert_eq!(reply, reply_packet(2, &[0x05]));
}

#[tokio::test]
async fn a_closed_link_reports_no_packet_size_and_refuses_to_send() {
    let hid = two_bricks();
    let link = open(&hid, Some(SERIAL)).await.unwrap();
    link.close().await;
    assert_eq!(link.max_packet_bytes(), None);
    let error = link
        .send(&command_of(1, 7), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(error.message, "USB transport is not open.");
}
