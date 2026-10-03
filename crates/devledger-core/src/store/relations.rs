//! Relations between entities, with the evidence behind each.

use rusqlite::params;
use uuid::Uuid;

use crate::error::Result;
use crate::model::{EntityRef, Evidence, Relation, RelationKind};

use super::enums::*;
use super::rows::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // --------------------------------------------------------------- relations

    /// Record a relation, ignoring an exact duplicate.
    pub fn create_relation(
        &self,
        from: EntityRef,
        to: EntityRef,
        kind: RelationKind,
        evidence: &Evidence,
    ) -> Result<Relation> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT OR IGNORE INTO relations
                (id, from_kind, from_id, to_kind, to_id, kind,
                 evidence_level, evidence_rule, evidence_reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id.to_string(),
                entity_kind_to_str(from.kind),
                from.id.to_string(),
                entity_kind_to_str(to.kind),
                to.id.to_string(),
                relation_kind_to_str(kind),
                evidence_level_to_str(evidence.level),
                evidence.rule,
                evidence.reason,
                created_at
            ],
        )?;
        Ok(Relation {
            id,
            from,
            to,
            kind,
            evidence: evidence.clone(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Remove a relation between two entities.
    pub fn delete_relation(
        &self,
        from: EntityRef,
        to: EntityRef,
        kind: RelationKind,
    ) -> Result<()> {
        self.conn().execute(
            "DELETE FROM relations
             WHERE from_kind = ?1 AND from_id = ?2 AND to_kind = ?3 AND to_id = ?4 AND kind = ?5",
            params![
                entity_kind_to_str(from.kind),
                from.id.to_string(),
                entity_kind_to_str(to.kind),
                to.id.to_string(),
                relation_kind_to_str(kind)
            ],
        )?;
        self.audit(
            "relation.delete",
            Some(entity_kind_to_str(from.kind)),
            Some(from.id),
            &format!("Unlinked {} {}", kind.label(), to.id),
        )?;
        Ok(())
    }

    /// Every (identity, project) pair joined by [`RelationKind::WorksOn`].
    pub fn identity_project_links(&self) -> Result<Vec<(Uuid, Uuid)>> {
        let mut stmt = self.conn().prepare(
            "SELECT from_id, to_id FROM relations
             WHERE kind = 'works_on' AND from_kind = 'identity' AND to_kind = 'project'
             ORDER BY created_at, id",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((uuid_from(r, 0)?, uuid_from(r, 1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Every relation touching an entity, in either direction.
    pub fn relations_for(&self, entity: EntityRef) -> Result<Vec<Relation>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, from_kind, from_id, to_kind, to_id, kind,
                    evidence_level, evidence_rule, evidence_reason, created_at
             FROM relations
             WHERE (from_kind = ?1 AND from_id = ?2) OR (to_kind = ?1 AND to_id = ?2)
             ORDER BY created_at, id",
        )?;
        let raw = stmt
            .query_map(
                params![entity_kind_to_str(entity.kind), entity.id.to_string()],
                |r| {
                    Ok((
                        uuid_from(r, 0)?,
                        r.get::<_, String>(1)?,
                        uuid_from(r, 2)?,
                        r.get::<_, String>(3)?,
                        uuid_from(r, 4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (id, fk, fi, tk, ti, kind, level, rule, reason, created) in raw {
            out.push(Relation {
                id,
                from: EntityRef::new(entity_kind_from_str(&fk)?, fi),
                to: EntityRef::new(entity_kind_from_str(&tk)?, ti),
                kind: relation_kind_from_str(&kind)?,
                evidence: Evidence {
                    level: evidence_level_from_str(&level)?,
                    rule,
                    reason,
                },
                created_at: parse_rfc3339(&created)?,
            });
        }
        Ok(out)
    }
}
