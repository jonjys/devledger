//! Argon2id password-based key derivation.
//!
//! The parameters live next to the vault in cleartext (`vault.json`) because a
//! salt must be readable before the vault can be opened. They contain no secret
//! material.

use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::secret::{SecretBytes, SecretString};

/// Length of the master key Argon2id produces.
pub const MASTER_KEY_LEN: usize = 32;
/// Length of the random salt.
pub const SALT_LEN: usize = 16;

/// Argon2id cost parameters plus the per-vault salt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost: u32,
    /// Number of passes.
    pub t_cost: u32,
    /// Degree of parallelism.
    pub p_cost: u32,
    /// Random per-vault salt, hex encoded.
    pub salt_hex: String,
}

impl KdfParams {
    /// Production defaults: 64 MiB, 3 passes, single lane.
    ///
    /// Comfortably above the OWASP Argon2id floor (19 MiB / 2 passes) while
    /// still deriving in well under a second on a laptop.
    pub fn generate() -> Result<Self> {
        let salt = super::random_bytes(SALT_LEN);
        Ok(KdfParams {
            m_cost: 65_536,
            t_cost: 3,
            p_cost: 1,
            salt_hex: hex_encode(&salt),
        })
    }

    /// Deliberately weak parameters so the test suite stays fast.
    ///
    /// Never used by any production code path.
    #[doc(hidden)]
    pub fn weak_for_tests() -> Result<Self> {
        let mut params = Self::generate()?;
        params.m_cost = 8;
        params.t_cost = 1;
        params.p_cost = 1;
        Ok(params)
    }

    fn salt(&self) -> Result<Vec<u8>> {
        hex_decode(&self.salt_hex)
            .ok_or_else(|| CoreError::Crypto("vault salt is not valid hex".into()))
    }
}

/// Derive the 32-byte master key from a passphrase.
pub fn derive_master_key(passphrase: &SecretString, params: &KdfParams) -> Result<SecretBytes> {
    if passphrase.is_empty() {
        return Err(CoreError::Invalid("passphrase must not be empty".into()));
    }
    let salt = params.salt()?;
    let argon_params = Params::new(
        params.m_cost,
        params.t_cost,
        params.p_cost,
        Some(MASTER_KEY_LEN),
    )
    .map_err(|e| CoreError::Crypto(format!("invalid argon2 parameters: {e}")))?;

    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out = SecretBytes::zeroed(MASTER_KEY_LEN);
    argon
        .hash_password_into(passphrase.expose().as_bytes(), &salt, out.expose_mut())
        .map_err(|e| CoreError::Crypto(format!("argon2 derivation failed: {e}")))?;
    Ok(out)
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

pub(crate) fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
