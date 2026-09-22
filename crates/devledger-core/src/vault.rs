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

use crate::crypto::blind_index::{self, DOMAIN_IDENTITY_EMAIL, DOMAIN_SECRET_VALUE};
use crate::crypto::kdf::{self, KdfParams};
use crate::crypto::{self, aead, LABEL_BLIND_INDEX, LABEL_SECRET_AEAD};
use crate::error::{CoreError, Result};
use crate::model::{
    Account, BillingInterval, EntityKind, EntityRef, Environment, Evidence, EvidenceLevel,
    Identity, Organization, Project, Provider, Relation, RelationKind, SecretKind, SecretRecord,
    ServiceProject, Subscription, SubscriptionStatus,
};
use crate::paste::pipeline::{self, MatchLookup, PasteAnalysis, StagedSecrets};
use crate::paste::review::{
    AnswerChoice, ChainRole, CommitOutcome, EntityDecision, ProposedChain, ProposedEndpoint,
    RecommendedAction, ReviewSubmission,
};
use crate::paste::ParsedSubscription;
use crate::paste::{Q_IDENTITY, Q_ORGANIZATION, Q_PROJECT};
use crate::redact::{Provenance, SourceKind};
use crate::secret::{mask_preview, SecretBytes, SecretString};
use crate::store::{
    AttentionItem, AuditEntry, IdentityNode, ProjectSummary, ServiceProjectSummary, Store,
    SubscriptionSummary, VaultEntry,
};

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

/// The ids the chain resolved to during a commit.
#[derive(Default)]
struct ResolvedChain {
    identity: Option<Uuid>,
    account: Option<Uuid>,
    organization: Option<Uuid>,
    service_project: Option<Uuid>,
    project: Option<Uuid>,
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

    /// The open store. Errors when locked.
    pub(crate) fn store(&self) -> Result<&Store> {
        Ok(&self.unlocked()?.store)
    }

    /// The per-secret AEAD key. Errors when locked.
    pub(crate) fn aead_key(&self) -> Result<&SecretBytes> {
        Ok(&self.unlocked()?.aead_key)
    }

    /// The blind-index key. Errors when locked.
    pub(crate) fn index_key(&self) -> Result<&SecretBytes> {
        Ok(&self.unlocked()?.index_key)
    }

    /// Find or create the identity for an email address.
    pub(crate) fn identity_id_for_email(&self, email: &str) -> Result<Uuid> {
        let inner = self.unlocked()?;
        let lowered = email.trim().to_ascii_lowercase();
        let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, &lowered)?;
        if let Some(id) = inner.store.identity_id_by_email_index(&bi)? {
            return Ok(id);
        }
        Ok(inner
            .store
            .create_identity(&lowered, Some(&lowered), Some(&bi))?
            .id)
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

        let mut outcome = CommitOutcome::default();
        let resolved = self.resolve_chain(&analysis, submission, &mut outcome)?;

        // Entity index -> the secret row it produced, so accepted relations can
        // be anchored to real ids.
        let mut secret_ids: HashMap<usize, Uuid> = HashMap::new();

        for decision in &submission.decisions {
            let index = decision.entity_index;
            let entity = analysis
                .entities
                .get(index)
                .ok_or_else(|| CoreError::Invalid(format!("no entity at index {index}")))?;
            let Some(value) = secrets.values.get(index).and_then(|v| v.as_ref()) else {
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
                RecommendedAction::Skip { .. } => outcome.entities_skipped += 1,
                RecommendedAction::Update { secret_id } => {
                    self.write_secret_value(secret_id, value)?;
                    secret_ids.insert(index, secret_id);
                    outcome.secrets_updated += 1;
                }
                RecommendedAction::Create => {
                    // A secret goes against the provider resource when there is
                    // one, because that is what it authenticates to. Otherwise
                    // it is filed directly against the project.
                    if resolved.service_project.is_none() && resolved.project.is_none() {
                        return Err(CoreError::Invalid(
                            "choose a project before saving: these credentials have nothing to \
                             attach to"
                                .into(),
                        ));
                    }
                    let record = self.insert_secret(
                        if resolved.service_project.is_some() {
                            None
                        } else {
                            resolved.project
                        },
                        resolved.service_project,
                        kind,
                        &name,
                        entity.environment,
                        value,
                    )?;
                    secret_ids.insert(index, record.id);
                    outcome.secrets_created += 1;
                    self.attach_provenance(
                        EntityRef::new(EntityKind::Secret, record.id),
                        &analysis.provenance,
                    )?;
                }
            }
        }

