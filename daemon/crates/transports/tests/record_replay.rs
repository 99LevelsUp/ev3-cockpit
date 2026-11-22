//! Record and replay at the provider trait: the replay provider passes the same exchange tests
//! as the provider it recorded, strict replay reproduces a session and refuses a deviation, and
//! matched replay serves equal requests whatever their message counter.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{
    COUNTING, DROPS_LINK, ECHO, FakeConfig, FakeLinkProvider, LINK_FAILURE, SILENT, exchange_suite,
    reply_packet, request, temp_dir,
};
use ev3_transports::fixture::{FORMAT_VERSION, RECORDER_VERSION, RECORDING_FILE, to_hex};
use ev3_transports::{
    BrickKey, ErrorCode, Recorder, Replay, ReplayMode, Scrubber, SendOptions, Transport,
    TransportError, TransportProvider,
};

const SERIAL: &str = "001653F00A0A";

fn key() -> BrickKey {
    BrickKey::new(Transport::Usb, SERIAL).unwrap()
}

/// The fake brick's own serial while recording: made at run time, so no address-shaped literal
/// sits in the repository. The recording replaces it with the first placeholder, [SERIAL].
fn live_serial() -> String {
    format!("{:02X}{:010X}", 0x02, 0x00AB_CDEF_u64)
}

fn live_key() -> BrickKey {
    BrickKey::new(Transport::Usb, &live_serial()).unwrap()
}

fn expecting(counter: u16) -> SendOptions {
    SendOptions {
        expected_message_counter: Some(counter),
        ..SendOptions::default()
    }
}

/// Records whatever `session` does through a fake USB provider and returns the recording's text.
async fn record<F, Fut>(name: &str, session: F) -> String
where
    F: FnOnce(Arc<dyn TransportProvider>, fn() -> BrickKey) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let dir = temp_dir(name);
    let recorder = Recorder::create(&dir, name, Scrubber::new()).unwrap();
    let provider = recorder.wrap(Arc::new(FakeLinkProvider::new(FakeConfig::usb(
        &live_serial(),
    ))));
    session(provider, live_key).await;
    recorder.finish().unwrap();
    let text = std::fs::read_to_string(dir.join(RECORDING_FILE)).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    text
}

async fn record_suite() -> String {
    record("suite", |provider, key| async move {
        exchange_suite(provider.as_ref(), &key()).await;
    })
    .await
}

