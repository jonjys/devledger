//! Blind indexing for duplicate detection over encrypted values.
//!
//! DevLedger needs to answer "have I already stored this exact secret?" without
//! ever storing or comparing plaintext. Each value is normalised, then run
//! through HMAC-SHA256 under a per-vault index key that is derived from the
//! master key and never leaves Rust. The first 16 bytes of the tag are stored
//! alongside the row and compared for equality.
//!
//! The index is deterministic within a vault and useless outside it: without
//! the index key a stolen database yields no way to test a guessed value, and
//! two different vaults produce unrelated indexes for the same secret.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::error::{CoreError, Result};
use crate::secret::SecretBytes;

type HmacSha256 = Hmac<Sha256>;

/// Number of tag bytes retained. 128 bits keeps collisions negligible.
pub const INDEX_LEN: usize = 16;

/// Domain separator for secret values.
pub const DOMAIN_SECRET_VALUE: &str = "secret-value";
/// Domain separator for provider project references.
pub const DOMAIN_PROJECT_REF: &str = "project-ref";
/// Domain separator for identity email addresses.
pub const DOMAIN_IDENTITY_EMAIL: &str = "identity-email";

/// Compute the blind index of `value` within `domain`.
///
/// `value` is normalised first (see [`normalize`]) so that trivially different
/// spellings of the same secret still collide, which is what makes duplicate
/// detection useful.
pub fn blind_index(index_key: &SecretBytes, domain: &str, value: &str) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(index_key.expose())
        .map_err(|_| CoreError::Crypto("blind index key has the wrong length".into()))?;
    mac.update(domain.as_bytes());
    mac.update(&[0x00]);
    mac.update(normalize(value).as_bytes());
    let tag = mac.finalize().into_bytes();
    Ok(super::kdf::hex_encode(&tag[..INDEX_LEN]))
}

/// Normalise a value before indexing.
///
/// Surrounding whitespace and a single layer of wrapping quotes are stripped,
/// because `.env` files and dashboards disagree about both. Case is preserved:
/// API keys are case-sensitive and folding it would create false duplicates.
pub fn normalize(value: &str) -> String {
    let trimmed = value.trim();
    let unquoted = if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            &trimmed[1..trimmed.len() - 1]
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    unquoted.trim().to_string()
}
