//! Vault lifecycle: onboarding, unlock, lock, and every operation that needs
//! plaintext.
//!
//! A [`Vault`] is either locked (holding nothing but a path) or unlocked
//! (holding an open [`Store`] plus two subkeys). Locking drops the store and
//! zeroizes the keys, so an idle-timeout lock genuinely removes the ability to
//! decrypt rather than just hiding the UI.
//!
//! Smart Paste plaintext lives in the `staging` map for exactly as long as a
//! review sheet is open. It is keyed by analysis id, never serialized, and
//! cleared on lock.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::crypto::blind_index::{
    self, DOMAIN_IDENTITY_EMAIL, DOMAIN_PROJECT_REF, DOMAIN_SECRET_VALUE,
};
use crate::crypto::kdf::{self, KdfParams};
use crate::crypto::{self, aead, LABEL_BLIND_INDEX, LABEL_SECRET_AEAD};
use crate::error::{CoreError, Result};
use crate::model::{
    EntityKind, EntityRef, Environment, Evidence, EvidenceLevel, Project, Provider, RelationKind,
    SecretKind, SecretRecord,
};
use crate::paste::detect::DetectedKind;
use crate::paste::pipeline::{self, MatchLookup, PasteAnalysis, StagedSecrets};
use crate::paste::review::{
    CommitOutcome, EntityDecision, ProposedEndpoint, RecommendedAction, ReviewSubmission,
};
use crate::redact::{Provenance, SourceKind};
use crate::secret::{mask_preview, SecretBytes, SecretString};
use crate::store::{AuditEntry, ProjectSummary, Store, VaultEntry};

/// Name of the cleartext sidecar holding KDF parameters.
pub const META_FILE: &str = "vault.json";
/// Name of the SQLCipher database.
pub const DB_FILE: &str = "devledger.db";

/// On-disk vault metadata. Contains no secret material: the salt and cost
/// parameters must be readable before a passphrase can be turned into a key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultMeta {
    /// Format version of this file.
    pub version: u32,
    /// Argon2id parameters and salt.
    pub kdf: KdfParams,
    /// When the vault was created.
    pub created_at: String,
}

/// A staged analysis awaiting review.
///
/// Both the analysis and its plaintext stay in Rust. The frontend receives a
/// copy of the analysis for display, but `commit_review` reads this one, so a
/// tampered copy coming back over IPC cannot relax a warning or retarget a
/// recommendation.
struct StagedPaste {
    analysis: PasteAnalysis,
    secrets: StagedSecrets,
}

struct Unlocked {
    store: Store,
    aead_key: SecretBytes,
    index_key: SecretBytes,
    staging: HashMap<Uuid, StagedPaste>,
}

/// The DevLedger vault.
pub struct Vault {
    dir: PathBuf,
    inner: Option<Unlocked>,
}

/// A read-only view of the vault's lock state, safe to hand to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultStatus {
    /// Whether a vault exists on disk.
    pub initialized: bool,
    /// Whether it is currently unlocked.
    pub unlocked: bool,
}

