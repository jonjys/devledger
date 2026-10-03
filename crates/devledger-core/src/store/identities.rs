//! Identities and the email addresses attached to them.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Identity, IdentityEmail};

use super::rows::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // ---------------------------------------------------------------- identity

    /// Insert an identity.
    pub fn create_identity(
        &self,
        label: &str,
        email: Option<&str>,
        email_blind_index: Option<&str>,
    ) -> Result<Identity> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO identities (id, label, email, email_blind_index, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id.to_string(), label, email, email_blind_index, created_at],
        )?;
        // Every path that creates an identity with an address -- Smart Paste,
        // Connect, manual entry -- comes through here, so this is where the
        // address table is kept complete. Without it an identity created by a
        // paste would have a primary address the alias lookups cannot see.
        if let (Some(address), Some(index)) = (email, email_blind_index) {
            self.conn().execute(
                "INSERT INTO identity_emails
                    (id, identity_id, address, blind_index, is_primary, created_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)
                 ON CONFLICT (blind_index) DO NOTHING",
                params![
                    Uuid::new_v4().to_string(),
                    id.to_string(),
                    address,
                    index,
                    created_at
                ],
            )?;
        }
        self.audit(
            "identity.create",
            Some("identity"),
            Some(id),
            &format!("Created identity {label}"),
        )?;
        Ok(Identity {
            id,
            label: label.to_string(),
            email: email.map(str::to_string),
            email_blind_index: email_blind_index.map(str::to_string),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Look up an identity id by the blind index of its email.
    ///
    /// Matches *any* address the identity holds, not only its primary one. That
    /// is what makes a second address useful: a paste or a connection signed in
    /// with an alias lands on the same person instead of creating a duplicate.
    pub fn identity_id_by_email_index(&self, index: &str) -> Result<Option<Uuid>> {
        let found: Option<String> = self
            .conn()
            .query_row(
                "SELECT identity_id FROM identity_emails WHERE blind_index = ?1
                 UNION ALL
                 SELECT id FROM identities WHERE email_blind_index = ?1
                 LIMIT 1",
                params![index],
                |r| r.get(0),
            )
            .optional()?;
        match found {
            Some(raw) => Ok(Some(parse_uuid(&raw, "identity")?)),
            None => Ok(None),
        }
    }

    pub(super) fn identity_from_row(row: &Row<'_>) -> rusqlite::Result<(Identity, String)> {
        let created: String = row.get(4)?;
        Ok((
            Identity {
                id: uuid_from(row, 0)?,
                label: row.get(1)?,
                email: row.get(2)?,
                email_blind_index: row.get(3)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created,
        ))
    }

    /// List every identity, oldest first.
    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, label, email, email_blind_index, created_at
             FROM identities ORDER BY created_at, id",
        )?;
        let raw = stmt
            .query_map([], Self::identity_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (mut identity, created) in raw {
            identity.created_at = parse_rfc3339(&created)?;
            out.push(identity);
        }
        Ok(out)
    }

    /// Fetch one identity.
    pub fn identity(&self, id: Uuid) -> Result<Option<Identity>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, label, email, email_blind_index, created_at
                 FROM identities WHERE id = ?1",
                params![id.to_string()],
                Self::identity_from_row,
            )
            .optional()?;
        match row {
            Some((mut identity, created)) => {
                identity.created_at = parse_rfc3339(&created)?;
                Ok(Some(identity))
            }
            None => Ok(None),
        }
    }

    /// Rename an identity.
    pub fn update_identity_label(&self, identity_id: Uuid, label: &str) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE identities SET label = ?2 WHERE id = ?1",
            params![identity_id.to_string(), label],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("identity {identity_id}")));
        }
        self.audit(
            "identity.update",
            Some("identity"),
            Some(identity_id),
            &format!("Renamed identity to {label}"),
        )
    }

    /// Delete an identity, and with it every account filed under it.
    pub fn delete_identity(&self, identity_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM identities WHERE id = ?1",
            params![identity_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("identity {identity_id}")));
        }
        self.conn().execute(
            "DELETE FROM relations WHERE from_kind = 'identity' AND from_id = ?1",
            params![identity_id.to_string()],
        )?;
        self.audit(
            "identity.delete",
            Some("identity"),
            Some(identity_id),
            "Deleted an identity and everything filed under it",
        )
    }

    // ---------------------------------------------------------- identity email

    /// Attach another email address to an identity.
    ///
    /// The blind index is unique across the whole vault, so the same address
    /// cannot end up under two identities -- which is what would otherwise let
    /// one person's accounts drift apart into two half-populated maps.
    pub fn add_identity_email(
        &self,
        identity_id: Uuid,
        address: &str,
        blind_index: &str,
        is_primary: bool,
    ) -> Result<IdentityEmail> {
        if let Some(owner) = self.identity_id_by_email_index(blind_index)? {
            if owner != identity_id {
                return Err(CoreError::Invalid(
                    "that email address is already attached to another identity".into(),
                ));
            }
        }
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO identity_emails
                (id, identity_id, address, blind_index, is_primary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (blind_index) DO NOTHING",
            params![
                id.to_string(),
                identity_id.to_string(),
                address,
                blind_index,
                is_primary as i64,
                created_at
            ],
        )?;
        if is_primary {
            self.set_primary_email(identity_id, blind_index)?;
        }
        self.audit(
            "identity.email.add",
            Some("identity"),
            Some(identity_id),
            "Added an email address to an identity",
        )?;
        Ok(IdentityEmail {
            id,
            identity_id,
            address: address.to_string(),
            blind_index: blind_index.to_string(),
            is_primary,
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Every address attached to an identity, primary first.
    pub fn identity_emails(&self, identity_id: Uuid) -> Result<Vec<IdentityEmail>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, identity_id, address, blind_index, is_primary, created_at
               FROM identity_emails WHERE identity_id = ?1
              ORDER BY is_primary DESC, address",
        )?;
        let raw = stmt
            .query_map(params![identity_id.to_string()], |row| {
                Ok((
                    IdentityEmail {
                        id: uuid_from(row, 0)?,
                        identity_id: uuid_from(row, 1)?,
                        address: row.get(2)?,
                        blind_index: row.get(3)?,
                        is_primary: row.get::<_, i64>(4)? != 0,
                        created_at: OffsetDateTime::UNIX_EPOCH,
                    },
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (mut email, created) in raw {
            email.created_at = parse_rfc3339(&created)?;
            out.push(email);
        }
        Ok(out)
    }

    /// Make one address the identity's primary, and mirror it onto the identity.
    ///
    /// `identities.email` remains the primary address so that every existing
    /// lookup keeps working; this is the one place the two are kept in step.
    pub fn set_primary_email(&self, identity_id: Uuid, blind_index: &str) -> Result<()> {
        let address: Option<String> = self
            .conn()
            .query_row(
                "SELECT address FROM identity_emails WHERE identity_id = ?1 AND blind_index = ?2",
                params![identity_id.to_string(), blind_index],
                |r| r.get(0),
            )
            .optional()?;
        let address = address.ok_or_else(|| {
            CoreError::NotFound("that address is not attached to this identity".to_string())
        })?;
        self.conn().execute(
            "UPDATE identity_emails SET is_primary = (blind_index = ?2) WHERE identity_id = ?1",
            params![identity_id.to_string(), blind_index],
        )?;
        self.conn().execute(
            "UPDATE identities SET email = ?2, email_blind_index = ?3 WHERE id = ?1",
            params![identity_id.to_string(), address, blind_index],
        )?;
        self.audit(
            "identity.email.primary",
            Some("identity"),
            Some(identity_id),
            "Changed the primary email address of an identity",
        )
    }

    /// Detach an address from an identity.
    ///
    /// The last address cannot be removed while it is the primary one, because
    /// an identity with no address cannot be matched to anything afterwards.
    pub fn remove_identity_email(&self, identity_id: Uuid, email_id: Uuid) -> Result<()> {
        let emails = self.identity_emails(identity_id)?;
        let target = emails
            .iter()
            .find(|e| e.id == email_id)
            .ok_or_else(|| CoreError::NotFound(format!("email {email_id}")))?;
        if target.is_primary && emails.len() > 1 {
            return Err(CoreError::Invalid(
                "choose another primary address before removing this one".into(),
            ));
        }
        self.conn().execute(
            "DELETE FROM identity_emails WHERE id = ?1",
            params![email_id.to_string()],
        )?;
        if target.is_primary {
            self.conn().execute(
                "UPDATE identities SET email = NULL, email_blind_index = NULL WHERE id = ?1",
                params![identity_id.to_string()],
            )?;
        }
        self.audit(
            "identity.email.remove",
            Some("identity"),
            Some(identity_id),
            "Removed an email address from an identity",
        )
    }
}
