//! The libusb link, and the measured quirks that make it work at all: a transfer shorter than
//! `wMaxPacketSize` is refused by libusb, every read comes back full-length so a reply is found
//! by its own length prefix, and on Windows a read writes one byte past the frame.

mod usb_fake;

use std::sync::Arc;
use std::time::{Duration, Instant};

use ev3_transports::usb::{
    EndpointDirection, EndpointInfo, LibusbLink, Platform, TransferKind, UsbError, UsbLink,
    UsbLocation,
};
use ev3_transports::{ErrorCode, SendOptions};
use usb_fake::{
    FRAME, FakeBus, Spec, command_of, interrupt_pair, open_options, padded, reply_packet,
    unreadable,
};

fn expecting(counter: u16) -> SendOptions {
    SendOptions {
        expected_message_counter: Some(counter),
        ..SendOptions::default()
    }
}

async fn open(bus: &Arc<FakeBus>, platform: Platform, serial: Option<&str>) -> LibusbLink {
    LibusbLink::open(bus.clone(), open_options(platform, serial))
        .await
        .unwrap()
}

async fn open_error(bus: &Arc<FakeBus>, platform: Platform, serial: Option<&str>) -> String {
    match LibusbLink::open(bus.clone(), open_options(platform, serial)).await {
        Ok(_) => panic!("the open should have failed"),
        Err(error) => error.message,
    }
}

// ── Closing with a transfer still in libusb ───────────────────────────────────────────────