        if let Some(project_id) = resolved.project {
            if !outcome.touched_project_ids.contains(&project_id) {
                outcome.touched_project_ids.push(project_id);
            }
        }

        // Record the relations the user kept ticked, now that ids exist.
        for index in &submission.accepted_relations {
            let Some(relation) = analysis.proposed_relations.get(*index) else {
                continue;
            };
            let (Some(from), Some(to)) = (
                resolve_endpoint(&relation.from, &resolved, &secret_ids),
                resolve_endpoint(&relation.to, &resolved, &secret_ids),
            ) else {
                // An endpoint referring to something the user skipped has no row
                // to point at, so the relation is dropped with it.
                continue;
            };
            self.unlocked()?
                .store
                .create_relation(from, to, relation.kind, &relation.evidence)?;
            outcome.relations_created += 1;
        }

        if let (Some(parsed), Some(account_id)) = (&analysis.subscription, resolved.account) {
            self.unlocked()?
                .store
                .create_subscription(account_id, parsed)?;
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

    /// Turn the proposed chain plus the user's answers into concrete rows.
    ///
    /// The rule this method exists to enforce: an organization is created only
    /// when the user named one or confirmed one. A rung DevLedger is unsure
    /// about is left empty and surfaces under Needs attention afterwards.
    fn resolve_chain(
        &mut self,
        analysis: &PasteAnalysis,
        submission: &ReviewSubmission,
        outcome: &mut CommitOutcome,
    ) -> Result<ResolvedChain> {
        let chain: &ProposedChain = &analysis.chain;
        let provider = analysis.provider;
        let mut resolved = ResolvedChain::default();

        let needs_account = chain.service_project.is_some() || chain.account.is_some();

        // --- identity
        resolved.identity = match pipeline::answer_for(&submission.answers, Q_IDENTITY) {
            Some(AnswerChoice::Existing { entity }) => Some(entity.id),
            Some(AnswerChoice::NewNamed { name }) => Some(self.identity_for_email(name, outcome)?),
            Some(AnswerChoice::Unknown) | None => match &chain.identity {
                Some(node) => Some(self.identity_for_email(&node.label, outcome)?),
                None if needs_account => Some(self.unidentified_identity(outcome)?),
                None => None,
            },
        };

        // --- account
        if needs_account && provider != Provider::Unknown {
            if let Some(identity_id) = resolved.identity {
                let existing = self.unlocked()?.store.account_for(identity_id, provider)?;
                resolved.account = Some(match existing {
                    Some(account) => account.id,
                    None => {
                        outcome.accounts_created += 1;
                        self.unlocked()?
                            .store
                            .create_account(identity_id, provider, None, provider.label())?
                            .id
                    }
                });
            }
        }

        // --- organization
        resolved.organization = match pipeline::answer_for(&submission.answers, Q_ORGANIZATION) {
            Some(AnswerChoice::Existing { entity }) => Some(entity.id),
            Some(AnswerChoice::NewNamed { name }) => match resolved.account {
                Some(account_id) => Some(self.organization_named(account_id, name, outcome)?),
                None => None,
            },
            // No answer, or an explicit "I don't know": only an organization
            // that already exists is used. A weakly-guessed name is never
            // created on the user's behalf.
            Some(AnswerChoice::Unknown) | None => {
                chain.organization.as_ref().and_then(|n| n.existing_id)
            }
        };

        // --- service project
        if let Some(node) = &chain.service_project {
            resolved.service_project = Some(match node.existing_id {
                Some(id) => {
                    // A resource whose organization was unknown and is now known
                    // gets filled in, but a known one is never overwritten.
                    if let Some(org_id) = resolved.organization {
                        let sp = self.unlocked()?.store.service_project(id)?;
                        if sp.is_some_and(|s| s.organization_id.is_none()) {
                            self.unlocked()?
                                .store
                                .set_service_project_organization(id, Some(org_id))?;
                        }
                    }
                    id
                }
                None => match resolved.account {
                    Some(account_id) => {
                        outcome.service_projects_created += 1;
                        if resolved.organization.is_none() {
                            outcome.left_unassigned += 1;
                        }
                        self.unlocked()?
                            .store
                            .create_service_project(
                                account_id,
                                resolved.organization,
                                provider,
                                Some(&node.label),
                                &node.label,
                                None,
                                Environment::Unknown,
                            )?
                            .id
                    }
                    None => return Ok(resolved),
                },
            });
        }

        // --- DevLedger project
        resolved.project = match pipeline::answer_for(&submission.answers, Q_PROJECT) {
            Some(AnswerChoice::Existing { entity }) => Some(entity.id),
            Some(AnswerChoice::NewNamed { name }) => Some(self.project_named(name, outcome)?),
            Some(AnswerChoice::Unknown) => None,
            None => match submission.target_project_id {
                Some(id) => Some(id),
                None => match &chain.project {
                    Some(node) => match node.existing_id {
                        Some(id) => Some(id),
                        // Same rule as organizations: a weak guess is not acted
                        // on without confirmation.
                        // A guess the user never confirmed is not acted on.
                        None if node.evidence.level.is_at_least(EvidenceLevel::Heuristic) => {
                            Some(self.project_named(&node.label, outcome)?)
                        }
                        None => None,
                    },
                    None => None,
                },
            },
        };

        // --- record the chain itself
        //
        // These four relations are consequences of what the user confirmed, not
        // optional suggestions, so they are written whatever the relation
        // checkboxes said. `create_relation` ignores duplicates, so a proposal
        // the user also ticked is a no-op rather than a second row.
        let confirmed = Evidence::new(
            EvidenceLevel::Strong,
            "chain.confirmed",
            "Confirmed in the review sheet",
        );
        let store_links: [(Option<EntityRef>, Option<EntityRef>, RelationKind); 4] = [
            (
                resolved
                    .identity
                    .map(|id| EntityRef::new(EntityKind::Identity, id)),
                resolved
                    .account
                    .map(|id| EntityRef::new(EntityKind::Account, id)),
                RelationKind::Owns,
            ),
            (
                resolved
                    .account
                    .map(|id| EntityRef::new(EntityKind::Account, id)),
                resolved
                    .organization
                    .map(|id| EntityRef::new(EntityKind::Organization, id)),
                RelationKind::MemberOf,
            ),
            (
                resolved
                    .organization
                    .map(|id| EntityRef::new(EntityKind::Organization, id)),
                resolved
                    .service_project
                    .map(|id| EntityRef::new(EntityKind::ServiceProject, id)),
                RelationKind::Contains,
            ),
            (
                resolved
                    .service_project
                    .map(|id| EntityRef::new(EntityKind::ServiceProject, id)),
                resolved
                    .project
                    .map(|id| EntityRef::new(EntityKind::Project, id)),
                RelationKind::UsedBy,
            ),
        ];
        for (from, to, kind) in store_links {
            let (Some(from), Some(to)) = (from, to) else {
                continue;
            };
            self.unlocked()?
                .store
                .create_relation(from, to, kind, &confirmed)?;
        }

        Ok(resolved)
    }

    fn identity_for_email(&self, email: &str, outcome: &mut CommitOutcome) -> Result<Uuid> {
        let inner = self.unlocked()?;
        let lowered = email.trim().to_ascii_lowercase();
        let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, &lowered)?;
        if let Some(id) = inner.store.identity_id_by_email_index(&bi)? {
            return Ok(id);
        }
        outcome.identities_created += 1;
        Ok(inner
            .store
            .create_identity(&lowered, Some(&lowered), Some(&bi))?
            .id)
    }

