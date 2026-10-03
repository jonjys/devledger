//! Editing and deleting what is already there, custom fields, and the test hooks.

use super::*;

impl Vault {
    // ----------------------------------------------------- manual entry
    //
    // Everything in this section works with no token, no network and no
    // provider DevLedger knows about. See `crate::manual` for why that is the
    // baseline rather than the fallback.

    /// Rename an identity.
    pub fn update_identity(&self, identity_id: Uuid, label: &str) -> Result<()> {
        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Invalid("an identity needs a name".into()));
        }
        self.unlocked()?
            .store
            .update_identity_label(identity_id, label)
    }

    /// Delete an identity and everything filed under it.
    pub fn delete_identity(&self, identity_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_identity(identity_id)
    }

    /// Attach another email address to an identity.
    pub fn add_identity_email(
        &self,
        identity_id: Uuid,
        address: &str,
        make_primary: bool,
    ) -> Result<IdentityEmail> {
        let address = manual::normalize_email(address)?;
        let inner = self.unlocked()?;
        let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, &address)?;
        let is_first = inner.store.identity_emails(identity_id)?.is_empty();
        inner
            .store
            .add_identity_email(identity_id, &address, &bi, make_primary || is_first)
    }

    /// Every address attached to an identity.
    pub fn identity_emails(&self, identity_id: Uuid) -> Result<Vec<IdentityEmail>> {
        self.unlocked()?.store.identity_emails(identity_id)
    }

    /// Choose which address an identity is shown and matched by.
    pub fn set_primary_email(&self, identity_id: Uuid, email_id: Uuid) -> Result<()> {
        let inner = self.unlocked()?;
        let emails = inner.store.identity_emails(identity_id)?;
        let target = emails
            .iter()
            .find(|e| e.id == email_id)
            .ok_or_else(|| CoreError::NotFound(format!("email {email_id}")))?;
        inner
            .store
            .set_primary_email(identity_id, &target.blind_index)
    }

    /// Detach an address from an identity.
    pub fn remove_identity_email(&self, identity_id: Uuid, email_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .remove_identity_email(identity_id, email_id)
    }

    /// Edit an account's label and login details.
    pub fn update_account(
        &self,
        account_id: Uuid,
        label: &str,
        details: &AccountDetails,
    ) -> Result<()> {
        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        self.unlocked()?
            .store
            .update_account(account_id, label, details)
    }

    /// Fetch one account.
    pub fn account(&self, account_id: Uuid) -> Result<Option<Account>> {
        self.unlocked()?.store.account(account_id)
    }

    /// Every secret filed against an account.
    pub fn account_secrets(&self, account_id: Uuid) -> Result<Vec<VaultEntry>> {
        self.unlocked()?.store.list_secrets_for_account(account_id)
    }

    /// Edit a provider resource.
    pub fn update_resource(&self, id: Uuid, edit: &manual::ResourceEdit) -> Result<()> {
        let name = edit.name.trim();
        if name.is_empty() {
            return Err(CoreError::Invalid("a resource needs a name".into()));
        }
        self.unlocked()?.store.update_service_project(
            id,
            name,
            manual::clean(edit.provider_ref.as_deref()).as_deref(),
            manual::clean(edit.region.as_deref()).as_deref(),
            edit.environment,
            manual::clean(edit.url.as_deref()).as_deref(),
            manual::clean(edit.notes.as_deref()).as_deref(),
        )
    }

    /// Store a secret entered by hand: a password, an API key, an env var.
    ///
    /// The value arrives as a [`SecretString`], is sealed before it touches the
    /// database, and is never returned by this call.
    pub fn store_secret(
        &mut self,
        entry: &manual::NewSecret,
        value: &SecretString,
    ) -> Result<SecretRecord> {
        entry.validate()?;
        if value.expose().is_empty() {
            return Err(CoreError::Invalid("a secret needs a value".into()));
        }
        let name = entry.name.trim().to_string();
        let notes = manual::clean(entry.notes.as_deref());
        let (bi, envelope, preview) = self.seal_for_storage(&name, value)?;
        let inner = self.unlocked_mut()?;
        inner.store.create_secret_owned(
            entry.owner,
            entry.kind,
            &name,
            &preview,
            &bi,
            entry.environment,
            notes.as_deref(),
            &envelope,
        )
    }

    /// Edit a secret's name, environment or note, leaving its value alone.
    ///
    /// A rename is not metadata-only: the value is sealed with the name as
    /// associated data, so it is decrypted under the old name and re-sealed
    /// under the new one. Changing only the environment or note leaves the
    /// ciphertext untouched.
    pub fn update_secret_meta(
        &mut self,
        secret_id: Uuid,
        name: &str,
        environment: Environment,
        notes: Option<&str>,
    ) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CoreError::Invalid("a secret needs a name".into()));
        }
        let notes = manual::clean(notes);
        let current = self
            .unlocked()?
            .store
            .secret(secret_id)?
            .ok_or_else(|| CoreError::NotFound(format!("secret {secret_id}")))?;

        if current.name == name {
            return self.unlocked()?.store.update_secret_meta(
                secret_id,
                name,
                environment,
                notes.as_deref(),
            );
        }

        let inner = self.unlocked()?;
        let envelope = inner.store.secret_envelope(secret_id)?;
        let plaintext = aead::open(&inner.aead_key, current.name.as_bytes(), &envelope)?;
        let resealed = aead::seal(&inner.aead_key, name.as_bytes(), plaintext.expose())?;
        self.unlocked_mut()?.store.rename_secret_resealed(
            secret_id,
            name,
            environment,
            notes.as_deref(),
            &resealed,
        )
    }

    /// Replace a secret's value, keeping its identity, name and history.
    pub fn replace_secret_value(&mut self, secret_id: Uuid, value: &SecretString) -> Result<()> {
        if value.expose().is_empty() {
            return Err(CoreError::Invalid("a secret needs a value".into()));
        }
        self.write_secret_value(secret_id, value)
    }

    /// The whole ledger, one row per identity, from address down to project.
    pub fn overview(&self) -> Result<Vec<OverviewIdentity>> {
        let inner = self.unlocked()?;
        let mut out = Vec::new();
        for node in inner.store.identity_graph()? {
            let emails = inner.store.identity_emails(node.identity.id)?;

            // Reachable projects are collected across every resource under
            // every account, de-duplicated: one project often uses several
            // resources belonging to the same person.
            let mut projects: Vec<ProjectRefLabel> = Vec::new();
            let mut secret_count = 0i64;
            for account in &node.accounts {
                secret_count += inner.store.list_secrets_for_account(account.id())?.len() as i64;
                let resources = account
                    .organizations
                    .iter()
                    .flat_map(|o| o.service_projects.iter())
                    .chain(account.unassigned.iter());
                for resource in resources {
                    secret_count += resource.secret_count;
                    for project in &resource.used_by {
                        if !projects.iter().any(|p| p.id == project.id) {
                            projects.push(project.clone());
                        }
                    }
                }
            }
            projects.sort_by_key(|p| p.name.to_lowercase());

            out.push(OverviewIdentity {
                identity: node.identity,
                emails,
                accounts: node.accounts,
                projects,
                secret_count,
            });
        }
        Ok(out)
    }

    /// Every secret in the vault, metadata only, with what each belongs to.
    pub fn list_all_secrets(&self) -> Result<Vec<crate::store::SecretListing>> {
        self.unlocked()?.store.list_all_secrets()
    }

    /// Longest label a custom field accepts.
    pub const FIELD_LABEL_MAX: usize = 80;
    /// Longest value a custom field accepts. Longer text belongs in notes.
    pub const FIELD_VALUE_MAX: usize = 4000;

    /// Attach a field the user named to a person, account, project or resource.
    pub fn add_custom_field(
        &self,
        entity: &EntityRef,
        label: &str,
        value: &str,
    ) -> Result<CustomField> {
        let (label, value) = Self::clean_field(label, value)?;
        let inner = self.unlocked()?;
        if !inner.store.entity_exists(entity)? {
            return Err(CoreError::NotFound(format!(
                "{:?} {}",
                entity.kind, entity.id
            )));
        }
        inner.store.create_custom_field(entity, &label, &value)
    }

    /// Change a field's label or value.
    pub fn update_custom_field(&self, id: Uuid, label: &str, value: &str) -> Result<()> {
        let (label, value) = Self::clean_field(label, value)?;
        self.unlocked()?
            .store
            .update_custom_field(id, &label, &value)
    }

    /// Remove a field.
    pub fn delete_custom_field(&self, id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_custom_field(id)
    }

    /// Every field attached to an entity, in display order.
    pub fn custom_fields(&self, entity: &EntityRef) -> Result<Vec<CustomField>> {
        self.unlocked()?.store.custom_fields_for(entity)
    }

    pub(super) fn clean_field(label: &str, value: &str) -> Result<(String, String)> {
        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Invalid("a field needs a name".into()));
        }
        if label.chars().count() > Self::FIELD_LABEL_MAX {
            return Err(CoreError::Invalid(format!(
                "a field name can be at most {} characters",
                Self::FIELD_LABEL_MAX
            )));
        }
        let value = value.trim();
        if value.chars().count() > Self::FIELD_VALUE_MAX {
            return Err(CoreError::Invalid(format!(
                "a field value can be at most {} characters",
                Self::FIELD_VALUE_MAX
            )));
        }
        Ok((label.to_string(), value.to_string()))
    }

    /// How much a project delete would take with it.
    ///
    /// Deleting cascades to the secrets filed directly against the project.
    /// Returning the count lets the UI say so before the fact rather than after.
    pub fn project_deletion_impact(&self, project_id: Uuid) -> Result<DeletionImpact> {
        let inner = self.unlocked()?;
        Ok(DeletionImpact {
            secrets_deleted: inner.store.secrets_owned_directly(project_id)?,
            resources_unlinked: inner.store.service_projects_for_project(project_id)?.len() as i64,
        })
    }

    /// The open store, so an integration test can assert on the tables
    /// directly. Not for application code.
    #[doc(hidden)]
    pub fn store_for_test(&self) -> Result<&Store> {
        Ok(&self.unlocked()?.store)
    }

    /// Attempt to rewrite the audit log. Always fails; exists so the
    /// append-only triggers can be exercised from an integration test without
    /// exposing a general-purpose SQL escape hatch.
    #[doc(hidden)]
    pub fn attempt_audit_mutation(&self) -> Result<()> {
        let conn = self.unlocked()?.store.conn();
        conn.execute("UPDATE audit_log SET detail = 'tampered'", [])?;
        conn.execute("DELETE FROM audit_log", [])?;
        Ok(())
    }
}
