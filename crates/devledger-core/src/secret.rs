//! Zeroizing containers for material that must never reach the UI layer.
//!
//! The rule DevLedger enforces structurally: [`SecretString`] and
//! [`SecretBytes`] do **not** implement [`serde::Serialize`] and do not
//! implement [`std::fmt::Display`]. A secret therefore cannot be returned
//! across the Tauri IPC boundary by accident -- reaching the frontend requires
//! calling [`SecretString::expose`] explicitly, which every reveal path does
//! behind an audited command.

use std::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop};

/// A UTF-8 secret (API key, connection string, passphrase) that is wiped on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    /// Wrap a string, taking ownership of its buffer.
    pub fn new(value: impl Into<String>) -> Self {
        SecretString(value.into())
    }

    /// Borrow the plaintext. Every call site is a deliberate disclosure.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Length in bytes of the underlying plaintext.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the secret is the empty string.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// A non-reversible preview safe to send to the UI.
    ///
    /// Shows at most the first four and last four characters and never reveals
    /// more than a third of a short secret.
    pub fn preview(&self) -> String {
        mask_preview(&self.0)
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        SecretString::new(value)
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        SecretString::new(value)
    }
}

/// Raw key material (derived keys, subkeys, nonced envelopes) wiped on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop, PartialEq, Eq)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Wrap an owned byte buffer.
    pub fn new(bytes: Vec<u8>) -> Self {
        SecretBytes(bytes)
    }

    /// A zero-filled buffer of `len` bytes, for use as a KDF output target.
    pub fn zeroed(len: usize) -> Self {
        SecretBytes(vec![0u8; len])
    }

    /// Borrow the key material.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// Mutably borrow the key material, e.g. to have a KDF write into it.
    pub fn expose_mut(&mut self) -> &mut [u8] {
        &mut self.0
    }

    /// Number of bytes held.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Lowercase hex encoding, used to hand SQLCipher its `PRAGMA key`.
    pub fn to_hex(&self) -> SecretString {
        let mut out = String::with_capacity(self.0.len() * 2);
        for byte in &self.0 {
            use fmt::Write as _;
            // Writing to a String cannot fail.
            let _ = write!(out, "{byte:02x}");
        }
        SecretString::new(out)
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretBytes(<redacted, {} bytes>)", self.0.len())
    }
}

/// Mask a value for display: `sbp_1234…cdef` style, never more than a third shown.
pub fn mask_preview(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let n = chars.len();
    if n == 0 {
        return String::new();
    }
    // Show at most 4 leading + 4 trailing, and never more than n/3 total.
    let budget = n / 3;
    let head = budget.min(4);
    let tail = budget.saturating_sub(head).min(4);
    if head == 0 {
        return "•".repeat(n.min(8));
    }
    let lead: String = chars[..head].iter().collect();
    let trail: String = chars[n - tail..].iter().collect();
    format!("{lead}…{trail}")
}