#[tokio::test]
async fn close_waits_for_an_abandoned_read_before_releasing_and_closing_the_device() {
    // A send that timed out leaves its libusb transfer pending. Releasing the interface and
    // closing the device under it let the late callback land in freed native memory in the Node
    // extension host (30.10.2026).
    let bus = FakeBus::new(vec![Spec {
        hold_reads: 1,
        ..Spec::serial("001653AABBCC")
    }]);
    let link = Arc::new(open(&bus, Platform::Windows, Some("001653AABBCC")).await);
    bus.log.get().events.clear(); // finding the device by serial opened it once
    let error = link
        .send(
            &command_of(1, 7),
            &SendOptions {
                timeout: Some(Duration::from_millis(30)),
                expected_message_counter: Some(1),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);

    let closing = tokio::spawn({
        let link = link.clone();
        async move { link.close().await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        bus.log.events(),
        Vec::<String>::new(),
        "nothing may be released while libusb still holds a transfer"
    );

    bus.log.answer_read(Err(UsbError::Interrupted));
    closing.await.unwrap();
    drop(link);
    assert_eq!(bus.log.events(), ["read-callback", "release", "close"]);
}

#[tokio::test]
async fn close_gives_up_waiting_after_three_seconds_and_releases_anyway() {
    let bus = FakeBus::new(vec![Spec {
        hold_reads: 1,
        ..Spec::default()
    }]);
    let link = Arc::new(open(&bus, Platform::Windows, None).await);
    let _ = link
        .send(
            &command_of(1, 7),
            &SendOptions {
                timeout: Some(Duration::from_millis(10)),
                expected_message_counter: Some(1),
            },
        )
        .await;
    let started = Instant::now();
    link.close().await;
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(2900) && waited < Duration::from_millis(4000),
        "waited {waited:?}"
    );
    assert_eq!(bus.log.get().released, 1);
    bus.log.release_all();
}

#[tokio::test]
async fn a_close_during_an_exchange_ends_it_with_a_transport_failure() {
    let bus = FakeBus::new(vec![Spec {
        hold_reads: 1,
        ..Spec::default()
    }]);
    let link = Arc::new(open(&bus, Platform::Windows, None).await);
    let exchange = tokio::spawn({
        let link = link.clone();
        async move { link.send(&command_of(1, 7), &expecting(1)).await }
    });
    bus.log
        .wait_until("the read", |log| log.held_reads.len() == 1)
        .await;
    let closing = tokio::spawn({
        let link = link.clone();
        async move { link.close().await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    bus.log.answer_read(Ok(padded(1, &[0x02, 0x00])));
    let error = exchange.await.unwrap().unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert_eq!(
        error.message,
        "USB transport was closed during the exchange."
    );
    closing.await.unwrap();
}

#[tokio::test]
async fn a_closed_link_refuses_to_send() {
    let bus = FakeBus::new(vec![Spec::default()]);
    let link = open(&bus, Platform::Windows, None).await;
    link.close().await;
    let error = link
        .send(&command_of(1, 7), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(error.message, "USB transport is not open.");
}

// ── Packet size ───────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn reports_the_frame_the_endpoint_advertises_until_it_is_closed() {
    let bus = FakeBus::new(vec![Spec::default()]);
    let link = open(&bus, Platform::Windows, None).await;
    assert_eq!(link.max_packet_bytes(), Some(FRAME));
    link.close().await;
    assert_eq!(link.max_packet_bytes(), None);
}

#[tokio::test]
async fn takes_the_smaller_of_the_two_directions_when_they_disagree() {
    let bus = FakeBus::new(vec![Spec {
        endpoints: interrupt_pair(512, 1024),
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    assert_eq!(link.max_packet_bytes(), Some(512));
}

#[tokio::test]
async fn refuses_a_packet_larger_than_the_frame_instead_of_truncating_it() {
    let bus = FakeBus::new(vec![Spec::default()]);
    let link = open(&bus, Platform::Windows, None).await;
    let error = link
        .send(&vec![0u8; FRAME + 1], &SendOptions::default())
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB packet of 1025 bytes exceeds the 1024-byte frame this endpoint carries."
    );
    assert!(bus.log.get().sent.is_empty());
}

// ── The transfer quirks ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_16_byte_command_is_sent_padded_to_the_full_frame() {
    // Measured, not stylistic: libusb fails a short interrupt transfer with LIBUSB_ERROR_IO, and
    // the same packet padded to 1024 succeeds.
    let bus = FakeBus::new(vec![Spec {
        replies: vec![padded(1, &[0x02, 0x00])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let command = command_of(1, 16);
    link.send(&command, &expecting(1)).await.unwrap();

    let sent = bus.log.get().sent.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].len(), FRAME);
    assert_eq!(&sent[0][..16], command.as_slice());
    assert!(
        sent[0][16..].iter().all(|b| *b == 0),
        "the tail must be padding"
    );
}

#[tokio::test]
async fn a_write_is_complete_when_libusb_reports_at_least_the_frame() {
    // libusb's HID backend on Windows counts the report id: 1025 written for a 1024-byte frame.
    let bus = FakeBus::new(vec![Spec {
        write_reports: Some(FRAME + 1),
        replies: vec![padded(1, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
}

#[tokio::test]
async fn a_short_write_is_a_failure_not_a_slow_path() {
    let bus = FakeBus::new(vec![Spec {
        write_reports: Some(1000),
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let error = link
        .send(&command_of(1, 7), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(error.message, "USB send delivered 1000 of 1024 bytes.");
}

#[tokio::test]
async fn trims_a_full_frame_reply_down_to_the_packet_it_declares() {
    let bus = FakeBus::new(vec![Spec {
        replies: vec![padded(1, &[0x02, 0x00, 0x63])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    let reply = link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
    assert_eq!(bus.log.get().read_lengths[0], FRAME);
    assert_eq!(reply, [6, 0, 1, 0, 0x03, 0x02, 0x00, 0x63]);
}

#[tokio::test]
async fn on_windows_a_read_leaves_room_for_the_byte_libusb_writes_past_the_frame() {
    // libusb's HID backend copies the report id's byte too: a 1024-byte read writes 1025.
    let mut reply1025 = padded(1, &[0x02, 0x00, 0x63]);
    reply1025.push(0x00);
    let bus = FakeBus::new(vec![Spec {
        replies: vec![reply1025],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let reply = link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
    assert_eq!(bus.log.get().read_lengths[0], FRAME + 1);
    assert_eq!(reply, [6, 0, 1, 0, 0x03, 0x02, 0x00, 0x63]);
}

#[tokio::test]
async fn elsewhere_a_read_asks_for_exactly_the_frame() {
    // A full packet is not a short one, and a longer read would wait for more.
    let bus = FakeBus::new(vec![Spec {
        replies: vec![padded(1, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
    assert_eq!(bus.log.get().read_lengths, [FRAME]);
}

#[tokio::test]
async fn rejects_a_reply_that_declares_more_than_the_transfer_carried() {
    let bus = FakeBus::new(vec![Spec {
        replies: vec![unreadable()],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let error = link
        .send(&command_of(1, 7), &SendOptions::default())
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB reply of 1024 bytes is shorter than the packet it declares."
    );
}

// ── Reply matching ────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn steps_over_a_reply_left_behind_by_an_abandoned_exchange() {
    let bus = FakeBus::new(vec![Spec {
        replies: vec![padded(7, &[0x02]), padded(8, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let reply = link.send(&command_of(8, 7), &expecting(8)).await.unwrap();
    assert_eq!(reply, reply_packet(8, &[0x02]));
}

#[tokio::test]
async fn gives_up_rather_than_spinning_on_a_channel_that_stays_out_of_step() {
    let bus = FakeBus::new(vec![Spec {
        replies: (0..12).map(|_| padded(7, &[0x02])).collect(),
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let error = link
        .send(&command_of(99, 7), &expecting(99))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB reply stream stayed out of step after 4 stale replies."
    );
}

#[tokio::test]
async fn a_second_send_waits_for_the_first_and_each_gets_its_own_reply() {
    let bus = FakeBus::new(vec![Spec {
        replies: vec![padded(1, &[0x01]), padded(2, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let (one, two) = (command_of(1, 7), command_of(2, 7));
    let (expect_one, expect_two) = (expecting(1), expecting(2));
    let (first, second) = tokio::join!(link.send(&one, &expect_one), link.send(&two, &expect_two),);
    assert_eq!(first.unwrap(), reply_packet(1, &[0x01]));
    assert_eq!(second.unwrap(), reply_packet(2, &[0x02]));
}

#[tokio::test]
async fn an_abandoned_read_cannot_take_the_next_exchanges_reply() {
    // The read of an exchange whose caller gave up stays with libusb until libusb's own
    // timeout. The next exchange waits for it rather than racing it for the reply.
    let bus = FakeBus::new(vec![Spec {
        hold_reads: 1,
        replies: vec![padded(2, &[0x22])],
        ..Spec::default()
    }]);
    let link = Arc::new(open(&bus, Platform::Windows, None).await);
    let abandoned = tokio::time::timeout(
        Duration::from_millis(30),
        link.send(&command_of(1, 7), &expecting(1)),
    )
    .await;
    assert!(
        abandoned.is_err(),
        "the caller gave up on the first exchange"
    );

    let next = tokio::spawn({
        let link = link.clone();
        async move { link.send(&command_of(2, 7), &expecting(2)).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        bus.log.get().sent.len(),
        1,
        "the next request waits for the read still out"
    );
    // The first exchange's late reply lands in its own read, which nobody reads any more.
    bus.log.answer_read(Ok(padded(1, &[0x11])));
    assert_eq!(next.await.unwrap().unwrap(), reply_packet(2, &[0x22]));
}

// ── Device selection ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn claims_the_brick_whose_serial_was_asked_for() {
    let bus = FakeBus::new(vec![
        Spec::serial("001653AABBCC"),
        Spec {
            address: Some(11),
            ..Spec::serial("001653DDEEFF")
        },
    ]);
    let link = open(&bus, Platform::Windows, Some("001653ddeeff")).await;
    assert_eq!(
        link.location(),
        Some(UsbLocation {
            bus: 2,
            address: 11
        })
    );
}

#[tokio::test]
async fn closes_the_devices_it_opened_only_to_read_their_serial() {
    let bus = FakeBus::new(vec![
        Spec::serial("001653AABBCC"),
        Spec::serial("001653DDEEFF"),
    ]);
    let _link = open(&bus, Platform::Windows, Some("001653ddeeff")).await;
    let log = bus.log.get();
    assert!(log.closed.contains(&"001653AABBCC".to_owned()));
    assert!(!log.closed.contains(&"001653DDEEFF".to_owned()));
}

#[tokio::test]
async fn never_opens_a_device_another_session_is_holding() {
    // libusb hands out one handle per device: opening and closing a brick another session has
    // claimed drops that handle (verified on hardware: connecting a second brick killed the
    // first).
    let bus = FakeBus::new(vec![
        Spec {
            address: Some(10),
            ..Spec::serial("001653AABBCC")
        },
        Spec {
            address: Some(11),
            ..Spec::serial("001653DDEEFF")
        },
    ]);
    let mut options = open_options(Platform::Windows, Some("001653ddeeff"));
    options.in_use = vec![UsbLocation {
        bus: 2,
        address: 10,
    }];
    let link = LibusbLink::open(bus.clone(), options).await.unwrap();
    assert!(
        !bus.log.get().opened.contains(&"001653AABBCC".to_owned()),
        "the in-use brick must not be opened even to read its serial"
    );
    assert_eq!(
        link.location(),
        Some(UsbLocation {
            bus: 2,
            address: 11
        })
    );
}

#[tokio::test]
async fn without_a_serial_takes_the_first_brick_nobody_holds() {
    let bus = FakeBus::new(vec![
        Spec::serial("001653AABBCC"),
        Spec::serial("001653DDEEFF"),
    ]);
    let mut options = open_options(Platform::Windows, None);
    options.in_use = vec![UsbLocation {
        bus: 2,
        address: 10,
    }];
    let link = LibusbLink::open(bus.clone(), options).await.unwrap();
    assert_eq!(
        link.location(),
        Some(UsbLocation {
            bus: 2,
            address: 11
        })
    );
    assert_eq!(bus.log.get().opened, ["001653DDEEFF"]);
}

#[tokio::test]
async fn names_the_serial_it_could_not_find() {
    let bus = FakeBus::new(vec![Spec::serial("001653AABBCC")]);
    assert_eq!(
        open_error(&bus, Platform::Windows, Some("001653ddeeff")).await,
        "No EV3 on the USB bus reports serial 001653DDEEFF."
    );
}

#[tokio::test]
async fn reports_an_empty_bus_rather_than_something_opaque() {
    let bus = FakeBus::new(vec![Spec {
        vendor_id: 0x1234,
        ..Spec::default()
    }]);
    assert_eq!(
        open_error(&bus, Platform::Windows, None).await,
        "No EV3 found on the USB bus."
    );
}

// ── Open failures release what they took ─────────────────────────────────────────────────

#[tokio::test]
async fn closes_the_device_when_the_interface_cannot_be_claimed() {
    let bus = FakeBus::new(vec![Spec {
        claim_error: Some(UsbError::Access),
        ..Spec::default()
    }]);
    assert_eq!(
        open_error(&bus, Platform::Windows, None).await,
        "Could not claim USB interface 0 on the brick. (LIBUSB_ERROR_ACCESS)"
    );
    assert_eq!(
        bus.log.get().closed.len(),
        1,
        "an unclaimed device must not keep its handle"
    );
}

#[tokio::test]
async fn rejects_an_interface_with_no_interrupt_endpoint_pair() {
    // Interface 1 on an EV3 is mass storage with bulk endpoints; picking endpoints by
    // direction alone would claim it and hang on the first transfer.
    let bulk = |address, direction| EndpointInfo {
        address,
        direction,
        transfer: TransferKind::Bulk,
        max_packet_size: 512,
    };
    let bus = FakeBus::new(vec![Spec {
        endpoints: vec![
            bulk(0x81, EndpointDirection::In),
            bulk(0x01, EndpointDirection::Out),
        ],
        ..Spec::default()
    }]);
    assert_eq!(
        open_error(&bus, Platform::Windows, None).await,
        "USB interface 0 has no interrupt endpoint pair."
    );
    let log = bus.log.get();
    assert_eq!(log.released, 1);
    assert_eq!(log.closed.len(), 1);
}

// ── A kernel driver holding the interface (Linux) ─────────────────────────────────────────

#[tokio::test]
async fn linux_turns_on_auto_detach_before_the_claim() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    assert_eq!(link.max_packet_bytes(), Some(FRAME));
    assert_eq!(
        bus.log.events()[..3],
        ["autoDetach:true", "auto-detached", "claim"]
    );
}

#[tokio::test]
async fn linux_without_auto_detach_detaches_before_the_claim_and_reattaches_after_the_release() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        auto_detach: false,
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    link.close().await;
    drop(link);
    assert_eq!(
        bus.log.events(),
        [
            "detach",
            "claim",
            "clearHalt:in",
            "clearHalt:out",
            "release",
            "attach",
            "close"
        ]
    );
}

#[tokio::test]
async fn linux_leaves_an_interface_no_kernel_driver_holds_alone() {
    let bus = FakeBus::new(vec![Spec {
        auto_detach: false,
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    link.close().await;
    drop(link);
    assert_eq!(
        bus.log.events(),
        ["claim", "clearHalt:in", "clearHalt:out", "release", "close"]
    );
}

#[tokio::test]
async fn linux_gives_the_driver_back_and_closes_when_the_claim_fails_after_a_detach() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        auto_detach: false,
        claim_error: Some(UsbError::Io),
        ..Spec::default()
    }]);
    assert_eq!(
        open_error(&bus, Platform::Linux, None).await,
        "Could not claim USB interface 0 on the brick. (LIBUSB_ERROR_IO)"
    );
    assert_eq!(bus.log.events(), ["detach", "attach", "close"]);
}

#[tokio::test]
async fn linux_clears_both_endpoints_after_the_claim_so_the_first_reply_arrives() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        replies: vec![padded(1, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    let events = bus.log.events();
    let claim = events.iter().position(|e| e == "claim").unwrap();
    let cleared_in = events.iter().position(|e| e == "clearHalt:in").unwrap();
    let cleared_out = events.iter().position(|e| e == "clearHalt:out").unwrap();
    assert!(cleared_in > claim && cleared_out > claim);
    let reply = link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
    assert_eq!(reply, reply_packet(1, &[0x02]));
}

#[tokio::test]
async fn windows_never_touches_the_kernel_driver() {
    let bus = FakeBus::new(vec![Spec::default()]);
    let link = open(&bus, Platform::Windows, None).await;
    link.close().await;
    drop(link);
    assert_eq!(
        bus.log.events(),
        ["claim", "release", "close"],
        "no detach and no clear-halt on Windows"
    );
}

// ── A device this user may not open (Linux) ───────────────────────────────────────────────

#[tokio::test]
async fn linux_says_permission_and_names_the_udev_rule_when_every_candidate_refuses() {
    // The serial lookup used to swallow LIBUSB_ERROR_ACCESS and say no brick reports the
    // serial, which sends a user looking for the wrong brick instead of at the permissions.
    let refusing = |serial: &str| Spec {
        open_error: Some(UsbError::Access),
        ..Spec::serial(serial)
    };
    let bus = FakeBus::new(vec![refusing("aaa"), refusing("bbb")]);
    let error = LibusbLink::open(bus.clone(), open_options(Platform::Linux, Some("aaa")))
        .await
        .err()
        .unwrap();
    assert_eq!(error.permission, Some(UsbError::Access));
    assert!(
        error.message.contains("LIBUSB_ERROR_ACCESS"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("native/linux/70-lego-ev3.rules"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("/etc/udev/rules.d"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn linux_names_the_rule_where_this_install_keeps_it_and_the_plugdev_group() {
    let rule = "/opt/example/ev3-cockpit/native/linux/70-lego-ev3.rules";
    let bus = FakeBus::new(vec![Spec {
        open_error: Some(UsbError::Access),
        ..Spec::serial("aaa")
    }]);
    let mut options = open_options(Platform::Linux, Some("aaa"));
    options.udev_rule_path = Some(rule.into());
    let error = LibusbLink::open(bus.clone(), options).await.err().unwrap();
    assert!(
        error
            .message
            .contains(&format!("copy {rule} to /etc/udev/rules.d/")),
        "{}",
        error.message
    );
    assert!(error.message.contains("group plugdev"), "{}", error.message);
}

#[tokio::test]
async fn linux_says_permission_when_the_one_brick_it_would_take_refuses() {
    let bus = FakeBus::new(vec![Spec {
        open_error: Some(UsbError::Access),
        ..Spec::default()
    }]);
    let error = LibusbLink::open(bus.clone(), open_options(Platform::Linux, None))
        .await
        .err()
        .unwrap();
    assert_eq!(error.permission, Some(UsbError::Access));
}

#[tokio::test]
async fn linux_says_permission_when_a_device_it_could_not_open_might_be_the_brick_asked_for() {
    let bus = FakeBus::new(vec![
        Spec::serial("bbb"),
        Spec {
            open_error: Some(UsbError::Access),
            ..Spec::serial("ccc")
        },
    ]);
    let error = LibusbLink::open(bus.clone(), open_options(Platform::Linux, Some("aaa")))
        .await
        .err()
        .unwrap();
    assert_eq!(
        error.permission,
        Some(UsbError::Access),
        "a refusing device may be the brick asked for: its serial could not be read"
    );
}

#[tokio::test]
async fn windows_keeps_the_message_naming_the_serial() {
    let bus = FakeBus::new(vec![Spec {
        open_error: Some(UsbError::Access),
        ..Spec::serial("aaa")
    }]);
    let error = LibusbLink::open(bus.clone(), open_options(Platform::Windows, Some("aaa")))
        .await
        .err()
        .unwrap();
    assert_eq!(error.permission, None);
    assert_eq!(error.message, "No EV3 on the USB bus reports serial AAA.");
}

// ── A stale packet after a fresh plug (Linux) ─────────────────────────────────────────────

#[tokio::test]
async fn linux_steps_over_an_unreadable_reply_while_waiting_for_a_known_counter() {
    let bus = FakeBus::new(vec![Spec {
        replies: vec![unreadable(), padded(1, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    let reply = link.send(&command_of(1, 7), &expecting(1)).await.unwrap();
    assert_eq!(reply, reply_packet(1, &[0x02]));
}

#[tokio::test]
async fn linux_still_gives_up_on_a_channel_that_answers_nothing_readable() {
    let bus = FakeBus::new(vec![Spec {
        replies: (0..12).map(|_| unreadable()).collect(),
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    let error = link
        .send(&command_of(1, 7), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB reply stream stayed out of step after 4 stale replies."
    );
}

#[tokio::test]
async fn windows_keeps_rejecting_an_unreadable_reply() {
    let bus = FakeBus::new(vec![Spec {
        replies: vec![unreadable(), padded(1, &[0x02])],
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Windows, None).await;
    let error = link
        .send(&command_of(1, 7), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "USB reply of 1024 bytes is shorter than the packet it declares."
    );
}

// ── Clear-halt: best effort, bounded, counted ────────────────────────────────────────────

#[tokio::test]
async fn an_open_abandoned_during_the_clear_halt_gives_everything_back_once() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        auto_detach: false,
        hold_clear_halt: true,
        ..Spec::default()
    }]);
    let opening = tokio::spawn({
        let bus = bus.clone();
        async move { LibusbLink::open(bus, open_options(Platform::Linux, None)).await }
    });
    bus.log
        .wait_until("the clear-halt", |log| log.held_clear_halts.len() == 1)
        .await;
    opening.abort();
    let _ = opening.await;
    bus.log.answer_clear_halt(0);
    bus.log
        .wait_until("the close", |log| log.events.iter().any(|e| e == "close"))
        .await;
    let events = bus.log.events();
    assert_eq!(events[events.len() - 3..], ["release", "attach", "close"]);
    assert_eq!(
        events.iter().filter(|e| e.starts_with("clearHalt")).count(),
        1,
        "no second clear-halt after the open was abandoned"
    );
    assert_eq!(bus.log.get().released, 1);
}

#[tokio::test]
async fn an_open_abandoned_while_the_claim_runs_gives_everything_back_once_the_claim_lands() {
    // The caller stops waiting while libusb is still claiming: the claim lands afterwards on a
    // thread nobody waits for, and must still release the interface and give the kernel driver
    // back, or the brick stays without its driver.
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        auto_detach: false,
        hold_claim: true,
        ..Spec::serial("001653AABBCC")
    }]);
    let opening = tokio::spawn({
        let bus = bus.clone();
        async move { LibusbLink::open(bus, open_options(Platform::Linux, Some("001653AABBCC"))).await }
    });
    bus.log
        .wait_until("the claim", |log| log.held_claims.len() == 1)
        .await;
    opening.abort();
    let _ = opening.await;
    bus.log.answer_claim();
    bus.log
        .wait_until("the close", |log| log.events.iter().any(|e| e == "close"))
        .await;
    let log = bus.log.get();
    assert_eq!(
        log.events,
        ["detach", "claim", "release", "attach", "close"]
    );
    assert_eq!(
        log.opened, log.closed,
        "every device opened was closed again"
    );
}

#[tokio::test]
async fn opens_anyway_when_a_clear_halt_fails() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        clear_halt_error: Some(UsbError::Pipe),
        ..Spec::default()
    }]);
    let link = open(&bus, Platform::Linux, None).await;
    assert_eq!(link.max_packet_bytes(), Some(FRAME));
}

#[tokio::test]
async fn does_not_wait_for_ever_on_a_clear_halt_that_never_answers() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        hold_clear_halt: true,
        ..Spec::default()
    }]);
    let started = Instant::now();
    let link = open(&bus, Platform::Linux, None).await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(link.max_packet_bytes(), Some(FRAME));
    bus.log.release_all();
}

#[tokio::test]
async fn a_clear_halt_libusb_still_holds_keeps_the_close_waiting() {
    let bus = FakeBus::new(vec![Spec {
        kernel_driver_active: true,
        hold_clear_halt: true,
        ..Spec::default()
    }]);
    // Both clear-halts pass their limit; the open goes on while libusb still holds them.
    let link = Arc::new(open(&bus, Platform::Linux, None).await);
    assert_eq!(bus.log.held_clear_halts(), 2);
    bus.log.answer_clear_halt(1);

    let closing = tokio::spawn({
        let link = link.clone();
        async move { link.close().await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !closing.is_finished(),
        "the release waits for the clear-halt libusb still holds"
    );
    assert_eq!(bus.log.get().released, 0);
    bus.log.answer_clear_halt(0);
    closing.await.unwrap();
    assert_eq!(bus.log.get().released, 1);
}

#[tokio::test]
async fn a_second_close_waits_for_the_first_to_finish() {
    let bus = FakeBus::new(vec![Spec {
        hold_reads: 1,
        ..Spec::default()
    }]);
    let link = Arc::new(open(&bus, Platform::Linux, None).await);
    let _ = link
        .send(
            &command_of(1, 7),
            &SendOptions {
                timeout: Some(Duration::from_millis(10)),
                expected_message_counter: Some(1),
            },
        )
        .await;
    let close = |link: Arc<LibusbLink>| tokio::spawn(async move { link.close().await });
    let first = close(link.clone());
    let second = close(link.clone());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !second.is_finished(),
        "the release is still waiting for the read in flight"
    );
    bus.log.answer_read(Err(UsbError::Interrupted));
    first.await.unwrap();
    second.await.unwrap();
    assert_eq!(bus.log.get().released, 1);
}
