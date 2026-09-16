//! The Smart Paste pipeline: text in, review sheet out.
//!
//! The pipeline is deterministic given (text, vault contents, `now`). It runs
//! detection, looks each detection up against what is already stored, infers as
//! much of the
//!
//! ```text
//! identity -> account -> organization -> service project -> project
//! ```
//!
//! chain as the evidence supports, and raises an [`OpenQuestion`] for every rung
//! it cannot settle. It writes nothing: the result is staged in memory and only
//! a [`ReviewSubmission`] can turn it into rows.
//!
//! The design rule throughout: **infer when there is evidence, ask when there
//! is not, and never invent a name to fill a gap.** An organization DevLedger
//! was not told about stays unassigned and shows up under Needs attention.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::crypto::blind_index::{self, DOMAIN_IDENTITY_EMAIL, DOMAIN_SECRET_VALUE};
use crate::error::Result;
use crate::model::{
    EntityKind, EntityRef, Evidence, EvidenceLevel, Organization, Project, Provider, RelationKind,
    SecretRecord, ServiceProject,
};
use crate::redact::{self, Provenance, SecretSpan, SourceKind};
use crate::secret::SecretBytes;

use super::detect::{self, DetectedEntity, DetectedKind, Detection};
use super::jwt;
use super::review::{
    AnswerChoice, ChainNode, ChainRole, ExistingMatch, MatchType, OpenQuestion, ProposedChain,
    ProposedEndpoint, ProposedRelation, QuestionCandidate, QuestionKind, RecommendedAction,
};
use super::subscription::{self, ParsedSubscription};
use super::warn::{Severity, Warning, WarningCode};

/// What the pipeline needs to know about the current vault contents.
///
/// Keeping this a trait means the analysis logic is testable without a
/// database, and it keeps the pipeline honest about how little it reads.
pub trait MatchLookup {
    /// Find a stored secret whose value blind index matches.
    fn secret_by_blind_index(&self, index: &str) -> Result<Option<SecretRecord>>;
    /// Find a stored secret by name, anywhere in the vault.
    fn secret_by_name(&self, name: &str) -> Result<Option<SecretRecord>>;
    /// Find a provider resource by its provider-side reference.
    fn service_project_by_ref(
        &self,
        provider: Provider,
        provider_ref: &str,
    ) -> Result<Option<ServiceProject>>;
    /// Find a DevLedger project by name.
    fn project_by_name(&self, name: &str) -> Result<Option<Project>>;
    /// Find an organization by name, anywhere in the vault.
    fn organization_by_name(&self, name: &str) -> Result<Option<Organization>>;
    /// Find an identity by the blind index of its email.
    fn identity_by_email_index(&self, index: &str) -> Result<Option<Uuid>>;
    /// Every DevLedger project, as (id, name), for question candidates.
    fn all_projects(&self) -> Result<Vec<(Uuid, String)>>;
    /// Every organization, as (id, name), for question candidates.
    fn all_organizations(&self) -> Result<Vec<(Uuid, String)>>;
    /// Every identity that has an email, as (id, email).
    fn all_identities(&self) -> Result<Vec<(Uuid, String)>>;
    /// Display name of a resource, for review-sheet labels.
    fn service_project_name(&self, id: Uuid) -> Result<Option<String>>;
}

/// A [`MatchLookup`] that knows nothing, for analysing against an empty vault.
pub struct EmptyLookup;

impl MatchLookup for EmptyLookup {
    fn secret_by_blind_index(&self, _index: &str) -> Result<Option<SecretRecord>> {
        Ok(None)
    }
    fn secret_by_name(&self, _name: &str) -> Result<Option<SecretRecord>> {
        Ok(None)
    }
    fn service_project_by_ref(
        &self,
        _provider: Provider,
        _provider_ref: &str,
    ) -> Result<Option<ServiceProject>> {
        Ok(None)
    }
    fn project_by_name(&self, _name: &str) -> Result<Option<Project>> {
        Ok(None)
    }
    fn organization_by_name(&self, _name: &str) -> Result<Option<Organization>> {
        Ok(None)
    }
    fn identity_by_email_index(&self, _index: &str) -> Result<Option<Uuid>> {
        Ok(None)
    }
    fn all_projects(&self) -> Result<Vec<(Uuid, String)>> {
        Ok(Vec::new())
    }
    fn all_organizations(&self) -> Result<Vec<(Uuid, String)>> {
        Ok(Vec::new())
    }
    fn all_identities(&self) -> Result<Vec<(Uuid, String)>> {
        Ok(Vec::new())
    }
    fn service_project_name(&self, _id: Uuid) -> Result<Option<String>> {
        Ok(None)
    }
}