#[tokio::test(start_paused = true)]
async fn the_fake_link_provider_passes_the_exchange_suite() {
    let provider = FakeLinkProvider::new(FakeConfig::usb(SERIAL));
    exchange_suite(&provider, &key()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn providers_held_as_trait_objects_run_on_any_runtime_thread() {
    let provider: Arc<dyn TransportProvider> =
        Arc::new(FakeLinkProvider::new(FakeConfig::usb(SERIAL)));
    let task = tokio::spawn(async move {
        exchange_suite(provider.as_ref(), &key()).await;
    });
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_recording_starts_with_its_format_recorder_version_and_scenario() {
    let text = record_suite().await;
    let header: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(header["format"], FORMAT_VERSION);
    assert_eq!(header["recorder"], RECORDER_VERSION);
    assert_eq!(header["scenario"], "suite");
}

#[tokio::test(start_paused = true)]
async fn strict_replay_of_a_recorded_session_passes_the_same_suite_and_reproduces_it() {
    let text = record_suite().await;
    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    assert_eq!(provider.priority(), 30);
    assert!(provider.capabilities().supports_probe);
    exchange_suite(provider.as_ref(), &key()).await;
    replay.finish().unwrap();
}

#[tokio::test(start_paused = true)]
async fn matched_replay_passes_the_same_suite() {
    let text = record_suite().await;
    let replay = Replay::from_text(&text, ReplayMode::Matched).unwrap();
    exchange_suite(replay.provider(Transport::Usb).unwrap().as_ref(), &key()).await;
}

#[tokio::test(start_paused = true)]
async fn strict_replay_fails_a_deviating_request() {
    let text = record_suite().await;
    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.discover().await.unwrap();
    provider.connect(&key()).await.unwrap();
    // The recording's first exchange is ECHO 0x10 with counter 1.
    let error = provider
        .send_packet(&key(), &request(1, &[ECHO, 0x11]), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ReplayDeviation);
    // The message names both requests, so the deviation can be read off the failure.
    assert!(error.message.contains(&to_hex(&request(1, &[ECHO, 0x10]))));
    assert!(error.message.contains(&to_hex(&request(1, &[ECHO, 0x11]))));
}

#[tokio::test(start_paused = true)]
async fn strict_replay_fails_the_same_request_with_another_message_counter() {
    let text = record_suite().await;
    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.discover().await.unwrap();
    provider.connect(&key()).await.unwrap();
    let error = provider
        .send_packet(&key(), &request(9, &[ECHO, 0x10]), &expecting(9))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ReplayDeviation);
}

#[tokio::test(start_paused = true)]
async fn strict_replay_reports_a_session_that_did_less_than_the_recording() {
    let text = record_suite().await;
    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.discover().await.unwrap();
    provider.connect(&key()).await.unwrap();
    let error = replay.finish().unwrap_err();
    assert_eq!(error.code, ErrorCode::ReplayDeviation);
}

#[tokio::test(start_paused = true)]
async fn matched_replay_answers_an_equal_request_with_a_different_message_counter() {
    let text = record("counter", |provider, key| async move {
        provider.connect(&key()).await.unwrap();
        provider
            .send_packet(&key(), &request(1, &[ECHO, 0x20]), &expecting(1))
            .await
            .unwrap();
    })
    .await;
    let replay = Replay::from_text(&text, ReplayMode::Matched).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.connect(&key()).await.unwrap();
    let answer = provider
        .send_packet(&key(), &request(0x1234, &[ECHO, 0x20]), &expecting(0x1234))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(0x1234, &[ECHO + 1, 0x21]));
}

#[tokio::test(start_paused = true)]
async fn matched_replay_fails_a_request_it_has_no_recording_of() {
    let text = record_suite().await;
    let replay = Replay::from_text(&text, ReplayMode::Matched).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.connect(&key()).await.unwrap();
    let error = provider
        .send_packet(&key(), &request(1, &[ECHO, 0x7f]), &expecting(1))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ReplayUnmatched);
    assert_eq!(error.code.as_str(), "replay_unmatched");
}

#[tokio::test(start_paused = true)]
async fn a_recorded_link_failure_replays_as_the_same_failure() {
    let text = record("failure", |provider, key| async move {
        provider.connect(&key()).await.unwrap();
        let error = provider
            .send_packet(&key(), &request(1, &[DROPS_LINK]), &expecting(1))
            .await
            .unwrap_err();
        assert_eq!(error, TransportError::transport_failed(LINK_FAILURE));
    })
    .await;
    for mode in [ReplayMode::Strict, ReplayMode::Matched] {
        let replay = Replay::from_text(&text, mode).unwrap();
        let provider = replay.provider(Transport::Usb).unwrap();
        provider.connect(&key()).await.unwrap();
        let error = provider
            .send_packet(&key(), &request(1, &[DROPS_LINK]), &expecting(1))
            .await
            .unwrap_err();
        assert_eq!(error, TransportError::transport_failed(LINK_FAILURE));
    }
}

