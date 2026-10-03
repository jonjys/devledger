//! Resources inside a service -- a Supabase project, a Vercel project, a repo -- and their summaries.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Environment, Provider, ServiceProject};

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // --------------------------------------------------------- service project

    pub(crate) const SERVICE_PROJECT_COLUMNS: &'static str =
        "id, account_id, organization_id, provider, provider_ref, name, region, environment, \
         url, notes, created_at";

    /// Insert a provider resource.
    #[allow(clippy::too_many_arguments)]
    pub fn create_service_project(
        &self,
        account_id: Uuid,
        organization_id: Option<Uuid>,
        provider: &Provider,
        provider_ref: Option<&str>,
        name: &str,
        region: Option<&str>,
        environment: Environment,
    ) -> Result<ServiceProject> {
        self.create_service_project_full(
            account_id,
            organization_id,
            provider,
            provider_ref,
            name,
            region,
            environment,
            None,
            None,
        )
    }

    /// Insert a provider resource, including the details a manual entry carries.
    #[allow(clippy::too_many_arguments)]
    pub fn create_service_project_full(
        &self,
        account_id: Uuid,
        organization_id: Option<Uuid>,
        provider: &Provider,
        provider_ref: Option<&str>,
        name: &str,
        region: Option<&str>,
        environment: Environment,
        url: Option<&str>,
        notes: Option<&str>,
    ) -> Result<ServiceProject> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO service_projects
                (id, account_id, organization_id, provider, provider_ref, name, region,
                 environment, url, notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id.to_string(),
                account_id.to_string(),
                organization_id.map(|v| v.to_string()),
                provider_to_str(provider),
                provider_ref,
                name,
                region,
                environment_to_str(environment),
                url,
                notes,
                created_at
            ],
        )?;
        self.audit(
            "service_project.create",
            Some("service_project"),
            Some(id),
            &format!("Recorded {} resource {name}", provider.label()),
        )?;
        Ok(ServiceProject {
            id,
            account_id,
            organization_id,
            provider: provider.clone(),
            provider_ref: provider_ref.map(str::to_string),
            name: name.to_string(),
            region: region.map(str::to_string),
            environment,
            url: url.map(str::to_string),
            notes: notes.map(str::to_string),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    pub(crate) fn service_project_from_row(
        row: &Row<'_>,
    ) -> rusqlite::Result<(ServiceProject, String, String, String)> {
        let provider: String = row.get(3)?;
        let environment: String = row.get(7)?;
        let created: String = row.get(10)?;
        Ok((
            ServiceProject {
                id: uuid_from(row, 0)?,
                account_id: uuid_from(row, 1)?,
                organization_id: opt_uuid_from(row, 2)?,
                provider: Provider::Unknown,
                provider_ref: row.get(4)?,
                name: row.get(5)?,
                region: row.get(6)?,
                url: row.get(8)?,
                notes: row.get(9)?,
                environment: Environment::Unknown,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            provider,
            environment,
            created,
        ))
    }

    pub(crate) fn finish_service_project(
        entry: (ServiceProject, String, String, String),
    ) -> Result<ServiceProject> {
        let (mut sp, provider, environment, created) = entry;
        sp.provider = provider_from_str(&provider)?;
        sp.environment = environment_from_str(&environment)?;
        sp.created_at = parse_rfc3339(&created)?;
        Ok(sp)
    }

    /// Find a resource by its provider-side reference.
    pub fn service_project_by_ref(
        &self,
        provider: &Provider,
        provider_ref: &str,
    ) -> Result<Option<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects WHERE provider = ?1 AND provider_ref = ?2",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![provider_to_str(provider), provider_ref],
                Self::service_project_from_row,
            )
            .optional()?;
        match row {
            Some(entry) => Ok(Some(Self::finish_service_project(entry)?)),
            None => Ok(None),
        }
    }

    /// Fetch a resource by id.
    pub fn service_project(&self, id: Uuid) -> Result<Option<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects WHERE id = ?1",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![id.to_string()],
                Self::service_project_from_row,
            )
            .optional()?;
        match row {
            Some(entry) => Ok(Some(Self::finish_service_project(entry)?)),
            None => Ok(None),
        }
    }

    /// Move a resource into an organization, or clear its assignment.
    pub fn set_service_project_organization(
        &self,
        service_project_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE service_projects SET organization_id = ?2 WHERE id = ?1",
            params![
                service_project_id.to_string(),
                organization_id.map(|v| v.to_string())
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "service project {service_project_id}"
            )));
        }
        self.audit(
            "service_project.assign_organization",
            Some("service_project"),
            Some(service_project_id),
            match organization_id {
                Some(_) => "Assigned to an organization",
                None => "Cleared its organization",
            },
        )?;
        Ok(())
    }

    /// Move a resource under a different account, setting its organization.
    ///
    /// The organization is written verbatim (including `None`), so a resource
    /// moved to another account never keeps an organization that belongs to the
    /// account it left.
    pub fn set_service_project_account(
        &self,
        service_project_id: Uuid,
        account_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE service_projects SET account_id = ?2, organization_id = ?3 WHERE id = ?1",
            params![
                service_project_id.to_string(),
                account_id.to_string(),
                organization_id.map(|v| v.to_string())
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "service project {service_project_id}"
            )));
        }
        self.audit(
            "service_project.move",
            Some("service_project"),
            Some(service_project_id),
            "Re-parented to another account",
        )?;
        Ok(())
    }

    /// Delete a resource. Its secrets cascade; project links are cleared.
    pub fn delete_service_project(&self, service_project_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM service_projects WHERE id = ?1",
            params![service_project_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "service project {service_project_id}"
            )));
        }
        self.conn().execute(
            "DELETE FROM relations
             WHERE (from_kind = 'service_project' AND from_id = ?1)
                OR (to_kind = 'service_project' AND to_id = ?1)",
            params![service_project_id.to_string()],
        )?;
        self.audit(
            "service_project.delete",
            Some("service_project"),
            Some(service_project_id),
            "Deleted resource",
        )?;
        Ok(())
    }

    /// All resources, newest last.
    pub fn list_service_projects(&self) -> Result<Vec<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects ORDER BY name, id",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map([], Self::service_project_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_service_project).collect()
    }

    /// Build the display summary for a resource.
    pub fn service_project_summary(&self, sp: ServiceProject) -> Result<ServiceProjectSummary> {
        let account_label: String = self.conn().query_row(
            "SELECT label FROM accounts WHERE id = ?1",
            params![sp.account_id.to_string()],
            |r| r.get(0),
        )?;
        let identity_email: Option<String> = self
            .conn()
            .query_row(
                "SELECT i.email FROM accounts a
                 JOIN identities i ON i.id = a.identity_id
                 WHERE a.id = ?1",
                params![sp.account_id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let organization_name: Option<String> = match sp.organization_id {
            Some(org_id) => self
                .conn()
                .query_row(
                    "SELECT name FROM organizations WHERE id = ?1",
                    params![org_id.to_string()],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let secret_count: i64 = self.conn().query_row(
            "SELECT count(*) FROM secrets WHERE service_project_id = ?1",
            params![sp.id.to_string()],
            |r| r.get(0),
        )?;
        let used_by = self.projects_using(sp.id)?;
        Ok(ServiceProjectSummary {
            service_project: sp,
            account_label,
            identity_email,
            organization_name,
            secret_count,
            used_by,
        })
    }

    /// DevLedger projects linked to a resource.
    pub fn projects_using(&self, service_project_id: Uuid) -> Result<Vec<ProjectRefLabel>> {
        let mut stmt = self.conn().prepare(
            "SELECT p.id, p.name FROM relations r
             JOIN projects p ON p.id = r.to_id
             WHERE r.from_kind = 'service_project' AND r.from_id = ?1
               AND r.to_kind = 'project' AND r.kind = 'used_by'
             ORDER BY p.name",
        )?;
        let raw = stmt
            .query_map(params![service_project_id.to_string()], |r| {
                Ok((uuid_from(r, 0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(raw
            .into_iter()
            .map(|(id, name)| ProjectRefLabel { id, name })
            .collect())
    }

    /// Resources linked to a DevLedger project.
    pub fn service_projects_for_project(&self, project_id: Uuid) -> Result<Vec<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects sp
             JOIN relations r ON r.from_id = sp.id
             WHERE r.from_kind = 'service_project' AND r.to_kind = 'project'
               AND r.to_id = ?1 AND r.kind = 'used_by'
             ORDER BY sp.provider, sp.name",
            Self::SERVICE_PROJECT_COLUMNS
                .split(", ")
                .map(|c| format!("sp.{c}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(
                params![project_id.to_string()],
                Self::service_project_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_service_project).collect()
    }
}