    /// An identity for an account whose owner is not known.
    ///
    /// Deliberately has no email, which puts it on the Needs attention list
    /// rather than pretending DevLedger knows who this is.
    fn unidentified_identity(&self, outcome: &mut CommitOutcome) -> Result<Uuid> {
        const LABEL: &str = "Unidentified";
        let inner = self.unlocked()?;
        if let Some(existing) = inner
            .store
            .list_identities()?
            .into_iter()
            .find(|i| i.email.is_none() && i.label == LABEL)
        {
            return Ok(existing.id);
        }
        outcome.identities_created += 1;
        Ok(inner.store.create_identity(LABEL, None, None)?.id)
    }

    fn organization_named(
        &self,
        account_id: Uuid,
        name: &str,
        outcome: &mut CommitOutcome,
    ) -> Result<Uuid> {
        let inner = self.unlocked()?;
        if let Some(existing) = inner.store.organization_by_name(account_id, name)? {
            return Ok(existing.id);
        }
        outcome.organizations_created += 1;
        Ok(inner.store.create_organization(account_id, None, name)?.id)
    }

    fn project_named(&self, name: &str, outcome: &mut CommitOutcome) -> Result<Uuid> {
        let inner = self.unlocked()?;
        if let Some(existing) = inner.store.project_by_name(name)? {
            return Ok(existing.id);
        }
        outcome.projects_created += 1;
        Ok(inner.store.create_project(name, None)?.id)
    }