/// The review sheet, minus every secret value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PasteAnalysis {
    /// Identifies the staged plaintext held in Rust.
    pub analysis_id: Uuid,
    /// Everything detected, in source order.
    pub entities: Vec<DetectedEntity>,
    /// Per-entity recommendation, parallel to `entities`.
    pub recommendations: Vec<RecommendedAction>,
    /// Links to records that already exist.
    pub matches: Vec<ExistingMatch>,
    /// The Identity -> ... -> Project chain this paste implies.
    pub chain: ProposedChain,
    /// Decisions DevLedger will not take on the user's behalf.
    pub questions: Vec<OpenQuestion>,
    /// Relations Smart Paste suggests recording.
    pub proposed_relations: Vec<ProposedRelation>,
    /// Findings to show above the entity list.
    pub warnings: Vec<Warning>,
    /// Billing information, when the paste contained any.
    pub subscription: Option<ParsedSubscription>,
    /// Redacted record of where this came from.
    pub provenance: Provenance,
    /// Whether a critical warning blocks the default Save action.
    pub blocks_save: bool,
    /// Which provider this paste is about, when one is clear.
    pub provider: Provider,
}

/// The plaintext the analysis deliberately withheld from [`PasteAnalysis`].
pub struct StagedSecrets {
    /// Parallel to `PasteAnalysis::entities`; `None` for non-secret entities.
    pub values: Vec<Option<crate::secret::SecretString>>,
    /// The spans used for redaction, retained for the audit record.
    pub spans: Vec<SecretSpan>,
}

/// Question id for "which DevLedger project is this for?".
pub const Q_PROJECT: &str = "project";
/// Question id for "which organization owns this resource?".
pub const Q_ORGANIZATION: &str = "organization";
/// Question id for "which email holds this account?".
pub const Q_IDENTITY: &str = "identity";

/// Run the full pipeline.
///
/// `now_unix` is injected rather than read from the clock so the JWT-expiry
/// check stays deterministic under test.
pub fn analyze(
    text: &str,
    source: SourceKind,
    index_key: &SecretBytes,
    lookup: &dyn MatchLookup,
    now_unix: i64,
) -> Result<(PasteAnalysis, StagedSecrets)> {
    let detections = detect::detect_all(text);

    let spans: Vec<SecretSpan> = detections
        .iter()
        .filter_map(|d| {
            d.entity.secret_kind.map(|kind| SecretSpan {
                start: d.span.0,
                end: d.span.1,
                kind,
            })
        })
        .collect();

    let provenance = redact::provenance(text, &spans, source);
    let entities: Vec<DetectedEntity> = detections.iter().map(|d| d.entity.clone()).collect();

    let mut matches = Vec::new();
    let mut warnings = Vec::new();
    let mut recommendations = Vec::with_capacity(entities.len());

    let provider = dominant_provider(&detections);
    let chain = build_chain(&detections, provider, index_key, lookup)?;

    for (i, det) in detections.iter().enumerate() {
        recommendations.push(recommend(
            i,
            det,
            index_key,
            lookup,
            &mut matches,
            &mut warnings,
        )?);
    }

    collect_chain_matches(&chain, &mut matches);

    warn_client_exposure(&detections, &mut warnings);
    warn_project_ref_mismatch(&detections, &mut warnings);
    warn_expired_credentials(&detections, now_unix, &mut warnings);
    warn_unattributed_secrets(&detections, &chain, &mut warnings);
    if entities.is_empty() {
        warnings.push(Warning::new(
            WarningCode::NothingDetected,
            Severity::Info,
            "Nothing recognised",
            "DevLedger found no credentials, URLs, names or identities in this text.",
            vec![],
        ));
    }

    let questions = build_questions(&detections, &chain, provider, lookup)?;
    let proposed_relations = propose_relations(&detections, &chain, provider);

    warnings.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.title.cmp(&b.title)));
    let blocks_save = warnings.iter().any(Warning::blocks_save);

    let staged = StagedSecrets {
        values: detections.iter().map(|d| d.secret_value.clone()).collect(),
        spans,
    };

    let analysis = PasteAnalysis {
        analysis_id: Uuid::new_v4(),
        entities,
        recommendations,
        matches,
        chain,
        questions,
        proposed_relations,
        warnings,
        subscription: subscription::parse(text),
        provenance,
        blocks_save,
        provider,
    };
    Ok((analysis, staged))
}

