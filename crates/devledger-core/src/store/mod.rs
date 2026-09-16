//! The SQLCipher-encrypted store.
//!
//! The whole database file is encrypted by SQLCipher under a subkey derived
//! from the master key, and each secret *value* is additionally sealed with
//! XChaCha20-Poly1305 under a different subkey. That second layer means the
//! secret metadata a user browses can be read without ever unwrapping a
//! credential, and a reveal is a separate, audited operation.

pub mod schema;

mod enums;
mod repo;

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::crypto::{self, LABEL_DATABASE};
use crate::error::{CoreError, Result};
use crate::secret::SecretBytes;

pub use repo::{
    AccountNode, AttentionItem, AttentionKind, AuditEntry, IdentityNode, OrganizationNode,
    ProjectRefLabel, ProjectSummary, ServiceProjectSummary, SubscriptionSummary, VaultEntry,
};

/// A handle to the opened, decrypted database.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating if needed) the database at `path` under `master_key`.
    ///
    /// The SQLCipher key is a subkey of the master, never the master itself, so
    /// the value that protects the file at rest is not the same value used to
    /// seal individual secrets.
    pub fn open(path: &Path, master_key: &SecretBytes) -> Result<Self> {
        let db_key = crypto::derive_subkey(master_key, LABEL_DATABASE)?;
        let conn = Connection::open(path)?;
        Self::configure(&conn, &db_key)?;
        let mut store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Open an in-memory database. Used by the test suite.
    #[doc(hidden)]
    pub fn open_in_memory(master_key: &SecretBytes) -> Result<Self> {
        let db_key = crypto::derive_subkey(master_key, LABEL_DATABASE)?;
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn, &db_key)?;
        let mut store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    fn configure(conn: &Connection, db_key: &SecretBytes) -> Result<()> {
        let hex = db_key.to_hex();
        // The `x'...'` form hands SQLCipher raw key bytes and skips its own
        // PBKDF2 pass: the key is already an Argon2id-derived subkey.
        conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex.expose()))
            .map_err(|_| CoreError::InvalidPassphrase)?;

        // Fails with "file is not a database" when the key is wrong.
        conn.prepare("SELECT count(*) FROM sqlite_master")
            .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
            .map_err(|_| CoreError::InvalidPassphrase)?;

        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;",
        )?;
        Ok(())
    }

    fn migrate(&mut self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
        )?;
        let current: i64 = self
            .conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
            .optional()?
            .unwrap_or(0);

        if current > schema::CURRENT_VERSION {
            return Err(CoreError::Storage(format!(
                "vault was written by a newer DevLedger (schema {current}, this build supports {})",
                schema::CURRENT_VERSION
            )));
        }

        for (i, sql) in schema::MIGRATIONS.iter().enumerate() {
            let target = i as i64 + 1;
            if target <= current {
                continue;
            }
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute("DELETE FROM schema_version", [])?;
            tx.execute("INSERT INTO schema_version (version) VALUES (?1)", [target])?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Borrow the underlying connection.
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Borrow the connection mutably, for transactions.
    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Append a line to the audit log.
    ///
    /// `detail` is written verbatim, so callers must keep secrets out of it.
    pub fn audit(
        &self,
        action: &str,
        entity_kind: Option<&str>,
        entity_id: Option<Uuid>,
        detail: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO audit_log (at, action, entity_kind, entity_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                now_rfc3339()?,
                action,
                entity_kind,
                entity_id.map(|v| v.to_string()),
                detail,
            ],
        )?;
        Ok(())
    }
}

/// Current UTC time as an RFC 3339 string, the storage format for timestamps.
pub(crate) fn now_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| CoreError::Storage(format!("timestamp formatting failed: {e}")))
}

pub(crate) fn to_rfc3339(t: OffsetDateTime) -> Result<String> {
    t.format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| CoreError::Storage(format!("timestamp formatting failed: {e}")))
}

pub(crate) fn parse_rfc3339(s: &str) -> Result<OffsetDateTime> {
    OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|e| CoreError::Storage(format!("unparseable timestamp {s:?}: {e}")))
}
