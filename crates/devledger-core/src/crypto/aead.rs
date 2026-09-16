//! Authenticated encryption for secret values held inside the vault.
//!
//! Envelope layout, all bytes concatenated:
//!
//! ```text
//! [ version: 1 byte = 0x01 ][ nonce: 24 bytes ][ ciphertext || tag ]
//! ```
//!
//! XChaCha20-Poly1305 is used with a 192-bit random nonce, so nonce reuse is a
//! non-issue at any realistic volume of stored secrets. The caller-supplied
//! associated data binds each envelope to the row that owns it, which stops a
//! ciphertext from being moved between secrets inside the same vault.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};

use crate::error::{CoreError, Result};
use crate::secret::SecretBytes;

/// Envelope format version, written as the first byte.
pub const ENVELOPE_VERSION: u8 = 0x01;
/// XChaCha20-Poly1305 nonce length.
pub const NONCE_LEN: usize = 24;
/// Required key length.
pub const KEY_LEN: usize = 32;

fn cipher_for(key: &SecretBytes) -> Result<XChaCha20Poly1305> {
    if key.len() != KEY_LEN {
        return Err(CoreError::Crypto(format!(
            "aead key must be {KEY_LEN} bytes, got {}",
            key.len()
        )));
    }
    let key = Key::try_from(key.expose())
        .map_err(|_| CoreError::Crypto("aead key has the wrong length".into()))?;
    Ok(XChaCha20Poly1305::new(&key))
}

/// Encrypt `plaintext`, binding the result to `aad`.
pub fn seal(key: &SecretBytes, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = cipher_for(key)?;
    let nonce_bytes = super::random_bytes(NONCE_LEN);
    let nonce = XNonce::try_from(&nonce_bytes[..])
        .map_err(|_| CoreError::Crypto("nonce has the wrong length".into()))?;

    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CoreError::Crypto("sealing failed".into()))?;

    let mut envelope = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    envelope.push(ENVELOPE_VERSION);
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

/// Decrypt an envelope produced by [`seal`] with the same key and `aad`.
///
/// Returns [`CoreError::Crypto`] on any tampering, wrong key, or wrong `aad`;
/// the failure reason is intentionally uniform so it cannot be used as an
/// oracle.
pub fn open(key: &SecretBytes, aad: &[u8], envelope: &[u8]) -> Result<SecretBytes> {
    if envelope.len() < 1 + NONCE_LEN {
        return Err(CoreError::Crypto("envelope is truncated".into()));
    }
    if envelope[0] != ENVELOPE_VERSION {
        return Err(CoreError::Crypto(format!(
            "unsupported envelope version {}",
            envelope[0]
        )));
    }
    let cipher = cipher_for(key)?;
    let nonce = XNonce::try_from(&envelope[1..1 + NONCE_LEN])
        .map_err(|_| CoreError::Crypto("nonce has the wrong length".into()))?;
    let ciphertext = &envelope[1 + NONCE_LEN..];

    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CoreError::Crypto("opening failed".into()))?;
    Ok(SecretBytes::new(plaintext))
}