/// Which provider the paste is mostly about.
///
/// An explicit mention ("Supabase" on its own line) outranks whatever the
/// credentials imply, because the user wrote it deliberately.
fn dominant_provider(detections: &[Detection]) -> Provider {
    if let Some(mentioned) = detections
        .iter()
        .find(|d| d.entity.kind == DetectedKind::ServiceMention)
    {
        return mentioned.entity.provider;
    }
    let mut best = Provider::Unknown;
    let mut best_count = 0usize;
    for candidate in detections.iter().map(|d| d.entity.provider) {
        if candidate == Provider::Unknown {
            continue;
        }
        let count = detections
            .iter()
            .filter(|d| d.entity.provider == candidate)
            .count();
        if count > best_count {
            best = candidate;
            best_count = count;
        }
    }
    best
}

/// The single provider-side reference the paste agrees on, if there is one.
fn single_project_ref(detections: &[Detection]) -> Option<String> {
    let mut found: Option<String> = None;
    for det in detections {
        let Some(r) = det.entity.project_ref.as_ref() else {
            continue;
        };
        match &found {
            None => found = Some(r.clone()),
            Some(existing) if existing == r => {}
            Some(_) => return None,
        }
    }
    found
}

/// Bare labels in source order. These are candidate project / organization names.
fn labels(detections: &[Detection]) -> Vec<(usize, String)> {
    detections
        .iter()
        .enumerate()
        .filter(|(_, d)| d.entity.kind == DetectedKind::Label)
        .map(|(i, d)| (i, d.entity.label.clone()))
        .collect()
}

