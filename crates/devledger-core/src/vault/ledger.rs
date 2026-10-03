//! Reading the ledger, and linking what is in it.

use super::*;

impl Vault {
    // ----------------------------------------------------------------- vault

    /// Every DevLedger project.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        self.unlocked()?.store.list_projects()
    }

    /// Every secret a project can reach, metadata only.
    pub fn list_secrets(&self, project_id: Uuid) -> Result<Vec<VaultEntry>> {
        self.unlocked()?.store.list_secrets_for_project(project_id)
    }

    /// Fetch a project.
    pub fn project(&self, project_id: Uuid) -> Result<Option<Project>> {
        self.unlocked()?.store.project(project_id)
    }

    /// Create a DevLedger project by hand.
    pub fn create_project(&self, name: &str, description: Option<&str>) -> Result<Project> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("a project needs a name".into()));
        }
        self.unlocked()?.store.create_project(trimmed, description)
    }

    /// Rename a project or change its description.
    pub fn update_project(
        &self,
        project_id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("a project needs a name".into()));
        }
        self.unlocked()?
            .store
            .update_project(project_id, trimmed, description)
    }

    /// Delete a project. Provider resources survive; only the link is lost.
    pub fn delete_project(&self, project_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_project(project_id)
    }

    /// Delete a secret and its ciphertext.
    pub fn delete_secret(&self, secret_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_secret(secret_id)
    }

    /// The whole Identity -> Account -> Organization -> resource graph.
    pub fn identity_graph(&self) -> Result<Vec<IdentityNode>> {
        self.unlocked()?.store.identity_graph()
    }

    /// Everything DevLedger could not work out on its own.
    pub fn needs_attention(&self) -> Result<Vec<AttentionItem>> {
        self.unlocked()?.store.needs_attention()
    }

    /// Every subscription, with the account behind it.
    pub fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>> {
        self.unlocked()?.store.list_subscriptions()
    }

    /// Provider resources linked to a project.
    pub fn service_projects_for_project(&self, project_id: Uuid) -> Result<Vec<ServiceProject>> {
        self.unlocked()?
            .store
            .service_projects_for_project(project_id)
    }

    /// Display summaries for every provider resource.
    pub fn list_service_projects(&self) -> Result<Vec<ServiceProjectSummary>> {
        let inner = self.unlocked()?;
        inner
            .store
            .list_service_projects()?
            .into_iter()
            .map(|sp| inner.store.service_project_summary(sp))
            .collect()
    }

    /// Move a resource into an organization, or clear the assignment.
    pub fn assign_service_project_organization(
        &self,
        service_project_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        self.unlocked()?
            .store
            .set_service_project_organization(service_project_id, organization_id)
    }

    /// Record that a project uses a provider resource.
    pub fn link_service_project(&self, service_project_id: Uuid, project_id: Uuid) -> Result<()> {
        self.unlocked()?.store.create_relation(
            EntityRef::new(EntityKind::ServiceProject, service_project_id),
            EntityRef::new(EntityKind::Project, project_id),
            RelationKind::UsedBy,
            &Evidence::new(
                EvidenceLevel::Explicit,
                "user.linked",
                "Linked by hand in DevLedger",
            ),
        )?;
        Ok(())
    }

    /// Undo [`Vault::link_service_project`].
    pub fn unlink_service_project(&self, service_project_id: Uuid, project_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_relation(
            EntityRef::new(EntityKind::ServiceProject, service_project_id),
            EntityRef::new(EntityKind::Project, project_id),
            RelationKind::UsedBy,
        )
    }

    /// Record that a person works on a project.
    ///
    /// The email does not become the project's parent and nothing moves under
    /// it; this is a line between two things that stay where they are.
    pub fn link_identity_project(&self, identity_id: Uuid, project_id: Uuid) -> Result<()> {
        let inner = self.unlocked()?;
        let identity = EntityRef::new(EntityKind::Identity, identity_id);
        let project = EntityRef::new(EntityKind::Project, project_id);
        if !inner.store.entity_exists(&identity)? || !inner.store.entity_exists(&project)? {
            return Err(CoreError::NotFound("that email or project".into()));
        }
        inner.store.create_relation(
            identity,
            project,
            RelationKind::WorksOn,
            &Evidence::new(
                EvidenceLevel::Explicit,
                "user.linked",
                "Drawn by hand in DevLedger",
            ),
        )?;
        Ok(())
    }

    /// Undo [`Vault::link_identity_project`].
    pub fn unlink_identity_project(&self, identity_id: Uuid, project_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_relation(
            EntityRef::new(EntityKind::Identity, identity_id),
            EntityRef::new(EntityKind::Project, project_id),
            RelationKind::WorksOn,
        )
    }

    /// Every (identity, project) pair a person works on.
    pub fn identity_project_links(&self) -> Result<Vec<(Uuid, Uuid)>> {
        self.unlocked()?.store.identity_project_links()
    }

    /// Create an organization under an account.
    pub fn create_organization(&self, account_id: Uuid, name: &str) -> Result<Organization> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("an organization needs a name".into()));
        }
        let inner = self.unlocked()?;
        if let Some(existing) = inner.store.organization_by_name(account_id, trimmed)? {
            return Ok(existing);
        }
        inner.store.create_organization(account_id, None, trimmed)
    }

    /// Organizations under an account.
    pub fn organizations_for_account(&self, account_id: Uuid) -> Result<Vec<Organization>> {
        self.unlocked()?.store.organizations_for_account(account_id)
    }

    /// Every identity.
    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        self.unlocked()?.store.list_identities()
    }

    /// Accounts belonging to an identity.
    pub fn accounts_for_identity(&self, identity_id: Uuid) -> Result<Vec<Account>> {
        self.unlocked()?.store.accounts_for_identity(identity_id)
    }

    /// Create an identity explicitly from the visual stack editor.
    ///
    /// Email identities keep the same blind-index duplicate protection as Smart Paste.
    pub fn create_identity_manual(&self, label: &str, email: Option<&str>) -> Result<Identity> {
        let trimmed_label = label.trim();
        let normalized_email = match email.map(str::trim).filter(|v| !v.is_empty()) {
            Some(raw) => Some(manual::normalize_email(raw)?),
            None => None,
        };
        if trimmed_label.is_empty() && normalized_email.is_none() {
            return Err(CoreError::Invalid(
                "an identity needs a label or email".into(),
            ));
        }
        let inner = self.unlocked()?;
        if let Some(email) = normalized_email.as_deref() {
            let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, email)?;
            if let Some(id) = inner.store.identity_id_by_email_index(&bi)? {
                return inner
                    .store
                    .identity(id)?
                    .ok_or_else(|| CoreError::NotFound(format!("identity {id}")));
            }
            let display = if trimmed_label.is_empty() {
                email
            } else {
                trimmed_label
            };
            return inner.store.create_identity(display, Some(email), Some(&bi));
        }
        inner.store.create_identity(trimmed_label, None, None)
    }
}
