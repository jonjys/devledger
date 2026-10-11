//! Vault-wide settings: a small key-value table (schema version 7).
//!
//! Values are bytes. Anything sensitive is sealed by the caller before it gets
//! here, so this table never holds plaintext credentials.

use rusqlite::{params, OptionalExtension};

use super::{now_rfc3339, Store};
use crate::error::Result;

impl Store {
    /// The value stored under `key`, if any.
    pub fn setting(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Store `value` under `key`, replacing what was there.
    pub fn set_setting(&self, key: &str, value: &[u8]) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_rfc3339()?],
        )?;
        Ok(())
    }

    /// Remove `key`. Returns whether anything was there.
    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        Ok(self
            .conn()
            .execute("DELETE FROM settings WHERE key = ?1", params![key])?
            > 0)
    }
}