/// Work out as much of the chain as the evidence supports.
fn build_chain(
    detections: &[Detection],
    provider: Provider,
    index_key: &SecretBytes,
    lookup: &dyn MatchLookup,
) -> Result<ProposedChain> {
    let mut chain = ProposedChain::default();

    // --- identity, from an email in the paste
    if let Some((i, det)) = detections
        .iter()
        .enumerate()
        .find(|(_, d)| d.entity.kind == DetectedKind::Email)
    {
        let email = det.entity.value_preview.to_ascii_lowercase();
        let bi = blind_index::blind_index(index_key, DOMAIN_IDENTITY_EMAIL, &email)?;
        let existing = lookup.identity_by_email_index(&bi)?;
        chain.identity = Some(ChainNode {
            role: ChainRole::Identity,
            label: email,
            existing_id: existing,
            evidence: Evidence::new(
                EvidenceLevel::Explicit,
                "identity.email",
                match existing {
                    Some(_) => "This email already identifies someone in your ledger",
                    None => "The paste names this email address",
                },
            ),
            entity_index: Some(i),
        });
    }

    // --- account, implied by identity + provider
    if provider != Provider::Unknown {
        chain.account = Some(ChainNode {
            role: ChainRole::Account,
            label: provider.label().to_string(),
            existing_id: None,
            evidence: Evidence::new(
                EvidenceLevel::Strong,
                "account.provider",
                format!(
                    "A {} account is implied by the credentials in this paste",
                    provider.label()
                ),
            ),
            entity_index: None,
        });
    }

    // --- service project, from a provider-side reference
    if let Some(project_ref) = single_project_ref(detections) {
        let corroborations = detections
            .iter()
            .filter(|d| d.entity.project_ref.as_deref() == Some(project_ref.as_str()))
            .count();
        let existing = lookup.service_project_by_ref(provider, &project_ref)?;
        chain.service_project = Some(ChainNode {
            role: ChainRole::ServiceProject,
            label: project_ref.clone(),
            existing_id: existing.as_ref().map(|sp| sp.id),
            evidence: Evidence::new(
                if corroborations > 1 {
                    EvidenceLevel::Strong
                } else {
                    EvidenceLevel::Explicit
                },
                "service_project.ref",
                if corroborations > 1 {
                    format!("{corroborations} values in this paste name reference {project_ref}")
                } else {
                    format!("The paste names reference {project_ref}")
                },
            ),
            entity_index: None,
        });
    }

    // --- labels: match against what already exists before guessing a role
    let found_labels = labels(detections);
    let mut used: Vec<usize> = Vec::new();

    for (i, label) in &found_labels {
        if let Some(project) = lookup.project_by_name(label)? {
            if chain.project.is_none() {
                chain.project = Some(ChainNode {
                    role: ChainRole::Project,
                    label: project.name.clone(),
                    existing_id: Some(project.id),
                    evidence: Evidence::new(
                        EvidenceLevel::Strong,
                        "project.name_match",
                        format!("{} is already a project in your ledger", project.name),
                    ),
                    entity_index: Some(*i),
                });
                used.push(*i);
            }
        } else if let Some(org) = lookup.organization_by_name(label)? {
            if chain.organization.is_none() {
                chain.organization = Some(ChainNode {
                    role: ChainRole::Organization,
                    label: org.name.clone(),
                    existing_id: Some(org.id),
                    evidence: Evidence::new(
                        EvidenceLevel::Strong,
                        "organization.name_match",
                        format!("{} is already an organization in your ledger", org.name),
                    ),
                    entity_index: Some(*i),
                });
                used.push(*i);
            }
        }
    }

    // Remaining labels, in source order, get a *suggested* role only. The
    // evidence is Weak, which is the signal that the user must confirm it.
    let remaining: Vec<&(usize, String)> = found_labels
        .iter()
        .filter(|(i, _)| !used.contains(i))
        .collect();
    let mut remaining = remaining.into_iter();

    if chain.project.is_none() {
        if let Some((i, label)) = remaining.next() {
            chain.project = Some(ChainNode {
                role: ChainRole::Project,
                label: label.clone(),
                existing_id: None,
                evidence: Evidence::new(
                    EvidenceLevel::Weak,
                    "project.first_label",
                    "The first unrecognised name in the paste. Confirm this is the project.",
                ),
                entity_index: Some(*i),
            });
        }
    }
    if chain.organization.is_none() {
        if let Some((i, label)) = remaining.next() {
            chain.organization = Some(ChainNode {
                role: ChainRole::Organization,
                label: label.clone(),
                existing_id: None,
                evidence: Evidence::new(
                    EvidenceLevel::Weak,
                    "organization.second_label",
                    "The next unrecognised name in the paste. Confirm this is the organization.",
                ),
                entity_index: Some(*i),
            });
        }
    }

    Ok(chain)
}

