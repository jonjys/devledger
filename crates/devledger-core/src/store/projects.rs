//! DevLedger's own projects.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Environment, Project, Provider};

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // ----------------------------------------------------------------- project

    /// Insert a DevLedger project.
    pub fn create_project(&self, name: &str, description: Option<&str>) -> Result<Project> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn()
            .execute(
                "INSERT INTO projects (id, name, description, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id.to_string(), name, description, created_at],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    CoreError::Invalid(format!("a project called {name} already exists"))
                }
                other => CoreError::from(other),
            })?;
        self.audit(
            "project.create",
            Some("project"),
            Some(id),
            &format!("Created project {name}"),
        )?;
        Ok(Project {
            id,
            name: name.to_string(),
            description: description.map(str::to_string),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    pub(super) fn project_from_row(row: &Row<'_>) -> rusqlite::Result<(Project, String)> {
        let created: String = row.get(3)?;
        Ok((
            Project {
                id: uuid_from(row, 0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created,
        ))
    }

    /// Fetch a project by id.
    pub fn project(&self, id: Uuid) -> Result<Option<Project>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, name, description, created_at FROM projects WHERE id = ?1",
                params![id.to_string()],
                Self::project_from_row,
            )
            .optional()?;
        match row {
            Some((mut p, created)) => {
                p.created_at = parse_rfc3339(&created)?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    /// Find a project by name, case-insensitively.
    pub fn project_by_name(&self, name: &str) -> Result<Option<Project>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, name, description, created_at
                 FROM projects WHERE name = ?1 COLLATE NOCASE",
                params![name],
                Self::project_from_row,
            )
            .optional()?;
        match row {
            Some((mut p, created)) => {
                p.created_at = parse_rfc3339(&created)?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    /// Every DevLedger project with its counts.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id, name, description, created_at FROM projects ORDER BY name, id")?;
        let raw = stmt
            .query_map([], Self::project_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (mut project, created) in raw {
            project.created_at = parse_rfc3339(&created)?;
            let resources = self.service_projects_for_project(project.id)?;
            let mut providers: Vec<Provider> = Vec::new();
            for r in &resources {
                if !providers.contains(&r.provider) {
                    providers.push(r.provider.clone());
                }
            }
            out.push(ProjectSummary {
                service_project_count: resources.len() as i64,
                secret_count: self.count_secrets_for_project(project.id)?,
                providers,
                project,
            });
        }
        Ok(out)
    }

    /// Rename a project or change its description.
    pub fn update_project(
        &self,
        project_id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<()> {
        let changed = self
            .conn()
            .execute(
                "UPDATE projects SET name = ?2, description = ?3 WHERE id = ?1",
                params![project_id.to_string(), name, description],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    CoreError::Invalid(format!("a project called {name} already exists"))
                }
                other => CoreError::from(other),
            })?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("project {project_id}")));
        }
        self.audit(
            "project.update",
            Some("project"),
            Some(project_id),
            &format!("Renamed to {name}"),
        )?;
        Ok(())
    }

    /// Delete a project. Its resources survive; only the link is lost.
    pub fn delete_project(&self, project_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM projects WHERE id = ?1",
            params![project_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("project {project_id}")));
        }
        self.conn().execute(
            "DELETE FROM relations WHERE to_kind = 'project' AND to_id = ?1",
            params![project_id.to_string()],
        )?;
        self.audit(
            "project.delete",
            Some("project"),
            Some(project_id),
            "Deleted project",
        )?;
        Ok(())
    }

    /// Update the editable fields of a provider resource.
    #[allow(clippy::too_many_arguments)]
    pub fn update_service_project(
        &self,
        id: Uuid,
        name: &str,
        provider_ref: Option<&str>,
        region: Option<&str>,
        environment: Environment,
        url: Option<&str>,
        notes: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE service_projects
                SET name = ?2, provider_ref = ?3, region = ?4, environment = ?5, url = ?6,
                    notes = ?7
              WHERE id = ?1",
            params![
                id.to_string(),
                name,
                provider_ref,
                region,
                environment_to_str(environment),
                url,
                notes
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("resource {id}")));
        }
        self.audit(
            "service_project.update",
            Some("service_project"),
            Some(id),
            &format!("Updated resource {name}"),
        )
    }
}
