//! Organizations inside an account: a Supabase org, a Vercel team, a GitHub org.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::Organization;

use super::rows::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // ------------------------------------------------------------ organization

    /// Insert an organization under an account.
    ///
    /// Only ever called with a name that came from the user or from the paste.
    /// DevLedger does not invent organizations.
    pub fn create_organization(
        &self,
        account_id: Uuid,
        provider_org_id: Option<&str>,
        name: &str,
    ) -> Result<Organization> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO organizations (id, account_id, provider_org_id, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id.to_string(),
                account_id.to_string(),
                provider_org_id,
                name,
                created_at
            ],
        )?;
        self.audit(
            "organization.create",
            Some("organization"),
            Some(id),
            &format!("Created organization {name}"),
        )?;
        Ok(Organization {
            id,
            account_id,
            provider_org_id: provider_org_id.map(str::to_string),
            name: name.to_string(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    pub(crate) fn organization_from_row(row: &Row<'_>) -> rusqlite::Result<(Organization, String)> {
        let created: String = row.get(4)?;
        Ok((
            Organization {
                id: uuid_from(row, 0)?,
                account_id: uuid_from(row, 1)?,
                provider_org_id: row.get(2)?,
                name: row.get(3)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created,
        ))
    }

    /// Find an organization by name within an account, case-insensitively.
    pub fn organization_by_name(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> Result<Option<Organization>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, account_id, provider_org_id, name, created_at
                 FROM organizations
                 WHERE account_id = ?1 AND name = ?2 COLLATE NOCASE",
                params![account_id.to_string(), name],
                Self::organization_from_row,
            )
            .optional()?;
        match row {
            Some((mut org, created)) => {
                org.created_at = parse_rfc3339(&created)?;
                Ok(Some(org))
            }
            None => Ok(None),
        }
    }

    /// Find an organization by name anywhere in the vault.
    ///
    /// Used by Smart Paste to notice that a pasted organization name already
    /// exists, even under a different account.
    pub fn organization_by_name_anywhere(&self, name: &str) -> Result<Option<Organization>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, account_id, provider_org_id, name, created_at
                 FROM organizations WHERE name = ?1 COLLATE NOCASE
                 ORDER BY created_at LIMIT 1",
                params![name],
                Self::organization_from_row,
            )
            .optional()?;
        match row {
            Some((mut org, created)) => {
                org.created_at = parse_rfc3339(&created)?;
                Ok(Some(org))
            }
            None => Ok(None),
        }
    }

    /// Move an organization under a different account.
    pub fn set_organization_account(&self, organization_id: Uuid, account_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE organizations SET account_id = ?2 WHERE id = ?1",
            params![organization_id.to_string(), account_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "organization {organization_id}"
            )));
        }
        self.audit(
            "organization.move",
            Some("organization"),
            Some(organization_id),
            "Re-parented to another account",
        )?;
        Ok(())
    }

    /// Delete an organization. Its resources survive, unassigned.
    pub fn delete_organization(&self, organization_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM organizations WHERE id = ?1",
            params![organization_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "organization {organization_id}"
            )));
        }
        self.conn().execute(
            "DELETE FROM relations
             WHERE (from_kind = 'organization' AND from_id = ?1)
                OR (to_kind = 'organization' AND to_id = ?1)",
            params![organization_id.to_string()],
        )?;
        self.audit(
            "organization.delete",
            Some("organization"),
            Some(organization_id),
            "Deleted organization",
        )?;
        Ok(())
    }

    /// Organizations under an account.
    pub fn organizations_for_account(&self, account_id: Uuid) -> Result<Vec<Organization>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, account_id, provider_org_id, name, created_at
             FROM organizations WHERE account_id = ?1 ORDER BY name",
        )?;
        let raw = stmt
            .query_map(params![account_id.to_string()], Self::organization_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (mut org, created) in raw {
            org.created_at = parse_rfc3339(&created)?;
            out.push(org);
        }
        Ok(out)
    }
}