/// Raise a question for every rung that is missing or only weakly supported.
fn build_questions(
    detections: &[Detection],
    chain: &ProposedChain,
    provider: Provider,
    lookup: &dyn MatchLookup,
) -> Result<Vec<OpenQuestion>> {
    let mut questions = Vec::new();
    let has_secrets = detections.iter().any(|d| d.entity.is_secret());
    let has_service_project = chain.service_project.is_some();

    // Which project? Asked whenever there is something to file and the answer
    // is not already certain.
    // "Certain" means the project was matched against an existing row, not
    // guessed from an unrecognised label.
    let project_certain = chain
        .project
        .as_ref()
        .is_some_and(|n| n.evidence.level.is_at_least(EvidenceLevel::Strong));
    if (has_secrets || has_service_project) && !project_certain {
        let mut candidates = Vec::new();
        if let Some(node) = &chain.project {
            candidates.push(QuestionCandidate {
                existing: node
                    .existing_id
                    .map(|id| EntityRef::new(EntityKind::Project, id)),
                label: node.label.clone(),
                reason: node.evidence.reason.clone(),
                recommended: true,
            });
        }
        for (id, name) in lookup.all_projects()? {
            if chain.project.as_ref().and_then(|n| n.existing_id) == Some(id) {
                continue;
            }
            candidates.push(QuestionCandidate {
                existing: Some(EntityRef::new(EntityKind::Project, id)),
                label: name,
                reason: "An existing project".to_string(),
                recommended: false,
            });
        }
        questions.push(OpenQuestion {
            id: Q_PROJECT.to_string(),
            kind: QuestionKind::WhichProject,
            prompt: "Which project is this for?".to_string(),
            candidates,
            allow_free_text: true,
            required: true,
        });
    }

    // Which organization? Only meaningful once there is a resource to place.
    let org_certain = chain
        .organization
        .as_ref()
        .is_some_and(|n| n.evidence.level.is_at_least(EvidenceLevel::Strong));
    if has_service_project && !org_certain {
        let mut candidates = Vec::new();
        if let Some(node) = &chain.organization {
            candidates.push(QuestionCandidate {
                existing: node
                    .existing_id
                    .map(|id| EntityRef::new(EntityKind::Organization, id)),
                label: node.label.clone(),
                reason: node.evidence.reason.clone(),
                recommended: true,
            });
        }
        for (id, name) in lookup.all_organizations()? {
            if chain.organization.as_ref().and_then(|n| n.existing_id) == Some(id) {
                continue;
            }
            candidates.push(QuestionCandidate {
                existing: Some(EntityRef::new(EntityKind::Organization, id)),
                label: name,
                reason: "An existing organization".to_string(),
                recommended: false,
            });
        }
        questions.push(OpenQuestion {
            id: Q_ORGANIZATION.to_string(),
            kind: QuestionKind::WhichOrganization,
            prompt: format!(
                "Which {} organization owns this?",
                if provider == Provider::Unknown {
                    "".to_string()
                } else {
                    provider.label().to_string()
                }
            )
            .replace("  ", " "),
            candidates,
            // Leaving this unanswered is a legitimate outcome: the resource is
            // stored unassigned and listed under Needs attention.
            allow_free_text: true,
            required: false,
        });
    }

    // Which identity? Only when the paste named no email and there is an
    // account to attach.
    if chain.identity.is_none() && chain.account.is_some() {
        let mut candidates: Vec<QuestionCandidate> = lookup
            .all_identities()?
            .into_iter()
            .map(|(id, email)| QuestionCandidate {
                existing: Some(EntityRef::new(EntityKind::Identity, id)),
                label: email,
                reason: "An identity already in your ledger".to_string(),
                recommended: false,
            })
            .collect();
        if let Some(first) = candidates.first_mut() {
            first.recommended = true;
        }
        questions.push(OpenQuestion {
            id: Q_IDENTITY.to_string(),
            kind: QuestionKind::WhichIdentity,
            prompt: format!("Which email holds this {} account?", provider.label()),
            candidates,
            allow_free_text: true,
            required: false,
        });
    }

    Ok(questions)
}

fn collect_chain_matches(chain: &ProposedChain, matches: &mut Vec<ExistingMatch>) {
    for (node, kind, match_type) in [
        (&chain.identity, EntityKind::Identity, MatchType::SameEmail),
        (
            &chain.service_project,
            EntityKind::ServiceProject,
            MatchType::SameProjectRef,
        ),
        (&chain.project, EntityKind::Project, MatchType::SameName),
        (
            &chain.organization,
            EntityKind::Organization,
            MatchType::SameName,
        ),
    ] {
        let Some(node) = node else { continue };
        let Some(id) = node.existing_id else { continue };
        matches.push(ExistingMatch {
            entity_index: node.entity_index.unwrap_or(0),
            matched: EntityRef::new(kind, id),
            match_type,
            label: node.label.clone(),
            detail: node.evidence.reason.clone(),
        });
    }
}

