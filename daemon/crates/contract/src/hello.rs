//! The proofs of the hello that opens every connection: both sides prove they hold the user's key.
//!
//! 1. The client sends `hello/start` with a fresh nonce and who it is.
//! 2. The daemon answers with its own nonce and its proof over both nonces. A client that cannot
//!    verify that proof is talking to something else and closes.
//! 3. The client sends `hello/finish` with its proof. The daemon accepts, or closes the connection.
//!
//! The proofs are HMAC-SHA256 over a label and both nonces, so one side's proof can never be
//! replayed as the other's.

use hmac::{Hmac, Mac};
use sha2::Sha256;

fn proof(key: &[u8], label: &str, client_nonce: &str, daemon_nonce: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(format!("{label}\n{client_nonce}\n{daemon_nonce}").as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The daemon's proof, lowercase hex.
pub fn daemon_proof(key: &[u8], client_nonce: &str, daemon_nonce: &str) -> String {
    proof(key, "daemon", client_nonce, daemon_nonce)
}

/// The client's proof, lowercase hex.
pub fn client_proof(key: &[u8], client_nonce: &str, daemon_nonce: &str) -> String {
    proof(key, "client", client_nonce, daemon_nonce)
}

/// Whether a proof received equals the one expected, compared in time that does not depend on
/// where they differ.
pub fn proofs_match(expected: &str, received: &str) -> bool {
    let (a, b) = (expected.as_bytes(), received.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_compare_whole() {
        assert!(proofs_match("abcd", "abcd"));
        assert!(!proofs_match("abcd", "abce"));
        assert!(!proofs_match("abcd", "abc"));
        assert!(!proofs_match("abcd", ""));
    }

    #[test]
    fn the_two_sides_proofs_differ_for_the_same_nonces() {
        let key = [3u8; 32];
        assert_ne!(daemon_proof(&key, "a", "b"), client_proof(&key, "a", "b"));
    }
}
