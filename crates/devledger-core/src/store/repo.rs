//! Typed reads and writes over the encrypted database.

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{
    Account, EntityRef, Environment, Evidence, Identity, Organization, Project, Provider, Relation,
    RelationKind, SecretKind, SecretRecord, Subscription,
};
use crate::paste::ParsedSubscription;
use crate::redact::Provenance;

use super::enums::*;
use super::{now_rfc3339, parse_rfc3339, to_rfc3339, Store};

/// A project with the counts the vault list needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSummary {
    /// The project itself.
    pub project: Project,
    /// Name of the owning organization.
    pub organization_name: String,
    /// How many secrets it holds.
    pub secret_count: i64,
}

/// A secret as shown in the Project Vault: metadata only, never a value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultEntry {
    /// The secret's metadata.
    pub secret: SecretRecord,
    /// Whether exposing this to client code would be a defect.
    pub client_unsafe: bool,
    /// Provider implied by the secret kind.
    pub provider: Provider,
}

/// One line of the append-only audit log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditEntry {
    /// Monotonic sequence number.
    pub seq: i64,
    /// When it happened, RFC 3339.
    pub at: String,
    /// What happened.
    pub action: String,
    /// Which kind of entity, when applicable.
    pub entity_kind: Option<String>,
    /// Which entity, when applicable.
    pub entity_id: Option<String>,
    /// Human-readable detail. Never contains a secret value.
    pub detail: String,
}

