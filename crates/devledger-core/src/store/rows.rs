//! Reading ids out of rows.

use rusqlite::Row;
use uuid::Uuid;

use crate::error::{CoreError, Result};

pub(super) fn uuid_from(row: &Row<'_>, idx: usize) -> rusqlite::Result<Uuid> {
    let raw: String = row.get(idx)?;
    Uuid::parse_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub(super) fn opt_uuid_from(row: &Row<'_>, idx: usize) -> rusqlite::Result<Option<Uuid>> {
    let raw: Option<String> = row.get(idx)?;
    match raw {
        None => Ok(None),
        Some(text) => Uuid::parse_str(&text).map(Some).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
        }),
    }
}

pub(super) fn parse_uuid(raw: &str, what: &str) -> Result<Uuid> {
    Uuid::parse_str(raw).map_err(|e| CoreError::Storage(format!("corrupt {what} id: {e}")))
}
