//! Provider accounts, each owned by one identity.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Account, Provider};

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // ----------------------------------------------------------------- account

    pub(crate) const ACCOUNT_COLUMNS: &'static str =
        "id, identity_id, provider, external_ref, label, login_email, username, url, notes, \
         created_at";

    /// Insert an account under an identity.
    pub fn create_account(
        &self,
        identity_id: Uuid,
        provider: &Provider,
        external_ref: Option<&str>,
        label: &str,
    ) -> Result<Account> {
        self.create_account_full(
            identity_id,
            provider,
            external_ref,
            label,
            &AccountDetails::default(),
        )
    }

    /// Insert an account together with the details a manual entry carries.
    pub fn create_account_full(
        &self,
        identity_id: Uuid,
        provider: &Provider,
        external_ref: Option<&str>,
        label: &str,
        details: &AccountDetails,
    ) -> Result<Account> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO accounts
                (id, identity_id, provider, external_ref, label, login_email, username, url,
                 notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id.to_string(),
                identity_id.to_string(),
                provider_to_str(provider),
                external_ref,
                label,
                details.login_email,
                details.username,
                details.url,
                details.notes,
                created_at
            ],
        )?;
        self.audit(
            "account.create",
            Some("account"),
            Some(id),
            &format!("Created {} account {label}", provider.label()),
        )?;
        Ok(Account {
            id,
            identity_id,
            provider: provider.clone(),
            external_ref: external_ref.map(str::to_string),
            label: label.to_string(),
            login_email: details.login_email.clone(),
            username: details.username.clone(),
            url: details.url.clone(),
            notes: details.notes.clone(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Update the editable fields of an account.
    pub fn update_account(
        &self,
        account_id: Uuid,
        label: &str,
        details: &AccountDetails,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE accounts SET label = ?2, login_email = ?3, username = ?4, url = ?5,
                    notes = ?6
              WHERE id = ?1",
            params![
                account_id.to_string(),
                label,
                details.login_email,
                details.username,
                details.url,
                details.notes
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("account {account_id}")));
        }
        self.audit(
            "account.update",
            Some("account"),
            Some(account_id),
            &format!("Updated account {label}"),
        )
    }

    /// Fetch one account.
    pub fn account(&self, account_id: Uuid) -> Result<Option<Account>> {
        let sql = format!(
            "SELECT {} FROM accounts WHERE id = ?1",
            Self::ACCOUNT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![account_id.to_string()],
                Self::account_from_row,
            )
            .optional()?;
        Self::finish_account(row)
    }

    /// Every account an identity holds with a given provider.
    ///
    /// Returns a list rather than an option because holding two accounts with
    /// the same provider is legitimate -- two Supabase accounts under one
    /// person, signed in with different addresses. Callers that need exactly
    /// one have to decide what to do about the ambiguity rather than being
    /// handed an arbitrary row.
    pub fn accounts_for(&self, identity_id: Uuid, provider: &Provider) -> Result<Vec<Account>> {
        let sql = format!(
            "SELECT {} FROM accounts WHERE identity_id = ?1 AND provider = ?2
              ORDER BY created_at, id",
            Self::ACCOUNT_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(
                params![identity_id.to_string(), provider_to_str(provider)],
                Self::account_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for row in raw {
            if let Some(account) = Self::finish_account(Some(row))? {
                out.push(account);
            }
        }
        Ok(out)
    }

    /// The single account an identity holds with a provider, if it is unambiguous.
    ///
    /// `Ok(None)` means either none exists or several do; [`Self::accounts_for`]
    /// distinguishes the two.
    pub fn account_for(&self, identity_id: Uuid, provider: &Provider) -> Result<Option<Account>> {
        let mut accounts = self.accounts_for(identity_id, provider)?;
        if accounts.len() == 1 {
            Ok(Some(accounts.remove(0)))
        } else {
            Ok(None)
        }
    }

    pub(super) fn account_from_row(row: &Row<'_>) -> rusqlite::Result<(Account, String, String)> {
        let provider: String = row.get(2)?;
        let created: String = row.get(9)?;
        Ok((
            Account {
                id: uuid_from(row, 0)?,
                identity_id: uuid_from(row, 1)?,
                provider: Provider::Unknown,
                external_ref: row.get(3)?,
                label: row.get(4)?,
                login_email: row.get(5)?,
                username: row.get(6)?,
                url: row.get(7)?,
                notes: row.get(8)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            provider,
            created,
        ))
    }

    pub(super) fn finish_account(
        row: Option<(Account, String, String)>,
    ) -> Result<Option<Account>> {
        match row {
            Some((mut account, provider, created)) => {
                account.provider = provider_from_str(&provider)?;
                account.created_at = parse_rfc3339(&created)?;
                Ok(Some(account))
            }
            None => Ok(None),
        }
    }

    /// Move an account under a different identity.
    pub fn set_account_identity(&self, account_id: Uuid, identity_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE accounts SET identity_id = ?2 WHERE id = ?1",
            params![account_id.to_string(), identity_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("account {account_id}")));
        }
        self.audit(
            "account.move",
            Some("account"),
            Some(account_id),
            "Re-parented to another identity",
        )?;
        Ok(())
    }

    /// Delete an account and everything under it.
    ///
    /// Organizations, service resources, subscriptions and connections cascade
    /// through foreign keys; relations that referenced the account are cleared
    /// here because that table carries no foreign key of its own.
    pub fn delete_account(&self, account_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM accounts WHERE id = ?1",
            params![account_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("account {account_id}")));
        }
        self.conn().execute(
            "DELETE FROM relations
             WHERE (from_kind = 'account' AND from_id = ?1)
                OR (to_kind = 'account' AND to_id = ?1)",
            params![account_id.to_string()],
        )?;
        self.audit(
            "account.delete",
            Some("account"),
            Some(account_id),
            "Deleted account and everything under it",
        )?;
        Ok(())
    }

    /// Every account belonging to an identity.
    pub fn accounts_for_identity(&self, identity_id: Uuid) -> Result<Vec<Account>> {
        let sql = format!(
            "SELECT {} FROM accounts WHERE identity_id = ?1 ORDER BY provider, label",
            Self::ACCOUNT_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![identity_id.to_string()], Self::account_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            if let Some(account) = Self::finish_account(Some(entry))? {
                out.push(account);
            }
        }
        Ok(out)
    }
}
