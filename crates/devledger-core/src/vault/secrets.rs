//! Sealing, revealing and exporting secret values. The only code that handles plaintext.

use super::*;

impl Vault {
    // ---------------------------------------------------------------- secrets

    #[allow(clippy::too_many_arguments)]
    pub(super) fn insert_secret(
        &mut self,
        project_id: Option<Uuid>,
        service_project_id: Option<Uuid>,
        kind: SecretKind,
        name: &str,
        environment: Environment,
        value: &SecretString,
    ) -> Result<SecretRecord> {
        let (bi, envelope, preview) = self.seal_for_storage(name, value)?;
        let inner = self.unlocked_mut()?;
        inner.store.create_secret(
            project_id,
            service_project_id,
            kind,
            name,
            &preview,
            &bi,
            environment,
            &envelope,
        )
    }

    pub(super) fn write_secret_value(
        &mut self,
        secret_id: Uuid,
        value: &SecretString,
    ) -> Result<()> {
        let name = self
            .unlocked()?
            .store
            .secret(secret_id)?
            .ok_or_else(|| CoreError::NotFound(format!("secret {secret_id}")))?
            .name;
        let (bi, envelope, preview) = self.seal_for_storage(&name, value)?;
        let inner = self.unlocked_mut()?;
        inner
            .store
            .update_secret_value(secret_id, &preview, &bi, &envelope)
    }

    /// Seal a value and compute its blind index.
    ///
    /// The associated data binds the envelope to the secret's name, so a
    /// ciphertext cannot be swapped between two secrets in the same vault
    /// without the AEAD tag failing.
    pub(super) fn seal_for_storage(
        &self,
        name: &str,
        value: &SecretString,
    ) -> Result<(String, Vec<u8>, String)> {
        let inner = self.unlocked()?;
        let bi = blind_index::blind_index(&inner.index_key, DOMAIN_SECRET_VALUE, value.expose())?;
        let envelope = aead::seal(&inner.aead_key, name.as_bytes(), value.expose().as_bytes())?;
        Ok((bi, envelope, mask_preview(value.expose())))
    }

    /// Decrypt a stored secret. **This is the only way plaintext leaves the store.**
    ///
    /// Every call is written to the audit log before the value is returned.
    pub fn reveal_secret(&self, secret_id: Uuid) -> Result<SecretString> {
        let inner = self.unlocked()?;
        let record = inner
            .store
            .secret(secret_id)?
            .ok_or_else(|| CoreError::NotFound(format!("secret {secret_id}")))?;
        let envelope = inner.store.secret_envelope(secret_id)?;
        let plaintext = aead::open(&inner.aead_key, record.name.as_bytes(), &envelope)?;
        let text = String::from_utf8(plaintext.expose().to_vec())
            .map_err(|_| CoreError::Crypto("stored secret is not valid UTF-8".into()))?;
        inner.store.audit(
            "secret.reveal",
            Some("secret"),
            Some(secret_id),
            &format!("Revealed {}", record.name),
        )?;
        Ok(SecretString::new(text))
    }

    /// Render a project's secrets as a `.env` file.
    ///
    /// Produced entirely in Rust so the UI can put it on the clipboard without
    /// ever holding the values in JavaScript. Includes every secret the project
    /// can reach, across all the provider resources it uses.
    pub fn export_env(&self, project_id: Uuid) -> Result<SecretString> {
        self.export_env_for_environment(project_id, None)
    }

    /// Render only one deployment environment. When no environment is given,
    /// duplicate names are allowed only when their decrypted values match.
    pub fn export_env_for_environment(
        &self,
        project_id: Uuid,
        environment: Option<Environment>,
    ) -> Result<SecretString> {
        let inner = self.unlocked()?;
        let entries = inner
            .store
            .list_secrets_for_project(project_id)?
            .into_iter()
            .filter(|entry| environment.is_none_or(|env| entry.secret.environment == env))
            .collect::<Vec<_>>();
        let mut variables = BTreeMap::<String, SecretString>::new();
        for entry in &entries {
            if !valid_env_name(&entry.secret.name) {
                return Err(CoreError::Invalid(format!(
                    "{} is not a valid environment variable name",
                    entry.secret.name
                )));
            }
            let value = self.reveal_secret(entry.secret.id)?;
            if value.expose().contains(['\n', '\r']) {
                return Err(CoreError::Invalid(format!(
                    "{} contains a line break and cannot be exported safely",
                    entry.secret.name
                )));
            }
            if let Some(previous) = variables.get(&entry.secret.name) {
                if previous.expose() != value.expose() {
                    return Err(CoreError::Invalid(format!(
                        "{} has conflicting values; choose one environment or correct the relationship",
                        entry.secret.name
                    )));
                }
            } else {
                variables.insert(entry.secret.name.clone(), value);
            }
        }
        let mut out = String::new();
        for (name, value) in &variables {
            let needs_quotes = value
                .expose()
                .chars()
                .any(|c| c.is_whitespace() || c == '#' || c == '"');
            if needs_quotes {
                let escaped = value.expose().replace('\\', "\\\\").replace('"', "\\\"");
                out.push_str(&format!("{name}=\"{escaped}\"\n"));
            } else {
                out.push_str(&format!("{name}={}\n", value.expose()));
            }
        }
        inner.store.audit(
            "project.export_env",
            Some("project"),
            Some(project_id),
            &format!("Exported {} variables as .env", variables.len()),
        )?;
        Ok(SecretString::new(out))
    }

    /// Variable names a project defines more than once, and where.
    ///
    /// The UI asks for this before offering Copy .env, so a conflict is
    /// something the user sees and resolves rather than an error they hit.
    pub fn env_conflicts(
        &self,
        project_id: Uuid,
        environment: Option<Environment>,
    ) -> Result<Vec<EnvConflict>> {
        let entries: Vec<_> = self
            .unlocked()?
            .store
            .list_secrets_for_project(project_id)?
            .into_iter()
            .filter(|e| environment.is_none_or(|want| e.secret.environment == want))
            .collect();
        Ok(conflicting_names(&entries))
    }

    /// Which environments a project's secrets actually use, in a fixed order.
    pub fn project_environments(&self, project_id: Uuid) -> Result<Vec<Environment>> {
        let entries = self
            .unlocked()?
            .store
            .list_secrets_for_project(project_id)?;
        let mut out: Vec<Environment> = Vec::new();
        for env in [
            Environment::Development,
            Environment::Staging,
            Environment::Production,
            Environment::Unknown,
        ] {
            if entries.iter().any(|e| e.secret.environment == env) {
                out.push(env);
            }
        }
        Ok(out)
    }
}