impl Vault {
    /// Create a handle for the vault directory. Does not touch the disk.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Vault {
            dir: dir.into(),
            inner: None,
        }
    }

    /// Path of the metadata sidecar.
    pub fn meta_path(&self) -> PathBuf {
        self.dir.join(META_FILE)
    }

    /// Path of the encrypted database.
    pub fn db_path(&self) -> PathBuf {
        self.dir.join(DB_FILE)
    }

    /// Whether a vault has been created in this directory.
    pub fn is_initialized(&self) -> bool {
        self.meta_path().exists()
    }

    /// Whether the vault is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.inner.is_some()
    }

    /// Lock state, for the UI.
    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            initialized: self.is_initialized(),
            unlocked: self.is_unlocked(),
        }
    }

    /// Create a new vault and leave it unlocked.
    pub fn initialize(&mut self, passphrase: &SecretString) -> Result<()> {
        if self.is_initialized() {
            return Err(CoreError::AlreadyInitialized);
        }
        validate_passphrase(passphrase)?;
        fs::create_dir_all(&self.dir)?;

        let params = KdfParams::generate()?;
        self.initialize_with_params(passphrase, params)
    }

    /// Create a vault with explicit KDF parameters. Used by the test suite to
    /// avoid paying the production Argon2id cost in every test.
    #[doc(hidden)]
    pub fn initialize_with_params(
        &mut self,
        passphrase: &SecretString,
        params: KdfParams,
    ) -> Result<()> {
        if self.is_initialized() {
            return Err(CoreError::AlreadyInitialized);
        }
        validate_passphrase(passphrase)?;
        fs::create_dir_all(&self.dir)?;

        let meta = VaultMeta {
            version: 1,
            kdf: params,
            created_at: crate::store::now_rfc3339()?,
        };
        let master = kdf::derive_master_key(passphrase, &meta.kdf)?;
        let unlocked = self.open_unlocked(&master)?;

        unlocked.store.audit(
            "vault.initialize",
            None,
            None,
            "Vault created and encrypted at rest",
        )?;

        // The sidecar is written last: if anything above failed, the directory
        // is still "not initialized" and initialize can be retried cleanly.
        fs::write(self.meta_path(), serde_json::to_vec_pretty(&meta)?)?;
        self.inner = Some(unlocked);
        Ok(())
    }

    /// Derive the master key and open the encrypted store.
    pub fn unlock(&mut self, passphrase: &SecretString) -> Result<()> {
        if self.is_unlocked() {
            return Ok(());
        }
        if !self.is_initialized() {
            return Err(CoreError::NotInitialized);
        }
        let meta: VaultMeta = serde_json::from_slice(&fs::read(self.meta_path())?)?;
        let master = kdf::derive_master_key(passphrase, &meta.kdf)?;
        let unlocked = self.open_unlocked(&master)?;
        unlocked
            .store
            .audit("vault.unlock", None, None, "Vault unlocked")?;
        self.inner = Some(unlocked);
        Ok(())
    }

    fn open_unlocked(&self, master: &SecretBytes) -> Result<Unlocked> {
        let store = Store::open(&self.db_path(), master)?;
        Ok(Unlocked {
            store,
            aead_key: crypto::derive_subkey(master, LABEL_SECRET_AEAD)?,
            index_key: crypto::derive_subkey(master, LABEL_BLIND_INDEX)?,
            staging: HashMap::new(),
        })
    }

    /// Drop the open store, the subkeys, and every staged paste.
    pub fn lock(&mut self) {
        // Dropping `Unlocked` zeroizes both subkeys and clears staging; the
        // `Store` closes its SQLCipher connection, which wipes its page cache.
        self.inner = None;
    }

    fn unlocked(&self) -> Result<&Unlocked> {
        self.inner.as_ref().ok_or(CoreError::VaultLocked)
    }

    fn unlocked_mut(&mut self) -> Result<&mut Unlocked> {
        self.inner.as_mut().ok_or(CoreError::VaultLocked)
    }

    // ------------------------------------------------------------ smart paste

    /// Analyse pasted text and stage its secrets for review.
    ///
    /// Nothing is written to the database by this call.
    pub fn analyze_paste(&mut self, text: &str, source: SourceKind) -> Result<PasteAnalysis> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let inner = self.unlocked_mut()?;
        let lookup = StoreLookup {
            store: &inner.store,
        };
        let (analysis, secrets) = pipeline::analyze(text, source, &inner.index_key, &lookup, now)?;
        inner.staging.insert(
            analysis.analysis_id,
            StagedPaste {
                analysis: analysis.clone(),
                secrets,
            },
        );
        Ok(analysis)
    }

    /// Discard a staged analysis without saving it.
    pub fn discard_analysis(&mut self, analysis_id: Uuid) -> Result<()> {
        self.unlocked_mut()?.staging.remove(&analysis_id);
        Ok(())
    }

    /// Apply a reviewed analysis.
    ///
    /// Returns [`CoreError::Invalid`] if a critical warning is outstanding and
    /// the submission did not acknowledge it, so the block cannot be bypassed
    /// by a frontend that forgets to check.
    pub fn commit_review(&mut self, submission: &ReviewSubmission) -> Result<CommitOutcome> {
        // Peek before removing: a refused commit must leave the analysis staged
        // so the user can acknowledge and retry without re-pasting.
        {
            let inner = self.unlocked()?;
            let staged = inner
                .staging
                .get(&submission.analysis_id)
                .ok_or_else(|| CoreError::StaleAnalysis(submission.analysis_id.to_string()))?;
            if staged.analysis.blocks_save && !submission.acknowledge_critical {
                return Err(CoreError::Invalid(
                    "a critical warning must be acknowledged before saving".into(),
                ));
            }
        }

        let StagedPaste { analysis, secrets } = {
            let inner = self.unlocked_mut()?;
            inner
                .staging
                .remove(&submission.analysis_id)
                .ok_or_else(|| CoreError::StaleAnalysis(submission.analysis_id.to_string()))?
        };
        let analysis = &analysis;
        let staged = &secrets;

        let mut outcome = CommitOutcome::default();
        // Entity index -> the secret row it produced, so the accepted relations
        // can be anchored to real ids rather than to the project as a whole.
        let mut secret_ids: HashMap<usize, Uuid> = HashMap::new();

        // Resolve the project everything will be filed under, creating the
        // Identity -> Account -> Organization -> Project chain if needed.
        let project_id = match submission.target_project_id {
            Some(id) => {
                if self.unlocked()?.store.project(id)?.is_none() {
                    return Err(CoreError::NotFound(format!("project {id}")));
                }
                Some(id)
            }
            None => match analysis.inferred_project_ref.as_deref() {
                Some(project_ref) => {
                    let email = analysis
                        .entities
                        .iter()
                        .find(|e| e.kind == DetectedKind::Email)
                        .map(|e| e.value_preview.clone());
                    Some(self.ensure_project_for_ref(
                        project_ref,
                        email.as_deref(),
                        &mut outcome,
                    )?)
                }
                None => None,
            },
        };

        for decision in &submission.decisions {
            let index = decision.entity_index;
            let entity = analysis
                .entities
                .get(index)
                .ok_or_else(|| CoreError::Invalid(format!("no entity at index {index}")))?;
            let Some(value) = staged.values.get(index).and_then(|v| v.as_ref()) else {
                // Non-secret entities carry no value to store.
                continue;
            };
            let recommended = analysis
                .recommendations
                .get(index)
                .ok_or_else(|| CoreError::Invalid(format!("no recommendation at index {index}")))?;

            let effective = match &decision.decision {
                EntityDecision::Skip => {
                    outcome.entities_skipped += 1;
                    continue;
                }
                EntityDecision::Accept => recommended.clone(),
                EntityDecision::CreateNew => RecommendedAction::Create,
                EntityDecision::Change { secret_id } => RecommendedAction::Update {
                    secret_id: *secret_id,
                },
            };

            let name = decision
                .name_override
                .clone()
                .unwrap_or_else(|| entity.label.clone());
            let kind = entity.secret_kind.unwrap_or(SecretKind::GenericApiKey);

            match effective {
                RecommendedAction::Skip { .. } => {
                    outcome.entities_skipped += 1;
                }
                RecommendedAction::Update { secret_id } => {
                    self.write_secret_value(secret_id, value)?;
                    outcome.secrets_updated += 1;
                    secret_ids.insert(index, secret_id);
                    if let Some(record) = self.unlocked()?.store.secret(secret_id)? {
                        if !outcome.touched_project_ids.contains(&record.project_id) {
                            outcome.touched_project_ids.push(record.project_id);
                        }
                    }
                }
                RecommendedAction::Create => {
                    let target = project_id.ok_or_else(|| {
                        CoreError::Invalid(
                            "no project could be inferred; choose one before saving".into(),
                        )
                    })?;
                    let record =
                        self.insert_secret(target, kind, &name, entity.environment, value)?;
                    secret_ids.insert(index, record.id);
                    outcome.secrets_created += 1;
                    if !outcome.touched_project_ids.contains(&target) {
                        outcome.touched_project_ids.push(target);
                    }
                    self.attach_provenance(
                        EntityRef::new(EntityKind::Secret, record.id),
                        &analysis.provenance,
                    )?;
                }
            }
        }

        // Record the relations the user kept ticked, now that ids exist.
        if let Some(target) = project_id {
            for index in &submission.accepted_relations {
                let Some(relation) = analysis.proposed_relations.get(*index) else {
                    continue;
                };
                let (Some(from), Some(to)) = (
                    resolve_endpoint(&relation.from, target, &secret_ids),
                    resolve_endpoint(&relation.to, target, &secret_ids),
                ) else {
                    // An endpoint that refers to an entity the user skipped has
                    // no row to point at, so the relation is dropped with it.
                    continue;
                };
                let inner = self.unlocked()?;
                inner
                    .store
                    .create_relation(from, to, relation.kind, &relation.evidence)?;
                outcome.relations_created += 1;
            }
        }

        if let (Some(parsed), Some(_)) = (&analysis.subscription, project_id) {
            // Subscriptions hang off the account, which we reach via the project.
            if let Some(account_id) = self.account_for_project(project_id.expect("checked"))? {
                self.unlocked()?
                    .store
                    .create_subscription(account_id, parsed)?;
            }
        }

        let inner = self.unlocked()?;
        inner.store.audit(
            "paste.commit",
            None,
            None,
            &format!(
                "Saved {} new and {} rotated secrets, skipped {}",
                outcome.secrets_created, outcome.secrets_updated, outcome.entities_skipped
            ),
        )?;
        Ok(outcome)
    }

    fn attach_provenance(&self, entity: EntityRef, provenance: &Provenance) -> Result<()> {
        self.unlocked()?.store.record_provenance(entity, provenance)
    }

    fn account_for_project(&self, project_id: Uuid) -> Result<Option<Uuid>> {
        let inner = self.unlocked()?;
        let Some(project) = inner.store.project(project_id)? else {
            return Ok(None);
        };
        let account: Option<String> = inner
            .store
            .conn()
            .query_row(
                "SELECT account_id FROM organizations WHERE id = ?1",
                rusqlite::params![project.organization_id.to_string()],
                |r| r.get(0),
            )
            .ok();
        match account {
            Some(raw) => Ok(Uuid::parse_str(&raw).ok()),
            None => Ok(None),
        }
    }

    /// Find or build the full chain down to a project for `project_ref`.
    fn ensure_project_for_ref(
        &mut self,
        project_ref: &str,
        email: Option<&str>,
        outcome: &mut CommitOutcome,
    ) -> Result<Uuid> {
        if let Some(existing) = self.unlocked()?.store.project_by_ref(project_ref)? {
            return Ok(existing.id);
        }

        let identity_id = self.ensure_identity(email, outcome)?;
        let inner = self.unlocked()?;

        let account_id: Option<String> = inner
            .store
            .conn()
            .query_row(
                "SELECT id FROM accounts WHERE identity_id = ?1 AND provider = ?2",
                rusqlite::params![identity_id.to_string(), "supabase"],
                |r| r.get(0),
            )
            .ok();
        let account_id = match account_id {
            Some(raw) => Uuid::parse_str(&raw)
                .map_err(|e| CoreError::Storage(format!("corrupt account id: {e}")))?,
            None => {
                inner
                    .store
                    .create_account(identity_id, Provider::Supabase, None, "Supabase")?
                    .id
            }
        };

        let org_id: Option<String> = inner
            .store
            .conn()
            .query_row(
                "SELECT id FROM organizations WHERE account_id = ?1 ORDER BY created_at LIMIT 1",
                rusqlite::params![account_id.to_string()],
                |r| r.get(0),
            )
            .ok();
        let org_id = match org_id {
            Some(raw) => Uuid::parse_str(&raw)
                .map_err(|e| CoreError::Storage(format!("corrupt organization id: {e}")))?,
            None => {
                inner
                    .store
                    .create_organization(account_id, None, "Personal")?
                    .id
            }
        };

        let project = inner.store.create_project(
            org_id,
            Some(project_ref),
            project_ref,
            None,
            Environment::Unknown,
        )?;
        outcome.projects_created += 1;
        outcome.relations_created += 1;
        inner.store.create_relation(
            EntityRef::new(EntityKind::Organization, org_id),
            EntityRef::new(EntityKind::Project, project.id),
            RelationKind::Owns,
            &Evidence::new(
                EvidenceLevel::Explicit,
                "structure",
                "Project created under its organization",
            ),
        )?;
        Ok(project.id)
    }

    fn ensure_identity(
        &mut self,
        email: Option<&str>,
        outcome: &mut CommitOutcome,
    ) -> Result<Uuid> {
        let inner = self.unlocked()?;
        if let Some(email) = email {
            let lowered = email.to_ascii_lowercase();
            let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, &lowered)?;
            if let Some(id) = inner.store.identity_id_by_email_index(&bi)? {
                return Ok(id);
            }
            outcome.identities_created += 1;
            return Ok(inner
                .store
                .create_identity(&lowered, Some(&lowered), Some(&bi))?
                .id);
        }

        let existing: Option<String> = inner
            .store
            .conn()
            .query_row(
                "SELECT id FROM identities ORDER BY created_at LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();
        match existing {
            Some(raw) => Uuid::parse_str(&raw)
                .map_err(|e| CoreError::Storage(format!("corrupt identity id: {e}"))),
            None => {
                outcome.identities_created += 1;
                Ok(inner.store.create_identity("This device", None, None)?.id)
            }
        }
    }

    // ---------------------------------------------------------------- secrets

    fn insert_secret(
        &mut self,
        project_id: Uuid,
        kind: SecretKind,
        name: &str,
        environment: Environment,
        value: &SecretString,
    ) -> Result<SecretRecord> {
        let (bi, envelope, preview) = self.seal_for_storage(name, value)?;
        let inner = self.unlocked_mut()?;
        inner.store.create_secret(
            project_id,
            kind,
            name,
            &preview,
            &bi,
            environment,
            &envelope,
        )
    }

    fn write_secret_value(&mut self, secret_id: Uuid, value: &SecretString) -> Result<()> {
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
    fn seal_for_storage(
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
    /// ever holding the values in JavaScript.
    pub fn export_env(&self, project_id: Uuid) -> Result<SecretString> {
        let inner = self.unlocked()?;
        let entries = inner.store.list_secrets(project_id)?;
        let mut out = String::new();
        for entry in &entries {
            let value = self.reveal_secret(entry.secret.id)?;
            let needs_quotes = value
                .expose()
                .chars()
                .any(|c| c.is_whitespace() || c == '#' || c == '"');
            if needs_quotes {
                let escaped = value.expose().replace('\\', "\\\\").replace('"', "\\\"");
                out.push_str(&format!("{}=\"{}\"\n", entry.secret.name, escaped));
            } else {
                out.push_str(&format!("{}={}\n", entry.secret.name, value.expose()));
            }
        }
        inner.store.audit(
            "project.export_env",
            Some("project"),
            Some(project_id),
            &format!("Exported {} secrets as .env", entries.len()),
        )?;
        Ok(SecretString::new(out))
    }

    // ----------------------------------------------------------------- vault

    /// Every project in the vault.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        self.unlocked()?.store.list_projects()
    }

    /// A project's secrets, metadata only.
    pub fn list_secrets(&self, project_id: Uuid) -> Result<Vec<VaultEntry>> {
        self.unlocked()?.store.list_secrets(project_id)
    }

    /// Fetch a project.
    pub fn project(&self, project_id: Uuid) -> Result<Option<Project>> {
        self.unlocked()?.store.project(project_id)
    }

    /// Delete a secret and its ciphertext.
    pub fn delete_secret(&self, secret_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_secret(secret_id)
    }

    /// Create a project by hand, building the owning chain if needed.
    pub fn create_project(
        &mut self,
        name: &str,
        project_ref: Option<&str>,
        environment: Environment,
    ) -> Result<Project> {
        let mut outcome = CommitOutcome::default();
        let identity_id = self.ensure_identity(None, &mut outcome)?;
        let inner = self.unlocked()?;

        let account = inner
            .store
            .create_account(identity_id, Provider::Unknown, None, name)?;
        let org = inner
            .store
            .create_organization(account.id, None, "Personal")?;
        inner
            .store
            .create_project(org.id, project_ref, name, None, environment)
    }

    /// Every relation touching an entity, in either direction.
    pub fn relations_for(&self, entity: EntityRef) -> Result<Vec<crate::model::Relation>> {
        self.unlocked()?.store.relations_for(entity)
    }

    /// Recent audit-log lines.
    pub fn recent_audit(&self, limit: i64) -> Result<Vec<AuditEntry>> {
        self.unlocked()?.store.recent_audit(limit)
    }

    /// Provenance attached to an entity.
    pub fn provenance_for(&self, entity: EntityRef) -> Result<Vec<Provenance>> {
        self.unlocked()?.store.provenance_for(entity)
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

    /// Blind index of a project ref, exposed for tests and tooling.
    #[doc(hidden)]
    pub fn project_ref_index(&self, project_ref: &str) -> Result<String> {
        blind_index::blind_index(&self.unlocked()?.index_key, DOMAIN_PROJECT_REF, project_ref)
    }
}

/// Turn a proposed endpoint into a concrete [`EntityRef`].
///
/// Returns `None` when the endpoint names an entity that was never written,
/// which happens whenever the user skipped that row in the review sheet.
fn resolve_endpoint(
    endpoint: &ProposedEndpoint,
    project_id: Uuid,
    secret_ids: &HashMap<usize, Uuid>,
) -> Option<EntityRef> {
    match endpoint {
        ProposedEndpoint::Existing { entity, .. } => Some(entity.clone()),
        ProposedEndpoint::New {
            kind: EntityKind::Project,
            ..
        } => Some(EntityRef::new(EntityKind::Project, project_id)),
        ProposedEndpoint::New {
            kind: EntityKind::Secret,
            entity_index: Some(index),
            ..
        } => secret_ids
            .get(index)
            .map(|id| EntityRef::new(EntityKind::Secret, *id)),
        ProposedEndpoint::New { .. } => None,
    }
}

/// Reject passphrases that are too weak to be worth deriving from.
fn validate_passphrase(passphrase: &SecretString) -> Result<()> {
    const MIN_LEN: usize = 12;
    if passphrase.len() < MIN_LEN {
        return Err(CoreError::Invalid(format!(
            "passphrase must be at least {MIN_LEN} characters"
        )));
    }
    Ok(())
}

/// Adapts [`Store`] to the pipeline's read-only lookup trait.
struct StoreLookup<'a> {
    store: &'a Store,
}

impl MatchLookup for StoreLookup<'_> {
    fn secret_by_blind_index(&self, index: &str) -> Result<Option<SecretRecord>> {
        self.store.secret_by_blind_index(index)
    }
    fn secret_by_name(&self, name: &str) -> Result<Option<SecretRecord>> {
        self.store.secret_by_name(name)
    }
    fn project_by_ref(&self, project_ref: &str) -> Result<Option<Project>> {
        self.store.project_by_ref(project_ref)
    }
    fn identity_by_email_index(&self, index: &str) -> Result<Option<Uuid>> {
        self.store.identity_id_by_email_index(index)
    }
    fn project_name(&self, id: Uuid) -> Result<Option<String>> {
        Ok(self.store.project(id)?.map(|p| p.name))
    }
}

/// Default vault directory for a given application data root.
pub fn default_vault_dir(app_data: &Path) -> PathBuf {
    app_data.join("vault")
}
