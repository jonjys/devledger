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

mod editing;
mod ledger;
mod lifecycle;
mod manual_entry;
mod paste;
mod secrets;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::crypto::blind_index::{self, DOMAIN_IDENTITY_EMAIL, DOMAIN_SECRET_VALUE};
use crate::crypto::kdf::{self, KdfParams};
use crate::crypto::{self, aead, LABEL_BLIND_INDEX, LABEL_SECRET_AEAD};
use crate::error::{CoreError, Result};
use crate::manual;
use crate::model::{
    Account, BillingInterval, CustomField, EntityKind, EntityRef, Environment, Evidence,
    EvidenceLevel, Identity, IdentityEmail, Organization, Project, Provider, Relation,
    RelationKind, SecretKind, SecretRecord, ServiceProject, Subscription, SubscriptionStatus,
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
    AccountDetails, AttentionItem, AuditEntry, IdentityNode, ProjectRefLabel, ProjectSummary,
    SecretOwner, ServiceProjectSummary, Store, SubscriptionSummary, VaultEntry,
};

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|c| matches!(c, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

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

/// One identity with the whole chain that hangs off it.
///
/// This is the answer to "which of my email addresses is this project actually
/// running on", which is the question the rest of the model exists to make
/// answerable: address -> account -> organization -> resource -> project, in
/// one shape the UI can render without five more round trips.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OverviewIdentity {
    /// The person.
    pub identity: Identity,
    /// Every address they hold, primary first.
    pub emails: Vec<IdentityEmail>,
    /// Their accounts, with organizations and resources beneath them.
    pub accounts: Vec<crate::store::AccountNode>,
    /// Every DevLedger project reachable from this identity, by name.
    pub projects: Vec<ProjectRefLabel>,
    /// How many secrets are filed anywhere under this identity.
    pub secret_count: i64,
}

/// One variable name a project defines more than once.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvConflict {
    /// The repeated variable name.
    pub name: String,
    /// Which environments define it, and under which resource.
    pub definitions: Vec<EnvDefinition>,
}

/// Where one definition of a repeated variable comes from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvDefinition {
    /// The secret's id, so the UI can offer to rename or delete it.
    pub secret_id: Uuid,
    /// Which environment it is filed under.
    pub environment: Environment,
    /// The resource it came from, when it has one.
    pub source: Option<String>,
}

/// What deleting something would take with it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeletionImpact {
    /// Secrets that would be destroyed, because they are filed directly against
    /// the thing being deleted.
    pub secrets_deleted: i64,
    /// Resources that would merely be unlinked, and survive.
    pub resources_unlinked: i64,
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

/// The names a `.env` export would refuse: repeated with differing values.
///
/// Mirrors [`Vault::export_env_for_environment`] exactly -- a name repeated with
/// an identical value is fine, a name repeated with a different one is not --
/// but decides it from blind indexes, so asking "would this export work?"
/// never decrypts a value or writes a reveal to the audit log.
fn conflicting_names(entries: &[VaultEntry]) -> Vec<EnvConflict> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<&VaultEntry>> = HashMap::new();
    for entry in entries {
        let name = entry.secret.name.clone();
        if !grouped.contains_key(&name) {
            order.push(name.clone());
        }
        grouped.entry(name).or_default().push(entry);
    }
    order
        .into_iter()
        .filter_map(|name| {
            let group = grouped.remove(&name)?;
            let first = &group[0].secret.value_blind_index;
            let differs = group.iter().any(|e| &e.secret.value_blind_index != first);
            differs.then(|| EnvConflict {
                name,
                definitions: group
                    .iter()
                    .map(|e| EnvDefinition {
                        secret_id: e.secret.id,
                        environment: e.secret.environment,
                        source: e.service_project_name.clone(),
                    })
                    .collect(),
            })
        })
        .collect()
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
        provider: &Provider,
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
