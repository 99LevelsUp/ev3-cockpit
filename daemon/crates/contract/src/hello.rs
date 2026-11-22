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