#[tokio::test(start_paused = true)]
async fn a_recorded_timeout_replays_after_the_recorded_time() {
    let text = record("timeout", |provider, key| async move {
        provider.connect(&key()).await.unwrap();
        let options = SendOptions {
            timeout: Some(Duration::from_millis(300)),
            expected_message_counter: Some(1),
        };
        provider
            .send_packet(&key(), &request(1, &[SILENT]), &options)
            .await
            .unwrap_err();
    })
    .await;
    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.connect(&key()).await.unwrap();
    let started = tokio::time::Instant::now();
    let error = provider
        .send_packet(&key(), &request(1, &[SILENT]), &SendOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(started.elapsed(), Duration::from_millis(300));
}

#[tokio::test(start_paused = true)]
async fn matched_replay_serves_two_equal_requests_their_replies_in_order_then_fails() {
    let text = record("twice", |provider, key| async move {
        provider.connect(&key()).await.unwrap();
        for counter in [1, 2] {
            provider
                .send_packet(&key(), &request(counter, &[COUNTING]), &expecting(counter))
                .await
                .unwrap();
        }
    })
    .await;
    let replay = Replay::from_text(&text, ReplayMode::Matched).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.connect(&key()).await.unwrap();
    let first = provider
        .send_packet(&key(), &request(40, &[COUNTING]), &expecting(40))
        .await
        .unwrap();
    let second = provider
        .send_packet(&key(), &request(41, &[COUNTING]), &expecting(41))
        .await
        .unwrap();
    assert_eq!(first, reply_packet(40, &[1]));
    assert_eq!(second, reply_packet(41, &[2]));
    let third = provider
        .send_packet(&key(), &request(42, &[COUNTING]), &expecting(42))
        .await
        .unwrap_err();
    assert_eq!(third.code, ErrorCode::ReplayUnmatched);
}

#[tokio::test(start_paused = true)]
async fn matched_replay_keeps_answering_discovery_with_the_last_scan_but_not_a_connect() {
    let text = record("polled", |provider, key| async move {
        provider.discover().await.unwrap();
        provider.connect(&key()).await.unwrap();
    })
    .await;
    let replay = Replay::from_text(&text, ReplayMode::Matched).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    for _ in 0..3 {
        let scan = provider.discover().await.unwrap();
        assert_eq!(scan.items[0].brick_key, key());
    }
    provider.connect(&key()).await.unwrap();
    let again = provider.connect(&key()).await.unwrap_err();
    assert_eq!(again.code, ErrorCode::ReplayUnmatched);
}

#[tokio::test(start_paused = true)]
async fn a_replayed_scan_is_as_fresh_as_when_it_was_recorded() {
    let text = record("fresh", |provider, _key| async move {
        provider.discover().await.unwrap();
    })
    .await;
    // Stored relative to the recording's start, not as the wall clock.
    let line: serde_json::Value = serde_json::from_str(text.lines().nth(2).unwrap()).unwrap();
    let stored = line["outcome"]["ok"]["items"][0]["last_seen_at"]
        .as_i64()
        .unwrap();
    assert!(stored.abs() < 60_000, "stored {stored}");

    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let scan = replay
        .provider(Transport::Usb)
        .unwrap()
        .discover()
        .await
        .unwrap();
    let age = common::now_epoch_ms() - scan.items[0].last_seen_at;
    // Seen as long after the replay started as it was after the recording started.
    assert!(age.abs() < 60_000, "age {age}");
}

#[tokio::test(start_paused = true)]
async fn an_exchange_its_caller_abandoned_is_recorded_and_replayed_as_abandoned() {
    let text = record("abandoned", |provider, key| async move {
        provider.connect(&key()).await.unwrap();
        let options = SendOptions {
            timeout: Some(Duration::ZERO),
            expected_message_counter: Some(1),
        };
        let gave_up = tokio::time::timeout(
            Duration::from_millis(200),
            provider.send_packet(&key(), &request(1, &[SILENT]), &options),
        )
        .await;
        assert!(gave_up.is_err());
        provider
            .send_packet(&key(), &request(2, &[ECHO]), &expecting(2))
            .await
            .unwrap();
    })
    .await;
    let replay = Replay::from_text(&text, ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    provider.connect(&key()).await.unwrap();
    let gave_up = tokio::time::timeout(
        Duration::from_secs(60),
        provider.send_packet(&key(), &request(1, &[SILENT]), &SendOptions::default()),
    )
    .await;
    assert!(
        gave_up.is_err(),
        "replay finished a call the recorded caller abandoned"
    );
    let answer = provider
        .send_packet(&key(), &request(2, &[ECHO]), &expecting(2))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(2, &[ECHO + 1]));
    replay.finish().unwrap();
}

#[tokio::test]
async fn a_recording_of_another_format_is_refused() {
    let text = format!(
        "{{\"format\":{},\"recorder\":1,\"scenario\":\"old\"}}\n",
        FORMAT_VERSION + 1
    );
    let error = Replay::from_text(&text, ReplayMode::Matched).err().unwrap();
    assert!(error.message.contains("Re-record"));
}

#[tokio::test]
async fn the_recorder_never_overwrites_a_recording() {
    let dir = temp_dir("overwrite");
    Recorder::create(&dir, "first", Scrubber::new()).unwrap();
    assert!(Recorder::create(&dir, "second", Scrubber::new()).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}
