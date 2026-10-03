//! The identity graph the ledger draws, and what needs the user's attention.

use rusqlite::params;

use crate::error::Result;
use crate::model::{EntityKind, EntityRef, Provider};

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::Store;

impl Store {
    // ------------------------------------------------------------------- map

    /// The whole graph, for the map view.
    pub fn identity_graph(&self) -> Result<Vec<IdentityNode>> {
        let mut nodes = Vec::new();
        for identity in self.list_identities()? {
            let mut accounts = Vec::new();
            for account in self.accounts_for_identity(identity.id)? {
                let mut organizations = Vec::new();
                for organization in self.organizations_for_account(account.id)? {
                    let mut service_projects = Vec::new();
                    for sp in self.list_service_projects()? {
                        if sp.organization_id == Some(organization.id) {
                            service_projects.push(self.service_project_summary(sp)?);
                        }
                    }
                    organizations.push(OrganizationNode {
                        organization,
                        service_projects,
                    });
                }
                let mut unassigned = Vec::new();
                for sp in self.list_service_projects()? {
                    if sp.account_id == account.id && sp.organization_id.is_none() {
                        unassigned.push(self.service_project_summary(sp)?);
                    }
                }
                accounts.push(AccountNode {
                    subscriptions: self.subscriptions_for_account(account.id)?,
                    account,
                    organizations,
                    unassigned,
                });
            }
            nodes.push(IdentityNode { identity, accounts });
        }
        Ok(nodes)
    }

    /// Everything DevLedger could not work out on its own.
    pub fn needs_attention(&self) -> Result<Vec<AttentionItem>> {
        let mut items = Vec::new();

        for sp in self.list_service_projects()? {
            // A missing organization is only a gap where there is one to name:
            // every Supabase project sits in an organization, and an account
            // that already has organizations should say which. A GitHub repo
            // or Vercel project on a personal account has none, and drawing
            // that a project uses it must not raise an alarm.
            let expected = matches!(sp.provider, Provider::Supabase)
                || !self.organizations_for_account(sp.account_id)?.is_empty();
            if sp.organization_id.is_none() && expected {
                items.push(AttentionItem {
                    kind: AttentionKind::UnassignedOrganization,
                    title: format!("{} has no organization", sp.name),
                    detail: format!(
                        "DevLedger does not know which {} organization owns this resource. \
                         Assign it so the map is accurate.",
                        sp.provider.label()
                    ),
                    entity: EntityRef::new(EntityKind::ServiceProject, sp.id),
                });
            }
            // Unused is only a gap when it holds keys: they belong in some
            // project's vault. A resource written down by hand -- a paused
            // Supabase project, a repo nothing builds from -- is just a record.
            let holds_keys: i64 = self.conn().query_row(
                "SELECT count(*) FROM secrets WHERE service_project_id = ?1",
                params![sp.id.to_string()],
                |r| r.get(0),
            )?;
            if holds_keys > 0 && self.projects_using(sp.id)?.is_empty() {
                items.push(AttentionItem {
                    kind: AttentionKind::UnlinkedServiceProject,
                    title: format!("{} is not used by any project", sp.name),
                    detail: "Link it to the project that uses it, so its secrets appear in that \
                         project's vault."
                        .to_string(),
                    entity: EntityRef::new(EntityKind::ServiceProject, sp.id),
                });
            }
        }

        for identity in self.list_identities()? {
            if identity.email.is_none() {
                items.push(AttentionItem {
                    kind: AttentionKind::IdentityWithoutEmail,
                    title: format!("{} has no email", identity.label),
                    detail: "Without an email, DevLedger cannot match future pastes to this \
                             identity."
                        .to_string(),
                    entity: EntityRef::new(EntityKind::Identity, identity.id),
                });
            }
        }

        let orphan_sql = format!(
            "SELECT {} FROM secrets
              WHERE project_id IS NULL AND service_project_id IS NULL AND account_id IS NULL",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&orphan_sql)?;
        let raw = stmt
            .query_map([], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for entry in raw {
            let secret = Self::finish_secret(entry)?;
            items.push(AttentionItem {
                kind: AttentionKind::OrphanSecret,
                title: format!("{} is filed against nothing", secret.name),
                detail: "Attach it to a project, a resource or an account.".to_string(),
                entity: EntityRef::new(EntityKind::Secret, secret.id),
            });
        }

        let mut stmt = self.conn().prepare(
            "SELECT id, name FROM secrets s
              WHERE NOT EXISTS (SELECT 1 FROM secret_values v WHERE v.secret_id = s.id)",
        )?;
        let missing = stmt
            .query_map([], |row| Ok((uuid_from(row, 0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name) in missing {
            items.push(AttentionItem {
                kind: AttentionKind::SecretValueMissing,
                title: format!("{name} has no stored value"),
                detail: "This entry lost its encrypted value, which a DevLedger build before \
                         0.6.0 could do while upgrading a 0.3.0 vault. The value cannot be \
                         recovered. Delete the entry and store the credential again."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Secret, id),
            });
        }

        let mut stmt = self.conn().prepare(
            "SELECT a.identity_id, a.provider, count(*) FROM accounts a
              GROUP BY a.identity_id, a.provider HAVING count(*) > 1",
        )?;
        let ambiguous = stmt
            .query_map([], |row| {
                Ok((
                    uuid_from(row, 0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (identity_id, provider, count) in ambiguous {
            let provider = provider_from_str(&provider)?;
            let label = self
                .identity(identity_id)?
                .map(|i| i.label)
                .unwrap_or_else(|| "an identity".to_string());
            items.push(AttentionItem {
                kind: AttentionKind::AmbiguousProviderAccount,
                title: format!("{label} holds {count} {} accounts", provider.label()),
                detail: "That is fine, but a paste naming only the provider cannot say which \
                         account it belongs to. DevLedger will file it under the oldest one and \
                         tell you; move it from the map if it guessed wrong."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Identity, identity_id),
            });
        }

        Ok(items)
    }
}
