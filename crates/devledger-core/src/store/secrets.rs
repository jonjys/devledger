//! Secret metadata and sealed envelopes.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Environment, SecretKind, SecretRecord};

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // ------------------------------------------------------------------ secret

    pub(super) const SECRET_COLUMNS: &'static str =
        "id, project_id, service_project_id, kind, name, preview, value_blind_index, \
         environment, account_id, notes, created_at, updated_at";

    /// Insert a secret's metadata and its sealed value together.
    #[allow(clippy::too_many_arguments)]
    pub fn create_secret(
        &mut self,
        project_id: Option<Uuid>,
        service_project_id: Option<Uuid>,
        kind: SecretKind,
        name: &str,
        preview: &str,
        value_blind_index: &str,
        environment: Environment,
        envelope: &[u8],
    ) -> Result<SecretRecord> {
        self.create_secret_owned(
            SecretOwner {
                project_id,
                service_project_id,
                account_id: None,
            },
            kind,
            name,
            preview,
            value_blind_index,
            environment,
            None,
            envelope,
        )
    }

    /// Insert a secret against any of the three things one can belong to.
    #[allow(clippy::too_many_arguments)]
    pub fn create_secret_owned(
        &mut self,
        owner: SecretOwner,
        kind: SecretKind,
        name: &str,
        preview: &str,
        value_blind_index: &str,
        environment: Environment,
        notes: Option<&str>,
        envelope: &[u8],
    ) -> Result<SecretRecord> {
        let SecretOwner {
            project_id,
            service_project_id,
            account_id,
        } = owner;
        if project_id.is_none() && service_project_id.is_none() && account_id.is_none() {
            return Err(CoreError::Invalid(
                "a secret must belong to a project, a service resource or an account".into(),
            ));
        }
        let id = Uuid::new_v4();
        let at = now_rfc3339()?;
        let tx = self.conn_mut().transaction()?;
        tx.execute(
            "INSERT INTO secrets
                (id, project_id, service_project_id, account_id, kind, name, preview,
                 value_blind_index, environment, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id.to_string(),
                project_id.map(|v| v.to_string()),
                service_project_id.map(|v| v.to_string()),
                account_id.map(|v| v.to_string()),
                secret_kind_to_str(kind),
                name,
                preview,
                value_blind_index,
                environment_to_str(environment),
                notes,
                at
            ],
        )?;
        tx.execute(
            "INSERT INTO secret_values (secret_id, envelope) VALUES (?1, ?2)",
            params![id.to_string(), envelope],
        )?;
        tx.execute(
            "INSERT INTO audit_log (at, action, entity_kind, entity_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                at,
                "secret.create",
                "secret",
                id.to_string(),
                format!("Stored {} as {name}", kind.label())
            ],
        )?;
        tx.commit()?;

        Ok(SecretRecord {
            id,
            project_id,
            service_project_id,
            account_id,
            kind,
            name: name.to_string(),
            preview: preview.to_string(),
            value_blind_index: value_blind_index.to_string(),
            environment,
            notes: notes.map(str::to_string),
            created_at: parse_rfc3339(&at)?,
            updated_at: parse_rfc3339(&at)?,
        })
    }

    /// Replace a secret's value, keeping its identity and history.
    pub fn update_secret_value(
        &mut self,
        secret_id: Uuid,
        preview: &str,
        value_blind_index: &str,
        envelope: &[u8],
    ) -> Result<()> {
        let at = now_rfc3339()?;
        let tx = self.conn_mut().transaction()?;
        let changed = tx.execute(
            "UPDATE secrets SET preview = ?2, value_blind_index = ?3, updated_at = ?4
             WHERE id = ?1",
            params![secret_id.to_string(), preview, value_blind_index, at],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        tx.execute(
            "UPDATE secret_values SET envelope = ?2 WHERE secret_id = ?1",
            params![secret_id.to_string(), envelope],
        )?;
        tx.execute(
            "INSERT INTO audit_log (at, action, entity_kind, entity_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                at,
                "secret.rotate",
                "secret",
                secret_id.to_string(),
                "Replaced stored value"
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn secret_from_row(
        row: &Row<'_>,
    ) -> rusqlite::Result<(SecretRecord, String, String, String)> {
        let kind: String = row.get(3)?;
        let env: String = row.get(7)?;
        let created: String = row.get(10)?;
        let updated: String = row.get(11)?;
        Ok((
            SecretRecord {
                id: uuid_from(row, 0)?,
                project_id: opt_uuid_from(row, 1)?,
                service_project_id: opt_uuid_from(row, 2)?,
                account_id: opt_uuid_from(row, 8)?,
                kind: SecretKind::GenericApiKey,
                name: row.get(4)?,
                preview: row.get(5)?,
                value_blind_index: row.get(6)?,
                environment: Environment::Unknown,
                notes: row.get(9)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
            },
            kind,
            env,
            format!("{created}|{updated}"),
        ))
    }

    pub(super) fn finish_secret(
        entry: (SecretRecord, String, String, String),
    ) -> Result<SecretRecord> {
        let (mut record, kind, env, stamps) = entry;
        record.kind = secret_kind_from_str(&kind)?;
        record.environment = environment_from_str(&env)?;
        let (created, updated) = stamps
            .split_once('|')
            .ok_or_else(|| CoreError::Storage("corrupt timestamp pair".into()))?;
        record.created_at = parse_rfc3339(created)?;
        record.updated_at = parse_rfc3339(updated)?;
        Ok(record)
    }

    /// Find a secret by the blind index of its value.
    pub fn secret_by_blind_index(&self, index: &str) -> Result<Option<SecretRecord>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE value_blind_index = ?1 LIMIT 1",
            Self::SECRET_COLUMNS
        );
        let row = self
            .conn()
            .query_row(&sql, params![index], Self::secret_from_row)
            .optional()?;
        row.map(Self::finish_secret).transpose()
    }

    /// Find a secret by name, anywhere in the vault.
    pub fn secret_by_name(&self, name: &str) -> Result<Option<SecretRecord>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE name = ?1 ORDER BY created_at LIMIT 1",
            Self::SECRET_COLUMNS
        );
        let row = self
            .conn()
            .query_row(&sql, params![name], Self::secret_from_row)
            .optional()?;
        row.map(Self::finish_secret).transpose()
    }

    /// Fetch a secret by id.
    pub fn secret(&self, id: Uuid) -> Result<Option<SecretRecord>> {
        let sql = format!("SELECT {} FROM secrets WHERE id = ?1", Self::SECRET_COLUMNS);
        let row = self
            .conn()
            .query_row(&sql, params![id.to_string()], Self::secret_from_row)
            .optional()?;
        row.map(Self::finish_secret).transpose()
    }

    /// The SQL fragment matching every secret a DevLedger project can reach.
    ///
    /// That is: filed directly against the project, or against any resource the
    /// project uses.
    pub(super) const SECRETS_FOR_PROJECT_WHERE: &'static str = "
        project_id = ?1
        OR service_project_id IN (
            SELECT r.from_id FROM relations r
            WHERE r.from_kind = 'service_project' AND r.to_kind = 'project'
              AND r.to_id = ?1 AND r.kind = 'used_by'
        )";

    pub(super) fn count_secrets_for_project(&self, project_id: Uuid) -> Result<i64> {
        let sql = format!(
            "SELECT count(*) FROM secrets WHERE {}",
            Self::SECRETS_FOR_PROJECT_WHERE
        );
        Ok(self
            .conn()
            .query_row(&sql, params![project_id.to_string()], |r| r.get(0))?)
    }

    pub(super) fn decorate(&self, secret: SecretRecord) -> Result<VaultEntry> {
        let service_project_name = match secret.service_project_id {
            Some(id) => self
                .conn()
                .query_row(
                    "SELECT name FROM service_projects WHERE id = ?1",
                    params![id.to_string()],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        Ok(VaultEntry {
            client_unsafe: secret.kind.is_client_unsafe(),
            provider: secret.kind.provider(),
            service_project_name,
            secret,
        })
    }

    /// Every secret a DevLedger project can reach.
    pub fn list_secrets_for_project(&self, project_id: Uuid) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE {} ORDER BY name",
            Self::SECRET_COLUMNS,
            Self::SECRETS_FOR_PROJECT_WHERE
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![project_id.to_string()], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            out.push(self.decorate(Self::finish_secret(entry)?)?);
        }
        Ok(out)
    }

    /// Every secret filed against a provider resource.
    pub fn list_secrets_for_service_project(
        &self,
        service_project_id: Uuid,
    ) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE service_project_id = ?1 ORDER BY name",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(
                params![service_project_id.to_string()],
                Self::secret_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            out.push(self.decorate(Self::finish_secret(entry)?)?);
        }
        Ok(out)
    }

    /// Update a secret's metadata, leaving its value untouched.
    pub fn update_secret_meta(
        &self,
        secret_id: Uuid,
        name: &str,
        environment: Environment,
        notes: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE secrets SET name = ?2, environment = ?3, notes = ?4, updated_at = ?5
              WHERE id = ?1",
            params![
                secret_id.to_string(),
                name,
                environment_to_str(environment),
                notes,
                now_rfc3339()?
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        self.audit(
            "secret.update",
            Some("secret"),
            Some(secret_id),
            &format!("Updated the details of {name}"),
        )
    }

    /// Rename a secret and replace its envelope in one transaction.
    ///
    /// The envelope's associated data is the secret's name, so a rename has to
    /// re-seal the value under the new name. Doing both in one transaction means
    /// there is no moment -- not even across a crash -- where the name on the row
    /// and the name the ciphertext was sealed under disagree.
    pub fn rename_secret_resealed(
        &mut self,
        secret_id: Uuid,
        name: &str,
        environment: Environment,
        notes: Option<&str>,
        envelope: &[u8],
    ) -> Result<()> {
        let at = now_rfc3339()?;
        let tx = self.conn_mut().transaction()?;
        let changed = tx.execute(
            "UPDATE secrets SET name = ?2, environment = ?3, notes = ?4, updated_at = ?5
              WHERE id = ?1",
            params![
                secret_id.to_string(),
                name,
                environment_to_str(environment),
                notes,
                at
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        tx.execute(
            "UPDATE secret_values SET envelope = ?2 WHERE secret_id = ?1",
            params![secret_id.to_string(), envelope],
        )?;
        tx.execute(
            "INSERT INTO audit_log (at, action, entity_kind, entity_id, detail)
             VALUES (?1, 'secret.rename', 'secret', ?2, ?3)",
            params![
                at,
                secret_id.to_string(),
                format!("Renamed a secret to {name}")
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Every secret filed against an account, metadata only.
    pub fn list_secrets_for_account(&self, account_id: Uuid) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE account_id = ?1 ORDER BY name",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![account_id.to_string()], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            out.push(self.decorate(Self::finish_secret(entry)?)?);
        }
        Ok(out)
    }

    /// Every secret in the vault, each with a label for what it belongs to.
    ///
    /// The vault-wide Secrets page used to collect secrets project by project,
    /// which missed a password filed on an account and a key on a resource no
    /// project uses. This reads the table itself, so nothing is left out.
    pub fn list_all_secrets(&self) -> Result<Vec<SecretListing>> {
        let sql = format!(
            "SELECT {} FROM secrets ORDER BY name, id",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map([], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            let record = Self::finish_secret(entry)?;
            let owner = self.secret_owner_label(&record)?;
            out.push(SecretListing {
                entry: self.decorate(record)?,
                owner,
            });
        }
        Ok(out)
    }

    pub(super) fn secret_owner_label(&self, secret: &SecretRecord) -> Result<String> {
        if let Some(id) = secret.project_id {
            if let Some(p) = self.project(id)? {
                return Ok(p.name);
            }
        }
        if let Some(id) = secret.account_id {
            if let Some(a) = self.account(id)? {
                return Ok(format!("{} · {}", a.provider.label(), a.label));
            }
        }
        if let Some(id) = secret.service_project_id {
            if let Some(sp) = self.service_project(id)? {
                let users = self.projects_using(id)?;
                return Ok(match users.first() {
                    Some(p) => format!("{} via {}", p.name, sp.name),
                    None => sp.name,
                });
            }
        }
        Ok("Nothing".to_string())
    }

    /// How many secrets a delete would take with it.
    ///
    /// Deleting cascades, and a count shown before the fact is the difference
    /// between an informed decision and an unrecoverable surprise.
    pub fn secrets_owned_directly(&self, project_id: Uuid) -> Result<i64> {
        Ok(self.conn().query_row(
            "SELECT count(*) FROM secrets WHERE project_id = ?1",
            params![project_id.to_string()],
            |r| r.get(0),
        )?)
    }

    /// Read the sealed envelope for a secret.
    pub fn secret_envelope(&self, secret_id: Uuid) -> Result<Vec<u8>> {
        self.conn()
            .query_row(
                "SELECT envelope FROM secret_values WHERE secret_id = ?1",
                params![secret_id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound(format!("envelope for secret {secret_id}")))
    }

    /// Delete a secret and its envelope.
    pub fn delete_secret(&self, secret_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM secrets WHERE id = ?1",
            params![secret_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        self.audit(
            "secret.delete",
            Some("secret"),
            Some(secret_id),
            "Deleted secret",
        )?;
        Ok(())
    }
}
