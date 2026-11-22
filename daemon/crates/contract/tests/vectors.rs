//! The cross-language vectors in `contract/vectors/channel.json`: the hello proofs and the
//! `channel.json` record. The TypeScript test checks the same file.

mod common;

use common::contract_json;
use ev3_contract::ChannelRecord;
use ev3_contract::hello::{client_proof, daemon_proof};

fn hex_bytes(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn hello_proofs_match_the_vectors() {
    let vectors = contract_json("vectors/channel.json");
    let key = hex_bytes(vectors["hello"]["key"].as_str().expect("key"));
    assert_eq!(key.len(), 32);
    let cases = vectors["hello"]["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let client = case["clientNonce"].as_str().expect("clientNonce");
        let daemon = case["daemonNonce"].as_str().expect("daemonNonce");
        assert_eq!(daemon_proof(&key, client, daemon), case["daemonProof"]);
        assert_eq!(client_proof(&key, client, daemon), case["clientProof"]);
    }
}

#[test]
fn one_sides_proof_is_not_the_others() {
    let key = [7u8; 32];
    assert_ne!(daemon_proof(&key, "a", "b"), client_proof(&key, "a", "b"));
}

#[test]
fn channel_records_read_as_the_vectors_say() {
    let vectors = contract_json("vectors/channel.json");
    let records = vectors["channelRecord"].as_array().expect("records");
    assert!(records.len() >= 3);
    for record in records {
        let file = record["file"].as_str().expect("file");
        let parsed: ChannelRecord = serde_json::from_str(file).expect("channel.json parses");
        assert_eq!(parsed.path, record["path"].as_str().expect("path"));
        assert_eq!(parsed.pid, record["pid"].as_u64().expect("pid"));
    }
}

#[test]
fn the_daemon_writes_channel_records_as_the_vectors_say() {
    let vectors = contract_json("vectors/channel.json");
    for record in &vectors["channelRecord"].as_array().expect("records")[..2] {
        let written = serde_json::to_string(&ChannelRecord {
            path: record["path"].as_str().expect("path").to_string(),
            pid: record["pid"].as_u64().expect("pid"),
        })
        .expect("encodes");
        assert_eq!(written, record["file"].as_str().expect("file"));
    }
}