    fn attach_provenance(&self, entity: EntityRef, provenance: &Provenance) -> Result<()> {
        self.unlocked()?.store.record_provenance(entity, provenance)
    }

    // ---------------------------------------------------------------- secrets

    #[allow(clippy::too_many_arguments)]
    fn insert_secret(
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
    /// ever holding the values in JavaScript. Includes every secret the project
    /// can reach, across all the provider resources it uses.
    pub fn export_env(&self, project_id: Uuid) -> Result<SecretString> {
        let inner = self.unlocked()?;
        let entries = inner.store.list_secrets_for_project(project_id)?;
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

    // ------------------------------------------------------- manual entry

    /// The shared "Unidentified" identity, created on demand.
    ///
    /// Used when the user records something by hand without naming an email, so
    /// the entry still hangs off a real identity rather than floating free.
    fn unidentified_identity_id(&self) -> Result<Uuid> {
        const LABEL: &str = "Unidentified";
        let inner = self.unlocked()?;
        if let Some(existing) = inner
            .store
            .list_identities()?
            .into_iter()
            .find(|i| i.email.is_none() && i.label == LABEL)
        {
            return Ok(existing.id);
        }
        Ok(inner.store.create_identity(LABEL, None, None)?.id)
    }

    /// Resolve an identity from an optional email, creating it if needed.
    fn identity_for_optional_email(&self, email: Option<&str>) -> Result<Uuid> {
        match email.map(str::trim).filter(|e| !e.is_empty()) {
            Some(email) => self.identity_id_for_email(email),
            None => self.unidentified_identity_id(),
        }
    }

    /// Create (or reuse) a provider account for an identity resolved by email.
    ///
    /// This is the manual counterpart to Connect: it records that an account
    /// exists without contacting the provider or storing a credential. An
    /// account already held by the identity for this provider is returned as-is.
    pub fn create_account_manual(
        &self,
        email: Option<&str>,
        provider: Provider,
        label: &str,
        note: Option<&str>,
    ) -> Result<Account> {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        let identity_id = self.identity_for_optional_email(email)?;
        self.add_account(identity_id, provider, trimmed, note)
    }

    /// Create (or reuse) a provider account under a known identity.
    pub fn add_account(
        &self,
        identity_id: Uuid,
        provider: Provider,
        label: &str,
        note: Option<&str>,
    ) -> Result<Account> {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        let inner = self.unlocked()?;
        if let Some(existing) = inner.store.account_for(identity_id, provider)? {
            return Ok(existing);
        }
        let note = note.map(str::trim).filter(|n| !n.is_empty());
        inner
            .store
            .create_account(identity_id, provider, note, trimmed)
    }

    /// Record a provider resource by hand, under an account.
    pub fn create_service_project_manual(
        &self,
        account_id: Uuid,
        organization_id: Option<Uuid>,
        provider: Provider,
        name: &str,
        reference: Option<&str>,
    ) -> Result<ServiceProject> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("a resource needs a name".into()));
        }
        let reference = reference.map(str::trim).filter(|r| !r.is_empty());
        self.unlocked()?.store.create_service_project(
            account_id,
            organization_id,
            provider,
            reference,
            trimmed,
            None,
            Environment::Unknown,
        )
    }

    /// Record a subscription by hand, without a paste.
    ///
    /// The subscription hangs off an account for the resolved identity. When no
    /// provider is given it is filed under a generic account, which is enough to
    /// track "what am I paying for" without pretending to know the provider.
    #[allow(clippy::too_many_arguments)]
    pub fn create_subscription_manual(
        &self,
        email: Option<&str>,
        provider: Provider,
        plan: &str,
        status: SubscriptionStatus,
        amount_cents: Option<i64>,
        currency: Option<&str>,
        interval: Option<BillingInterval>,
        renews_at: Option<&str>,
    ) -> Result<Subscription> {
        let plan = plan.trim();
        if plan.is_empty() {
            return Err(CoreError::Invalid(
                "a subscription needs a plan name".into(),
            ));
        }
        let identity_id = self.identity_for_optional_email(email)?;
        let label = email
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| provider.label());
        let account = self.add_account(identity_id, provider, label, None)?;
        let parsed = ParsedSubscription {
            plan: plan.to_string(),
            status,
            amount_cents,
            currency: currency
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            interval,
            trial_ends_at: renews_at
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string),
        };
        self.unlocked()?
            .store
            .create_subscription(account.id, &parsed)
    }

    /// Move an account under a different identity.
    pub fn move_account(&self, account_id: Uuid, identity_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .set_account_identity(account_id, identity_id)
    }

    /// Move an organization under a different account.
    pub fn move_organization(&self, organization_id: Uuid, account_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .set_organization_account(organization_id, account_id)
    }

    /// Move a resource under a different account, clearing its organization.
    pub fn move_service_project(
        &self,
        service_project_id: Uuid,
        account_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        self.unlocked()?.store.set_service_project_account(
            service_project_id,
            account_id,
            organization_id,
        )
    }

    /// Delete an account and everything under it.
    pub fn delete_account(&self, account_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_account(account_id)
    }

    /// Delete an organization. Its resources survive, unassigned.
    pub fn delete_organization(&self, organization_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_organization(organization_id)
    }

    /// Delete a provider resource and its secrets.
    pub fn delete_service_project(&self, service_project_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .delete_service_project(service_project_id)
    }

    /// Delete a subscription.
    pub fn delete_subscription(&self, subscription_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_subscription(subscription_id)
    }

    /// Every relation touching an entity.
    pub fn relations_for(&self, entity: EntityRef) -> Result<Vec<Relation>> {
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
}