fn uuid_from(row: &Row<'_>, idx: usize) -> rusqlite::Result<Uuid> {
    let raw: String = row.get(idx)?;
    Uuid::parse_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

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
    pub fn identity_id_by_email_index(&self, index: &str) -> Result<Option<Uuid>> {
        let found: Option<String> = self
            .conn()
            .query_row(
                "SELECT id FROM identities WHERE email_blind_index = ?1",
                params![index],
                |r| r.get(0),
            )
            .optional()?;
        match found {
            Some(raw) => {
                Ok(Some(Uuid::parse_str(&raw).map_err(|e| {
                    CoreError::Storage(format!("corrupt identity id: {e}"))
                })?))
            }
            None => Ok(None),
        }
    }

    /// List every identity, oldest first.
    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, label, email, email_blind_index, created_at
             FROM identities ORDER BY created_at, id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Identity {
                    id: uuid_from(r, 0)?,
                    label: r.get(1)?,
                    email: r.get(2)?,
                    email_blind_index: r.get(3)?,
                    created_at: OffsetDateTime::UNIX_EPOCH,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        self.hydrate_identity_timestamps(rows)
    }

    fn hydrate_identity_timestamps(&self, rows: Vec<Identity>) -> Result<Vec<Identity>> {
        let mut out = Vec::with_capacity(rows.len());
        for mut identity in rows {
            let raw: String = self.conn().query_row(
                "SELECT created_at FROM identities WHERE id = ?1",
                params![identity.id.to_string()],
                |r| r.get(0),
            )?;
            identity.created_at = parse_rfc3339(&raw)?;
            out.push(identity);
        }
        Ok(out)
    }

    // ----------------------------------------------------------------- account

    /// Insert an account under an identity.
    pub fn create_account(
        &self,
        identity_id: Uuid,
        provider: Provider,
        external_ref: Option<&str>,
        label: &str,
    ) -> Result<Account> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO accounts (id, identity_id, provider, external_ref, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id.to_string(),
                identity_id.to_string(),
                provider_to_str(provider),
                external_ref,
                label,
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
            provider,
            external_ref: external_ref.map(str::to_string),
            label: label.to_string(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    // ------------------------------------------------------------ organization

    /// Insert an organization under an account.
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

    // ----------------------------------------------------------------- project

    /// Insert a project under an organization.
    pub fn create_project(
        &self,
        organization_id: Uuid,
        provider_project_ref: Option<&str>,
        name: &str,
        region: Option<&str>,
        environment: Environment,
    ) -> Result<Project> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO projects
                (id, organization_id, provider_project_ref, name, region, environment, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id.to_string(),
                organization_id.to_string(),
                provider_project_ref,
                name,
                region,
                environment_to_str(environment),
                created_at
            ],
        )?;
        self.audit(
            "project.create",
            Some("project"),
            Some(id),
            &format!("Created project {name}"),
        )?;
        Ok(Project {
            id,
            organization_id,
            provider_project_ref: provider_project_ref.map(str::to_string),
            name: name.to_string(),
            region: region.map(str::to_string),
            environment,
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    fn project_from_row(row: &Row<'_>) -> rusqlite::Result<(Project, String)> {
        let created_raw: String = row.get(6)?;
        Ok((
            Project {
                id: uuid_from(row, 0)?,
                organization_id: uuid_from(row, 1)?,
                provider_project_ref: row.get(2)?,
                name: row.get(3)?,
                region: row.get(4)?,
                environment: Environment::Unknown,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created_raw,
        ))
    }

    /// Find a project by its provider project ref.
    pub fn project_by_ref(&self, project_ref: &str) -> Result<Option<Project>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, organization_id, provider_project_ref, name, region, environment, created_at
                 FROM projects WHERE provider_project_ref = ?1",
                params![project_ref],
                |r| {
                    let (p, created) = Self::project_from_row(r)?;
                    let env: String = r.get(5)?;
                    Ok((p, created, env))
                },
            )
            .optional()?;
        match row {
            Some((mut p, created, env)) => {
                p.created_at = parse_rfc3339(&created)?;
                p.environment = environment_from_str(&env)?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    /// Fetch a project by id.
    pub fn project(&self, id: Uuid) -> Result<Option<Project>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, organization_id, provider_project_ref, name, region, environment, created_at
                 FROM projects WHERE id = ?1",
                params![id.to_string()],
                |r| {
                    let (p, created) = Self::project_from_row(r)?;
                    let env: String = r.get(5)?;
                    Ok((p, created, env))
                },
            )
            .optional()?;
        match row {
            Some((mut p, created, env)) => {
                p.created_at = parse_rfc3339(&created)?;
                p.environment = environment_from_str(&env)?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    /// List every project with its organization name and secret count.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut stmt = self.conn().prepare(
            "SELECT p.id, p.organization_id, p.provider_project_ref, p.name, p.region,
                    p.environment, p.created_at, o.name,
                    (SELECT count(*) FROM secrets s WHERE s.project_id = p.id)
             FROM projects p
             JOIN organizations o ON o.id = p.organization_id
             ORDER BY p.name, p.id",
        )?;
        let raw = stmt
            .query_map([], |r| {
                let (p, created) = Self::project_from_row(r)?;
                let env: String = r.get(5)?;
                let org_name: String = r.get(7)?;
                let count: i64 = r.get(8)?;
                Ok((p, created, env, org_name, count))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (mut p, created, env, organization_name, secret_count) in raw {
            p.created_at = parse_rfc3339(&created)?;
            p.environment = environment_from_str(&env)?;
            out.push(ProjectSummary {
                project: p,
                organization_name,
                secret_count,
            });
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ secret

    /// Insert a secret's metadata and its sealed value together.
    ///
    /// Both rows are written in one transaction: a metadata row without its
    /// envelope would be an unreadable secret, which is worse than no row.
    #[allow(clippy::too_many_arguments)]
    pub fn create_secret(
        &mut self,
        project_id: Uuid,
        kind: SecretKind,
        name: &str,
        preview: &str,
        value_blind_index: &str,
        environment: Environment,
        envelope: &[u8],
    ) -> Result<SecretRecord> {
        let id = Uuid::new_v4();
        let at = now_rfc3339()?;
        let tx = self.conn_mut().transaction()?;
        tx.execute(
            "INSERT INTO secrets
                (id, project_id, kind, name, preview, value_blind_index, environment,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id.to_string(),
                project_id.to_string(),
                secret_kind_to_str(kind),
                name,
                preview,
                value_blind_index,
                environment_to_str(environment),
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
            kind,
            name: name.to_string(),
            preview: preview.to_string(),
            value_blind_index: value_blind_index.to_string(),
            environment,
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

    fn secret_from_row(row: &Row<'_>) -> rusqlite::Result<(SecretRecord, String, String, String)> {
        let kind: String = row.get(2)?;
        let env: String = row.get(6)?;
        let created: String = row.get(7)?;
        let updated: String = row.get(8)?;
        Ok((
            SecretRecord {
                id: uuid_from(row, 0)?,
                project_id: uuid_from(row, 1)?,
                kind: SecretKind::GenericApiKey,
                name: row.get(3)?,
                preview: row.get(4)?,
                value_blind_index: row.get(5)?,
                environment: Environment::Unknown,
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
            },
            kind,
            env,
            format!("{created}|{updated}"),
        ))
    }

    fn finish_secret(
        mut record: SecretRecord,
        kind: String,
        env: String,
        stamps: String,
    ) -> Result<SecretRecord> {
        record.kind = secret_kind_from_str(&kind)?;
        record.environment = environment_from_str(&env)?;
        let (created, updated) = stamps
            .split_once('|')
            .ok_or_else(|| CoreError::Storage("corrupt timestamp pair".into()))?;
        record.created_at = parse_rfc3339(created)?;
        record.updated_at = parse_rfc3339(updated)?;
        Ok(record)
    }

    const SECRET_COLUMNS: &'static str =
        "id, project_id, kind, name, preview, value_blind_index, environment, created_at, updated_at";

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
        match row {
            Some((r, k, e, s)) => Ok(Some(Self::finish_secret(r, k, e, s)?)),
            None => Ok(None),
        }
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
        match row {
            Some((r, k, e, s)) => Ok(Some(Self::finish_secret(r, k, e, s)?)),
            None => Ok(None),
        }
    }

    /// Fetch a secret by id.
    pub fn secret(&self, id: Uuid) -> Result<Option<SecretRecord>> {
        let sql = format!("SELECT {} FROM secrets WHERE id = ?1", Self::SECRET_COLUMNS);
        let row = self
            .conn()
            .query_row(&sql, params![id.to_string()], Self::secret_from_row)
            .optional()?;
        match row {
            Some((r, k, e, s)) => Ok(Some(Self::finish_secret(r, k, e, s)?)),
            None => Ok(None),
        }
    }

    /// List a project's secrets as vault entries.
    pub fn list_secrets(&self, project_id: Uuid) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE project_id = ?1 ORDER BY name",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![project_id.to_string()], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (r, k, e, s) in raw {
            let secret = Self::finish_secret(r, k, e, s)?;
            out.push(VaultEntry {
                client_unsafe: secret.kind.is_client_unsafe(),
                provider: secret.kind.provider(),
                secret,
            });
        }
        Ok(out)
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

    // ----------------------------------------------------------- subscriptions

    /// Record a parsed subscription against an account.
    pub fn create_subscription(
        &self,
        account_id: Uuid,
        parsed: &ParsedSubscription,
    ) -> Result<Subscription> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO subscriptions
                (id, account_id, plan, status, amount_cents, currency, interval, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id.to_string(),
                account_id.to_string(),
                parsed.plan,
                subscription_status_to_str(parsed.status),
                parsed.amount_cents,
                parsed.currency,
                parsed.interval.map(billing_interval_to_str),
                created_at
            ],
        )?;
        Ok(Subscription {
            id,
            account_id,
            plan: parsed.plan.clone(),
            status: parsed.status,
            amount_cents: parsed.amount_cents,
            currency: parsed.currency.clone(),
            interval: parsed.interval,
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Subscriptions attached to an account.
    pub fn list_subscriptions(&self, account_id: Uuid) -> Result<Vec<Subscription>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, account_id, plan, status, amount_cents, currency, interval, created_at
             FROM subscriptions WHERE account_id = ?1 ORDER BY created_at",
        )?;
        let raw = stmt
            .query_map(params![account_id.to_string()], |r| {
                Ok((
                    uuid_from(r, 0)?,
                    uuid_from(r, 1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (id, account_id, plan, status, amount_cents, currency, interval, created) in raw {
            out.push(Subscription {
                id,
                account_id,
                plan,
                status: subscription_status_from_str(&status)?,
                amount_cents,
                currency,
                interval: match interval {
                    Some(i) => Some(billing_interval_from_str(&i)?),
                    None => None,
                },
                created_at: parse_rfc3339(&created)?,
            });
        }
        Ok(out)
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
