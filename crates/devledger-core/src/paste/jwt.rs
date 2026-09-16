//! Minimal, non-verifying JWT inspection.
//!
//! DevLedger never validates a JWT signature -- it has no key and no network.
//! It only decodes the payload to read the claims Supabase puts there (`iss`,
//! `role`, `ref`, `exp`), which is what lets Smart Paste say "this is a
//! service_role key for project abcdefghijklmnopqrst" deterministically instead
//! of guessing from the variable name.

use base64::engine::general_purpose::URL_SAFE_NO_PAD_INDIFFERENT;
use base64::Engine as _;
use serde::Deserialize;

/// The subset of JWT claims DevLedger reads.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct JwtClaims {
    /// Issuer. Supabase keys carry `"supabase"`.
    #[serde(default)]
    pub iss: Option<String>,
    /// Supabase role: `anon` or `service_role`.
    #[serde(default)]
    pub role: Option<String>,
    /// Supabase project reference.
    #[serde(default)]
    pub r#ref: Option<String>,
    /// Expiry, seconds since the Unix epoch.
    #[serde(default)]
    pub exp: Option<i64>,
    /// Issued-at, seconds since the Unix epoch.
    #[serde(default)]
    pub iat: Option<i64>,
}

impl JwtClaims {
    /// Whether the token is past its `exp` claim at `now_unix`.
    ///
    /// A token with no `exp` is never reported as expired.
    pub fn is_expired_at(&self, now_unix: i64) -> bool {
        self.exp.is_some_and(|exp| exp <= now_unix)
    }
}

/// Decode the payload of a three-segment JWT without verifying it.
///
/// Returns `None` if the shape is wrong or the payload is not JSON.
pub fn decode_claims(token: &str) -> Option<JwtClaims> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD_INDIFFERENT.decode(payload).ok()?;
    serde_json::from_slice::<JwtClaims>(&bytes).ok()
}

/// Whether `token` has the lexical shape of a JWT.
pub fn looks_like_jwt(token: &str) -> bool {
    token.starts_with("eyJ") && token.split('.').count() == 3
}