/// Turn a proposed endpoint into a concrete [`EntityRef`].
///
/// Returns `None` when the endpoint names something that was never written,
/// which happens whenever the user skipped that row or left a rung unknown.
fn resolve_endpoint(
    endpoint: &ProposedEndpoint,
    chain: &ResolvedChain,
    secret_ids: &HashMap<usize, Uuid>,
) -> Option<EntityRef> {
    match endpoint {
        ProposedEndpoint::Existing { entity, .. } => Some(entity.clone()),
        ProposedEndpoint::Chain { role, .. } => match role {
            ChainRole::Identity => chain
                .identity
                .map(|id| EntityRef::new(EntityKind::Identity, id)),
            ChainRole::Account => chain
                .account
                .map(|id| EntityRef::new(EntityKind::Account, id)),
            ChainRole::Organization => chain
                .organization
                .map(|id| EntityRef::new(EntityKind::Organization, id)),
            ChainRole::ServiceProject => chain
                .service_project
                .map(|id| EntityRef::new(EntityKind::ServiceProject, id)),
            ChainRole::Project => chain
                .project
                .map(|id| EntityRef::new(EntityKind::Project, id)),
        },
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
    fn service_project_by_ref(
        &self,
        provider: Provider,
        provider_ref: &str,
    ) -> Result<Option<ServiceProject>> {
        self.store.service_project_by_ref(provider, provider_ref)
    }
    fn project_by_name(&self, name: &str) -> Result<Option<Project>> {
        self.store.project_by_name(name)
    }
    fn organization_by_name(&self, name: &str) -> Result<Option<Organization>> {
        self.store.organization_by_name_anywhere(name)
    }
    fn identity_by_email_index(&self, index: &str) -> Result<Option<Uuid>> {
        self.store.identity_id_by_email_index(index)
    }
    fn all_projects(&self) -> Result<Vec<(Uuid, String)>> {
        Ok(self
            .store
            .list_projects()?
            .into_iter()
            .map(|s| (s.project.id, s.project.name))
            .collect())
    }
    fn all_organizations(&self) -> Result<Vec<(Uuid, String)>> {
        let mut out = Vec::new();
        for identity in self.store.list_identities()? {
            for account in self.store.accounts_for_identity(identity.id)? {
                for org in self.store.organizations_for_account(account.id)? {
                    out.push((org.id, org.name));
                }
            }
        }
        Ok(out)
    }
    fn all_identities(&self) -> Result<Vec<(Uuid, String)>> {
        Ok(self
            .store
            .list_identities()?
            .into_iter()
            .filter_map(|i| i.email.map(|e| (i.id, e)))
            .collect())
    }
    fn service_project_name(&self, id: Uuid) -> Result<Option<String>> {
        Ok(self.store.service_project(id)?.map(|sp| sp.name))
    }
}

/// Default vault directory for a given application data root.
pub fn default_vault_dir(app_data: &Path) -> PathBuf {
    app_data.join("vault")
}
