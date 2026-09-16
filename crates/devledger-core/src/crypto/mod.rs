//! Cryptographic primitives. Everything security-relevant lives behind this
//! module so the rest of the core never touches a cipher directly.

pub mod aead;
pub mod blind_index;
pub mod kdf;

use hmac::{Hmac, KeyInit, Mac};
use rand::{rng, Rng};
use sha2::Sha256;

use crate::error::{CoreError, Result};
use crate::secret::SecretBytes;

type HmacSha256 = Hmac<Sha256>;

/// Label for the subkey handed to SQLCipher as the database key.
pub const LABEL_DATABASE: &str = "devledger/v1/database";
/// Label for the subkey that encrypts individual secret values.
pub const LABEL_SECRET_AEAD: &str = "devledger/v1/secret-aead";
/// Label for the subkey backing blind indexes.
pub const LABEL_BLIND_INDEX: &str = "devledger/v1/blind-index";

/// Fill a fresh buffer of `len` bytes from the OS CSPRNG.
pub(crate) fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rng().fill_bytes(&mut buf);
    buf
}

/// Derive a labelled 32-byte subkey from the master key.
///
/// This is HKDF-Expand with a single-block output: `HMAC(master, label || 0x01)`.
/// Distinct labels give independent keys, so compromising the blind-index key
/// reveals nothing about the database or AEAD keys.
pub fn derive_subkey(master: &SecretBytes, label: &str) -> Result<SecretBytes> {
    let mut mac = HmacSha256::new_from_slice(master.expose())
        .map_err(|_| CoreError::Crypto("master key has the wrong length".into()))?;
    mac.update(label.as_bytes());
    mac.update(&[0x01]);
    Ok(SecretBytes::new(mac.finalize().into_bytes().to_vec()))
}