fn recommend(
    index: usize,
    det: &Detection,
    index_key: &SecretBytes,
    lookup: &dyn MatchLookup,
    matches: &mut Vec<ExistingMatch>,
    warnings: &mut Vec<Warning>,
) -> Result<RecommendedAction> {
    let Some(value) = det.secret_value.as_ref() else {
        return Ok(RecommendedAction::Create);
    };

    let bi = blind_index::blind_index(index_key, DOMAIN_SECRET_VALUE, value.expose())?;

    if let Some(existing) = lookup.secret_by_blind_index(&bi)? {
        let where_it_is = existing
            .service_project_id
            .and_then(|id| lookup.service_project_name(id).ok().flatten())
            .unwrap_or_else(|| "your ledger".to_string());
        matches.push(ExistingMatch {
            entity_index: index,
            matched: EntityRef::new(EntityKind::Secret, existing.id),
            match_type: MatchType::ExactValue,
            label: existing.name.clone(),
            detail: format!("Already stored in {where_it_is}"),
        });
        warnings.push(Warning::new(
            WarningCode::DuplicateSecret,
            Severity::Info,
            "Already stored",
            format!(
                "{} holds this exact value in {where_it_is}. Saving again would change nothing.",
                existing.name
            ),
            vec![index],
        ));
        return Ok(RecommendedAction::Skip {
            reason: format!("Identical value already stored as {}", existing.name),
        });
    }

    if let Some(existing) = lookup.secret_by_name(&det.entity.label)? {
        let where_it_is = existing
            .service_project_id
            .and_then(|id| lookup.service_project_name(id).ok().flatten())
            .unwrap_or_else(|| "your ledger".to_string());
        matches.push(ExistingMatch {
            entity_index: index,
            matched: EntityRef::new(EntityKind::Secret, existing.id),
            match_type: MatchType::SameNameDifferentValue,
            label: existing.name.clone(),
            detail: format!("Different value stored in {where_it_is}"),
        });
        warnings.push(Warning::new(
            WarningCode::SecretRotated,
            Severity::Warning,
            "Value changed",
            format!(
                "{} already exists in {where_it_is} with a different value. Saving will \
                 replace it and record the change.",
                existing.name
            ),
            vec![index],
        ));
        return Ok(RecommendedAction::Update {
            secret_id: existing.id,
        });
    }

    Ok(RecommendedAction::Create)
}

/// A privileged credential bound to a variable that ships to the browser.
fn warn_client_exposure(detections: &[Detection], warnings: &mut Vec<Warning>) {
    for (i, det) in detections.iter().enumerate() {
        let Some(kind) = det.entity.secret_kind else {
            continue;
        };
        if !kind.is_client_unsafe() || !detect::is_client_exposed_name(&det.entity.label) {
            continue;
        }
        warnings.push(Warning::new(
            WarningCode::ServerSecretInClientVariable,
            Severity::Critical,
            format!("{} is exposed to the browser", kind.label()),
            format!(
                "{} is prefixed for client-side bundling, so its value ships to every visitor. \
                 A {} grants privileges that must stay server-side. Rename the variable and \
                 rotate the credential.",
                det.entity.label,
                kind.label()
            ),
            vec![i],
        ));
    }
}

/// Two different provider references in one paste usually means mixed environments.
fn warn_project_ref_mismatch(detections: &[Detection], warnings: &mut Vec<Warning>) {
    let mut refs: Vec<(String, usize)> = Vec::new();
    for (i, det) in detections.iter().enumerate() {
        if let Some(r) = det.entity.project_ref.as_ref() {
            if !refs.iter().any(|(existing, _)| existing == r) {
                refs.push((r.clone(), i));
            }
        }
    }
    if refs.len() > 1 {
        let names: Vec<String> = refs.iter().map(|(r, _)| r.clone()).collect();
        warnings.push(Warning::new(
            WarningCode::ProjectRefMismatch,
            Severity::Warning,
            "Mixed resources in one paste",
            format!(
                "This text references {} different provider projects ({}). DevLedger will not \
                 guess which one the credentials belong to -- paste them separately, or pick \
                 the right one below.",
                refs.len(),
                names.join(", ")
            ),
            refs.iter().map(|(_, i)| *i).collect(),
        ));
    }
}

fn warn_expired_credentials(detections: &[Detection], now_unix: i64, warnings: &mut Vec<Warning>) {
    for (i, det) in detections.iter().enumerate() {
        let Some(value) = det.secret_value.as_ref() else {
            continue;
        };
        if !jwt::looks_like_jwt(value.expose()) {
            continue;
        }
        let Some(claims) = jwt::decode_claims(value.expose()) else {
            continue;
        };
        if claims.is_expired_at(now_unix) {
            warnings.push(Warning::new(
                WarningCode::ExpiredCredential,
                Severity::Warning,
                "Credential has expired",
                format!(
                    "{} is a JWT whose expiry has already passed. Storing it is fine for the \
                     record, but it will not authenticate.",
                    det.entity.label
                ),
                vec![i],
            ));
        }
    }
}

