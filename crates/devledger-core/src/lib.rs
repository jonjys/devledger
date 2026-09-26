//! DevLedger core: security, parsing and persistence.
//!
//! This crate deliberately has **no networking dependency and no UI
//! dependency**. It is the only place that touches key material, and the only
//! place that can decrypt a stored secret. The desktop shell talks to it over
//! Tauri commands and receives display-safe projections.
//!
//! Layering, bottom up:
//!
//! - [`secret`] -- zeroizing containers that cannot be serialized
//! - [`crypto`] -- Argon2id, XChaCha20-Poly1305, blind indexing
//! - [`store`] -- the SQLCipher-encrypted database and its append-only audit log
//! - [`vault`] -- lock/unlock lifecycle tying a passphrase to an open store
//! - [`model`] -- Identity / Account / Organization / Project and relations
//! - [`redact`] -- provenance capture with secrets stripped
//! - [`paste`] -- the deterministic Smart Paste pipeline
//! - [`connect`] -- Connect & Discover: connector descriptors, discovery
//!   snapshots and reconciliation. Defines no I/O; the `devledger-connect`
//!   crate does the fetching and hands back a snapshot.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod connect;
pub mod connect_vault;
pub mod crypto;
pub mod error;
pub mod manual;
pub mod model;
pub mod paste;
pub mod redact;
pub mod secret;
pub mod store;
pub mod vault;

pub use error::{CoreError, Result};
pub use secret::{SecretBytes, SecretString};
pub use vault::Vault;
