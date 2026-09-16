//! Error types for the DevLedger core.
//!
//! Errors are deliberately coarse on the outside: nothing in a `Display`
//! implementation may ever contain a secret value, a passphrase, or a derived
//! key. Storage and crypto failures carry a short human-readable reason only.

use thiserror::Error;

/// Every fallible operation in the core returns this error type.
#[derive(Debug, Error)]
pub enum CoreError {
    /// An operation needing plaintext access was attempted while locked.
    #[error("vault is locked")]
    VaultLocked,

    /// Key derivation succeeded but the resulting key did not open the vault.
    #[error("invalid passphrase")]
    InvalidPassphrase,

    /// `initialize` was called on a directory that already holds a vault.
    #[error("vault is already initialized")]
    AlreadyInitialized,

    /// `unlock` was called on a directory with no vault in it.
    #[error("vault is not initialized")]
    NotInitialized,

    /// A cryptographic primitive failed. Never contains key material.
    #[error("cryptographic operation failed: {0}")]
    Crypto(String),

    /// The encrypted store could not be read or written.
    #[error("storage error: {0}")]
    Storage(String),

    /// A referenced row does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// Caller-supplied input was rejected before any work happened.
    #[error("invalid input: {0}")]
    Invalid(String),

    /// A staged Smart Paste analysis expired or was never created.
    #[error("no staged analysis for id {0}")]
    StaleAnalysis(String),

    /// JSON encoding/decoding of a non-secret payload failed.
    #[error("serialization error: {0}")]
    Serde(String),

    /// Filesystem access failed.
    #[error("io error: {0}")]
    Io(String),
}

/// Convenience alias used throughout the core.
pub type Result<T> = std::result::Result<T, CoreError>;

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::Serde(e.to_string())
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        CoreError::Storage(e.to_string())
    }
}