/// Secrets with nothing to attach them to.
fn warn_unattributed_secrets(
    detections: &[Detection],
    chain: &ProposedChain,
    warnings: &mut Vec<Warning>,
) {
    if chain.service_project.is_some() || chain.project.is_some() {
        return;
    }
    let indexes: Vec<usize> = detections
        .iter()
        .enumerate()
        .filter(|(_, d)| d.entity.is_secret())
        .map(|(i, _)| i)
        .collect();
    if indexes.is_empty() {
        return;
    }
    warnings.push(Warning::new(
        WarningCode::UnattributedSecret,
        Severity::Warning,
        "Nothing to file these under",
        "The paste contains credentials but names no project or provider resource. \
         Choose a project below, or add a line naming it and paste again."
            .to_string(),
        indexes,
    ));
}

/// Build the proposed relation graph from the chain.
///
/// These are exactly the relationships a user would draw by hand: who owns the
/// account, which organization it belongs to, what the organization contains,
/// and which project uses it.
fn propose_relations(
    detections: &[Detection],
    chain: &ProposedChain,
    provider: Provider,
) -> Vec<ProposedRelation> {
    let mut proposals: Vec<ProposedRelation> = Vec::new();

    let mut push = |from: ProposedEndpoint, to: ProposedEndpoint, kind, evidence: Evidence| {
        let selected_by_default = evidence.level.auto_selected();
        proposals.push(ProposedRelation {
            index: proposals.len(),
            from,
            to,
            kind,
            evidence,
            selected_by_default,
        });
    };

    let endpoint = |node: &ChainNode| ProposedEndpoint::Chain {
        role: node.role,
        label: node.label.clone(),
    };

    if let (Some(identity), Some(account)) = (&chain.identity, &chain.account) {
        push(
            endpoint(identity),
            endpoint(account),
            RelationKind::Owns,
            Evidence::new(
                EvidenceLevel::Strong,
                "chain.identity_owns_account",
                format!(
                    "{} is the email on this {} account",
                    identity.label,
                    provider.label()
                ),
            ),
        );
    }

    if let (Some(account), Some(org)) = (&chain.account, &chain.organization) {
        push(
            endpoint(account),
            endpoint(org),
            RelationKind::MemberOf,
            org.evidence.clone(),
        );
    }

    if let (Some(org), Some(sp)) = (&chain.organization, &chain.service_project) {
        push(
            endpoint(org),
            endpoint(sp),
            RelationKind::Contains,
            Evidence::new(
                EvidenceLevel::Heuristic,
                "chain.org_contains_resource",
                format!("{} would hold resource {}", org.label, sp.label),
            ),
        );
    }

    if let (Some(sp), Some(project)) = (&chain.service_project, &chain.project) {
        push(
            endpoint(sp),
            endpoint(project),
            RelationKind::UsedBy,
            Evidence::new(
                EvidenceLevel::weaker_of(sp.evidence.level, project.evidence.level),
                "chain.resource_used_by_project",
                format!("{} appears to be used by {}", sp.label, project.label),
            ),
        );
    }

    if let Some(sp) = &chain.service_project {
        for (i, det) in detections.iter().enumerate() {
            if !det.entity.is_secret() {
                continue;
            }
            let vouches = det.entity.project_ref.as_deref() == Some(sp.label.as_str());
            let evidence = if vouches {
                Evidence::new(
                    EvidenceLevel::Explicit,
                    "secret.self_declared_ref",
                    format!("The value itself names reference {}", sp.label),
                )
            } else {
                Evidence::new(
                    EvidenceLevel::Heuristic,
                    "secret.colocated",
                    format!("Pasted alongside credentials for {}", sp.label),
                )
            };
            push(
                ProposedEndpoint::New {
                    kind: EntityKind::Secret,
                    label: det.entity.label.clone(),
                    entity_index: Some(i),
                },
                endpoint(sp),
                RelationKind::AuthenticatesTo,
                evidence,
            );
        }
    }

    proposals
}

/// Resolve an answer for `question_id` out of a submission.
pub fn answer_for<'a>(
    answers: &'a [super::review::QuestionAnswer],
    question_id: &str,
) -> Option<&'a AnswerChoice> {
    answers
        .iter()
        .find(|a| a.question_id == question_id)
        .map(|a| &a.choice)
}
