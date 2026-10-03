//! Fields the user names, provenance of what a paste filed, and the audit log.

use rusqlite::params;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{CustomField, EntityKind, EntityRef};
use crate::redact::Provenance;

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::{now_rfc3339, parse_rfc3339, to_rfc3339, Store};

impl Store {
    // ------------------------------------------------------------ custom field

    /// Attach a field the user named to a person, account, project or resource.
    ///
    /// New fields go to the end of the entity's list.
    pub fn create_custom_field(
        &self,
        entity: &EntityRef,
        label: &str,
        value: &str,
    ) -> Result<CustomField> {
        let kind = custom_field_kind(entity.kind)?;
        let id = Uuid::new_v4();
        let at = now_rfc3339()?;
        let position: i64 = self.conn().query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM custom_fields
              WHERE entity_kind = ?1 AND entity_id = ?2",
            params![kind, entity.id.to_string()],
            |r| r.get(0),
        )?;
        self.conn().execute(
            "INSERT INTO custom_fields
                (id, entity_kind, entity_id, label, value, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id.to_string(),
                kind,
                entity.id.to_string(),
                label,
                value,
                position,
                at
            ],
        )?;
        // The label is recorded, the value is not: a field is only a field
        // because the user chose not to make it a secret, but that choice is
        // theirs to make per field and the audit log is not the place to guess.
        self.audit(
            "field.create",
            Some(kind),
            Some(entity.id),
            &format!("Added field {label}"),
        )?;
        Ok(CustomField {
            id,
            entity: entity.clone(),
            label: label.to_string(),
            value: value.to_string(),
            position,
            created_at: parse_rfc3339(&at)?,
            updated_at: parse_rfc3339(&at)?,
        })
    }

    /// Change a field's label or value.
    pub fn update_custom_field(&self, id: Uuid, label: &str, value: &str) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE custom_fields SET label = ?2, value = ?3, updated_at = ?4 WHERE id = ?1",
            params![id.to_string(), label, value, now_rfc3339()?],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("field {id}")));
        }
        self.audit(
            "field.update",
            Some("field"),
            Some(id),
            &format!("Updated field {label}"),
        )
    }

    /// Remove a field.
    pub fn delete_custom_field(&self, id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM custom_fields WHERE id = ?1",
            params![id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("field {id}")));
        }
        self.audit("field.delete", Some("field"), Some(id), "Removed a field")
    }

    /// Every field attached to an entity, in display order.
    pub fn custom_fields_for(&self, entity: &EntityRef) -> Result<Vec<CustomField>> {
        let kind = custom_field_kind(entity.kind)?;
        let mut stmt = self.conn().prepare(
            "SELECT id, label, value, position, created_at, updated_at FROM custom_fields
              WHERE entity_kind = ?1 AND entity_id = ?2
              ORDER BY position, created_at",
        )?;
        let raw = stmt
            .query_map(params![kind, entity.id.to_string()], |row| {
                Ok((
                    uuid_from(row, 0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (id, label, value, position, created, updated) in raw {
            out.push(CustomField {
                id,
                entity: entity.clone(),
                label,
                value,
                position,
                created_at: parse_rfc3339(&created)?,
                updated_at: parse_rfc3339(&updated)?,
            });
        }
        Ok(out)
    }

    /// Whether the row a field would attach to exists.
    pub fn entity_exists(&self, entity: &EntityRef) -> Result<bool> {
        let table = match entity.kind {
            EntityKind::Identity => "identities",
            EntityKind::Account => "accounts",
            EntityKind::Organization => "organizations",
            EntityKind::Project => "projects",
            EntityKind::ServiceProject => "service_projects",
            other => {
                return Err(CoreError::Invalid(format!(
                    "fields cannot be attached to a {other:?}"
                )))
            }
        };
        let found: i64 = self.conn().query_row(
            &format!("SELECT count(*) FROM {table} WHERE id = ?1"),
            params![entity.id.to_string()],
            |r| r.get(0),
        )?;
        Ok(found > 0)
    }

    // ------------------------------------------------------------- provenance

    /// Attach a redacted provenance record to an entity.
    pub fn record_provenance(&self, entity: EntityRef, provenance: &Provenance) -> Result<()> {
        self.conn().execute(
            "INSERT INTO provenance_records
                (id, entity_kind, entity_id, source, redacted_excerpt, original_len, captured_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                entity_kind_to_str(entity.kind),
                entity.id.to_string(),
                source_kind_to_str(provenance.source),
                provenance.redacted_excerpt,
                provenance.original_len as i64,
                to_rfc3339(provenance.captured_at)?
            ],
        )?;
        Ok(())
    }

    /// Provenance records attached to an entity, newest first.
    pub fn provenance_for(&self, entity: EntityRef) -> Result<Vec<Provenance>> {
        let mut stmt = self.conn().prepare(
            "SELECT source, redacted_excerpt, original_len, captured_at
             FROM provenance_records
             WHERE entity_kind = ?1 AND entity_id = ?2
             ORDER BY captured_at DESC",
        )?;
        let raw = stmt
            .query_map(
                params![entity_kind_to_str(entity.kind), entity.id.to_string()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (source, redacted_excerpt, original_len, captured) in raw {
            out.push(Provenance {
                source: source_kind_from_str(&source)?,
                redacted_excerpt,
                original_len: original_len as usize,
                captured_at: parse_rfc3339(&captured)?,
            });
        }
        Ok(out)
    }

    // -------------------------------------------------------------- audit log

    /// Read the most recent audit entries, newest first.
    pub fn recent_audit(&self, limit: i64) -> Result<Vec<AuditEntry>> {
        let mut stmt = self.conn().prepare(
            "SELECT seq, at, action, entity_kind, entity_id, detail
             FROM audit_log ORDER BY seq DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(AuditEntry {
                    seq: r.get(0)?,
                    at: r.get(1)?,
                    action: r.get(2)?,
                    entity_kind: r.get(3)?,
                    entity_id: r.get(4)?,
                    detail: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

/// The storage name for an entity that can carry custom fields.
fn custom_field_kind(kind: EntityKind) -> Result<&'static str> {
    match kind {
        EntityKind::Identity => Ok("identity"),
        EntityKind::Account => Ok("account"),
        EntityKind::Organization => Ok("organization"),
        EntityKind::Project => Ok("project"),
        EntityKind::ServiceProject => Ok("service_project"),
        other => Err(CoreError::Invalid(format!(
            "fields cannot be attached to a {other:?}"
        ))),
    }
}
