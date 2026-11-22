//! Which name a discovered brick gets, why it must not change on connect, and which bricks a
//! scan lists on each platform.
//!
//! libusb reads the product string off the hardware; hidapi returns the operating system's
//! descriptor cache, which on Windows called two bricks of three "Xfer data to and from EV3
//! brick" on the machine this was found on. Discovery skips a brick whose interface a link
//! holds, so a connected brick has no libusb name to offer; without the remembered name it
//! renamed itself to the cached one the moment someone connected to it.

mod usb_fake;

use std::sync::Arc;
use std::time::Duration;

use ev3_transports::usb::{
    HidDeviceInfo, Platform, UsbError, UsbProviderOptions, UsbTransportProvider,
};
use ev3_transports::{BrickKey, NameSource, Transport, TransportProvider};
use usb_fake::{FakeBus, FakeHid, Spec};

const SERIAL: &str = "00165300000A";
const CACHED: &str = "Xfer data to and from EV3 brick";

fn key() -> BrickKey {
    BrickKey::new(Transport::Usb, SERIAL).unwrap()
}

/// What hidapi lists: present, with the stale cached product string.
fn hid_device() -> HidDeviceInfo {
    FakeHid::brick("hid-path-1", SERIAL, Some(CACHED))
}

/// What libusb reads when it may open the device.
fn usb_device() -> Spec {
    Spec {
        product: Some("AAA".into()),
        bus: 1,
        address: Some(4),
        ..Spec::serial(SERIAL)
    }
}

struct Rig {
    provider: UsbTransportProvider,
    bus: Arc<FakeBus>,
    hid: Arc<FakeHid>,
}

fn rig(platform: Platform, usb: Vec<Spec>, hid: Vec<HidDeviceInfo>) -> Rig {
    let bus = FakeBus::new(usb);
    let hid = Arc::new(FakeHid::new(hid));
    let provider = UsbTransportProvider::with_backends(
        bus.clone(),
        Some(hid.clone()),
        UsbProviderOptions {
            platform,
            udev_rule_path: None,
            log: None,
            send_timeout: Duration::from_secs(1),
        },
    );
    Rig { provider, bus, hid }
}

#[tokio::test]
async fn prefers_the_name_read_off_the_hardware_over_the_cache() {
    let rig = rig(Platform::Windows, vec![usb_device()], vec![hid_device()]);
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.transport, Transport::Usb);
    assert_eq!(scan.items.len(), 1);
    assert_eq!(scan.items[0].brick_key, key());
    assert_eq!(scan.items[0].display_name, "AAA");
    assert_eq!(scan.items[0].name_source, Some(NameSource::UsbDescriptor));
    assert!(!scan.items[0].connected);
    // Opened only to read the strings, and closed again.
    let log = rig.bus.log.get();
    assert_eq!(log.opened, log.closed);
}

#[tokio::test]
async fn never_opens_a_connected_brick_and_keeps_the_name_read_before() {
    let rig = rig(Platform::Windows, vec![usb_device()], vec![hid_device()]);
    rig.provider.discover().await.unwrap();
    rig.provider.connect(&key()).await.unwrap();
    let opened_before = rig.bus.log.get().opened.len();

    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(
        rig.bus.log.get().opened.len(),
        opened_before,
        "a scan must not open a brick a session has claimed"
    );
    assert_eq!(scan.items[0].display_name, "AAA", "no rename on connect");
    assert!(scan.items[0].connected);
}

#[tokio::test]
async fn falls_back_to_the_cache_only_when_the_hardware_was_never_read() {
    let unreadable = Spec {
        open_error: Some(UsbError::Access),
        ..usb_device()
    };
    let rig = rig(Platform::Windows, vec![unreadable], vec![hid_device()]);
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items[0].display_name, CACHED);
    assert_eq!(scan.items[0].name_source, Some(NameSource::UsbDescriptor));
}

#[tokio::test]
async fn falls_back_to_the_serial_when_neither_source_offers_a_name() {
    let rig = rig(
        Platform::Windows,
        vec![],
        vec![FakeHid::brick("hid-path-1", SERIAL, None)],
    );
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items[0].display_name, SERIAL);
    assert_eq!(scan.items[0].name_source, Some(NameSource::Fallback));
}

#[tokio::test]
async fn drops_a_hid_device_with_a_blank_serial_instead_of_the_whole_scan() {
    let rig = rig(
        Platform::Windows,
        vec![],
        vec![FakeHid::brick("hid-path-0", "   ", None), hid_device()],
    );
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items.len(), 1);
    assert_eq!(scan.items[0].brick_key, key());
}

