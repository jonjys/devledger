//! Storage for Connect & Discover.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::connect::{Connection, ConnectionSummary, ConnectorId, Discovery};
use crate::error::{CoreError, Result};
use crate::model::{Organization, Provider, ServiceProject};

use super::enums::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    /// Insert a connection and its sealed credential.
    #[allow(clippy::too_many_arguments)]
    pub fn create_connection(
        &self,
        connector_id: &ConnectorId,
        identity_id: Uuid,
        account_id: Uuid,
        label: &str,
        account_fingerprint: &str,
        auth_kind: &str,
        credential: &[u8],
    ) -> Result<Connection> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn()
            .execute(
                "INSERT INTO connections
                    (id, connector_id, identity_id, account_id, label, account_fingerprint,
                     auth_kind, credential, created_at, last_checked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    id.to_string(),
                    connector_id.as_str(),
                    identity_id.to_string(),
                    account_id.to_string(),
                    label,
                    account_fingerprint,
                    auth_kind,
                    credential,
                    created_at
                ],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    CoreError::Invalid(
                        "this provider account is already connected. Refresh it instead.".into(),
                    )
                }
                other => CoreError::from(other),
            })?;
        self.audit(
            "connection.create",
            Some("account"),
            Some(account_id),
            &format!("Connected {connector_id} account {label}"),
        )?;
        Ok(Connection {
            id,
            connector_id: connector_id.clone(),
            identity_id,
            account_id,
            label: label.to_string(),
            account_fingerprint: account_fingerprint.to_string(),
            created_at: parse_rfc3339(&created_at)?,
            last_checked_at: Some(parse_rfc3339(&created_at)?),
        })
    }

    const CONNECTION_COLUMNS: &'static str =
        "id, connector_id, identity_id, account_id, label, account_fingerprint, \
         created_at, last_checked_at";

    fn connection_from_row(
        row: &Row<'_>,
    ) -> rusqlite::Result<(Connection, String, Option<String>)> {
        let created: String = row.get(6)?;
        let checked: Option<String> = row.get(7)?;
        let connector: String = row.get(1)?;
        Ok((
            Connection {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                connector_id: ConnectorId(connector),
                identity_id: Uuid::parse_str(&row.get::<_, String>(2)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                account_id: Uuid::parse_str(&row.get::<_, String>(3)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                label: row.get(4)?,
                account_fingerprint: row.get(5)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
                last_checked_at: None,
            },
            created,
            checked,
        ))
    }

    fn finish_connection(entry: (Connection, String, Option<String>)) -> Result<Connection> {
        let (mut connection, created, checked) = entry;
        connection.created_at = parse_rfc3339(&created)?;
        connection.last_checked_at = match checked {
            Some(raw) => Some(parse_rfc3339(&raw)?),
            None => None,
        };
        Ok(connection)
    }

    /// Every connection, newest first.
    pub fn list_connections(&self) -> Result<Vec<Connection>> {
        let sql = format!(
            "SELECT {} FROM connections ORDER BY connector_id, created_at",
            Self::CONNECTION_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map([], Self::connection_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_connection).collect()
    }

    /// Fetch one connection.
    pub fn connection(&self, id: Uuid) -> Result<Option<Connection>> {
        let sql = format!(
            "SELECT {} FROM connections WHERE id = ?1",
            Self::CONNECTION_COLUMNS
        );
        let row = self
            .conn()
            .query_row(&sql, params![id.to_string()], Self::connection_from_row)
            .optional()?;
        row.map(Self::finish_connection).transpose()
    }

    /// Find a connection by the account fingerprint, so a reconnect is
    /// recognised instead of creating a duplicate.
    pub fn connection_by_fingerprint(
        &self,
        connector_id: &ConnectorId,
        fingerprint: &str,
    ) -> Result<Option<Connection>> {
        let sql = format!(
            "SELECT {} FROM connections WHERE connector_id = ?1 AND account_fingerprint = ?2",
            Self::CONNECTION_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![connector_id.as_str(), fingerprint],
                Self::connection_from_row,
            )
            .optional()?;
        row.map(Self::finish_connection).transpose()
    }

    /// The sealed credential for a connection.
    pub fn connection_credential(&self, id: Uuid) -> Result<Vec<u8>> {
        self.conn()
            .query_row(
                "SELECT credential FROM connections WHERE id = ?1",
                params![id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound(format!("credential for connection {id}")))
    }

    /// Replace a connection's credential, for a re-authorisation.
    pub fn update_connection_credential(&self, id: Uuid, credential: &[u8]) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE connections SET credential = ?2 WHERE id = ?1",
            params![id.to_string(), credential],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("connection {id}")));
        }
        self.audit(
            "connection.reauthorize",
            None,
            Some(id),
            "Replaced stored credential",
        )?;
        Ok(())
    }

    /// Record that discovery ran.
    pub fn touch_connection(&self, id: Uuid) -> Result<()> {
        self.conn().execute(
            "UPDATE connections SET last_checked_at = ?2 WHERE id = ?1",
            params![id.to_string(), now_rfc3339()?],
        )?;
        Ok(())
    }

    /// Rename a connection.
    pub fn rename_connection(&self, id: Uuid, label: &str) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE connections SET label = ?2 WHERE id = ?1",
            params![id.to_string(), label],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("connection {id}")));
        }
        Ok(())
    }

    /// Remove a connection and its credential.
    ///
    /// The discovered graph survives on purpose: disconnecting revokes
    /// DevLedger's access, it does not erase what you learned.
    pub fn delete_connection(&self, id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM connections WHERE id = ?1",
            params![id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("connection {id}")));
        }
        self.audit(
            "connection.delete",
            None,
            Some(id),
            "Disconnected; credential deleted, imported data kept",
        )?;
        Ok(())
    }

    /// Cache the latest discovery so the review screen can be reopened.
    pub fn save_discovery(&self, connection_id: Uuid, discovery: &Discovery) -> Result<()> {
        self.conn().execute(
            "INSERT INTO discoveries (connection_id, payload, fetched_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (connection_id) DO UPDATE SET payload = ?2, fetched_at = ?3",
            params![
                connection_id.to_string(),
                serde_json::to_string(discovery)?,
                now_rfc3339()?
            ],
        )?;
        Ok(())
    }

    /// The cached discovery for a connection.
    pub fn latest_discovery(&self, connection_id: Uuid) -> Result<Option<Discovery>> {
        let raw: Option<String> = self
            .conn()
            .query_row(
                "SELECT payload FROM discoveries WHERE connection_id = ?1",
                params![connection_id.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        match raw {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    /// Counts for the Connections screen.
    pub fn connection_summary(&self, connection: Connection) -> Result<ConnectionSummary> {
        let identity_email: Option<String> = self
            .conn()
            .query_row(
                "SELECT email FROM identities WHERE id = ?1",
                params![connection.identity_id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let organization_count: i64 = self.conn().query_row(
            "SELECT count(*) FROM organizations WHERE account_id = ?1",
            params![connection.account_id.to_string()],
            |r| r.get(0),
        )?;
        let resource_count: i64 = self.conn().query_row(
            "SELECT count(*) FROM service_projects WHERE account_id = ?1",
            params![connection.account_id.to_string()],
            |r| r.get(0),
        )?;
        Ok(ConnectionSummary {
            connection,
            identity_email,
            organization_count,
            resource_count,
        })
    }

    // ------------------------------------------------- reconciliation lookups

    /// An organization under an account carrying a provider id.
    pub fn organization_by_provider_id(
        &self,
        account_id: Uuid,
        provider_org_id: &str,
    ) -> Result<Option<Organization>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, account_id, provider_org_id, name, created_at
                 FROM organizations WHERE account_id = ?1 AND provider_org_id = ?2",
                params![account_id.to_string(), provider_org_id],
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

    /// A resource with this name under an account.
    pub fn service_project_by_name_in_account(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> Result<Option<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects
             WHERE account_id = ?1 AND name = ?2 COLLATE NOCASE LIMIT 1",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![account_id.to_string(), name],
                Self::service_project_from_row,
            )
            .optional()?;
        row.map(Self::finish_service_project).transpose()
    }

    /// Attach a provider id to an organization that was created without one.
    pub fn set_organization_provider_id(
        &self,
        organization_id: Uuid,
        provider_org_id: &str,
    ) -> Result<()> {
        self.conn().execute(
            "UPDATE organizations SET provider_org_id = ?2 WHERE id = ?1",
            params![organization_id.to_string(), provider_org_id],
        )?;
        Ok(())
    }

    /// Rename an organization.
    pub fn rename_organization(&self, organization_id: Uuid, name: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE organizations SET name = ?2 WHERE id = ?1",
            params![organization_id.to_string(), name],
        )?;
        Ok(())
    }

    /// Update a resource's provider-side facts after a discovery.
    pub fn update_service_project_from_provider(
        &self,
        service_project_id: Uuid,
        name: &str,
        provider_ref: &str,
        region: Option<&str>,
    ) -> Result<()> {
        self.conn().execute(
            "UPDATE service_projects
                SET name = ?2, provider_ref = ?3, region = COALESCE(?4, region)
              WHERE id = ?1",
            params![service_project_id.to_string(), name, provider_ref, region],
        )?;
        Ok(())
    }

    /// Whether any account other than `account_id` already holds this ref.
    pub fn ref_belongs_to_other_account(
        &self,
        provider: &Provider,
        provider_ref: &str,
        account_id: Uuid,
    ) -> Result<bool> {
        let found: Option<String> = self
            .conn()
            .query_row(
                "SELECT account_id FROM service_projects
                 WHERE provider = ?1 AND provider_ref = ?2",
                params![provider_to_str(provider), provider_ref],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match found {
            Some(raw) => raw != account_id.to_string(),
            None => false,
        })
    }
}