#[tokio::test]
async fn a_scan_already_running_answers_for_a_second_and_a_scan_given_up_on_blocks_none_later() {
    // A probe whose clear-halt libusb still holds keeps the bus busy, so a scan waits for it.
    let rig = Arc::new(rig(
        Platform::Linux,
        vec![Spec {
            kernel_driver_active: true,
            hold_clear_halt: true,
            ..usb_device()
        }],
        vec![hid_device()],
    ));
    let probing = tokio::spawn({
        let rig = rig.clone();
        async move { rig.provider.open_probe(&key()).await.map(|_| ()) }
    });
    rig.bus
        .log
        .wait_until("the probe's clear-halt", |log| {
            log.held_clear_halts.len() == 1
        })
        .await;

    let given_up = tokio::time::timeout(Duration::from_millis(30), rig.provider.discover()).await;
    assert!(given_up.is_err(), "the scan waits for the bus");
    let waiting = tokio::spawn({
        let rig = rig.clone();
        async move { rig.provider.discover().await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let second = rig.provider.discover().await.unwrap();
    assert!(
        second.items.is_empty(),
        "a scan already running answers for this one"
    );

    rig.bus.log.answer_clear_halt(0);
    rig.bus
        .log
        .wait_until("the second clear-halt", |log| {
            log.held_clear_halts.len() == 1
        })
        .await;
    rig.bus.log.answer_clear_halt(0);
    probing.await.unwrap().unwrap();
    assert_eq!(waiting.await.unwrap().unwrap().items.len(), 1);
    assert_eq!(
        rig.provider.discover().await.unwrap().items.len(),
        1,
        "the scan given up on left nothing behind"
    );
}

// ── A brick libusb holds (Linux) ──────────────────────────────────────────────────────────
// The libusb claim takes the interface from `usbhid`, and the brick's hidraw node goes with
// it, so hidapi stops listing a brick the moment it is connected.

async fn connected_on_linux() -> Rig {
    let rig = rig(Platform::Linux, vec![usb_device()], vec![hid_device()]);
    rig.provider.discover().await.unwrap();
    rig.provider.connect(&key()).await.unwrap();
    rig
}

#[tokio::test]
async fn linux_still_lists_a_connected_brick_hidapi_no_longer_sees_under_its_known_name() {
    let rig = connected_on_linux().await;
    rig.hid.set_devices(vec![]);
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items.len(), 1);
    assert_eq!(scan.items[0].display_name, "AAA");
    assert!(scan.items[0].connected);
}

#[tokio::test]
async fn linux_drops_a_connected_brick_whose_cable_is_out_without_waiting_for_the_heartbeat() {
    let rig = connected_on_linux().await;
    rig.hid.set_devices(vec![]);
    rig.bus.unplug_all();
    let scan = rig.provider.discover().await.unwrap();
    assert!(scan.items.is_empty());
}

#[tokio::test]
async fn linux_lists_a_connected_brick_once_when_hidapi_still_sees_it() {
    let rig = connected_on_linux().await;
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items.len(), 1);
    assert!(scan.items[0].connected);
}

#[tokio::test]
async fn windows_lists_a_connected_brick_from_hidapi_alone() {
    let rig = rig(Platform::Windows, vec![usb_device()], vec![hid_device()]);
    rig.provider.connect(&key()).await.unwrap();
    rig.hid.set_devices(vec![]);
    let scan = rig.provider.discover().await.unwrap();
    assert!(scan.items.is_empty());
}

// ── A brick only libusb sees (Linux) ──────────────────────────────────────────────────────
// An extension host that died holding a brick never gave `usbhid` back, so the brick has no
// hidraw node; libusb still sees it, and a libusb connect needs no driver to detach.

#[tokio::test]
async fn linux_lists_a_brick_libusb_enumerates_when_hidapi_does_not() {
    let rig = rig(Platform::Linux, vec![usb_device()], vec![]);
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items.len(), 1);
    assert_eq!(scan.items[0].brick_key, key());
    assert_eq!(scan.items[0].display_name, "AAA");
}

#[tokio::test]
async fn linux_lists_a_brick_both_enumerations_see_once() {
    let rig = rig(Platform::Linux, vec![usb_device()], vec![hid_device()]);
    let scan = rig.provider.discover().await.unwrap();
    assert_eq!(scan.items.len(), 1);
}

#[tokio::test]
async fn windows_lists_from_hidapi_alone() {
    let rig = rig(Platform::Windows, vec![usb_device()], vec![]);
    let scan = rig.provider.discover().await.unwrap();
    assert!(scan.items.is_empty());
}
