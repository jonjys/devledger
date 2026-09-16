//! The Smart Paste pipeline: text in, review sheet out.
//!
//! The pipeline is deterministic given (text, vault contents, `now`). It runs
//! detection, looks each detection up against what is already stored, infers
//! the Identity -> Account -> Organization -> Project structure the paste
//! implies, and raises warnings. It writes nothing: the result is staged in
//! memory and only a [`ReviewSubmission`] can turn it into rows.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::crypto::blind_index::{self, DOMAIN_IDENTITY_EMAIL, DOMAIN_SECRET_VALUE};
use crate::error::Result;
use crate::model::{
    EntityKind, EntityRef, Evidence, EvidenceLevel, Project, RelationKind, SecretRecord,
};
use crate::redact::{self, Provenance, SecretSpan, SourceKind};
use crate::secret::SecretBytes;

use super::detect::{self, DetectedEntity, DetectedKind, Detection};
use super::jwt;
use super::review::{
    ExistingMatch, MatchType, ProposedEndpoint, ProposedRelation, RecommendedAction,
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
    /// Find a project by its provider project ref.
    fn project_by_ref(&self, project_ref: &str) -> Result<Option<Project>>;
    /// Find an identity by the blind index of its email.
    fn identity_by_email_index(&self, index: &str) -> Result<Option<Uuid>>;
    /// Human-readable name of a project, for review-sheet labels.
    fn project_name(&self, id: Uuid) -> Result<Option<String>>;
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
    fn project_by_ref(&self, _project_ref: &str) -> Result<Option<Project>> {
        Ok(None)
    }
    fn identity_by_email_index(&self, _index: &str) -> Result<Option<Uuid>> {
        Ok(None)
    }
    fn project_name(&self, _id: Uuid) -> Result<Option<String>> {
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
    /// Project ref the paste is about, when exactly one was found.
    pub inferred_project_ref: Option<String>,
}

/// The plaintext the analysis deliberately withheld from [`PasteAnalysis`].
pub struct StagedSecrets {
    /// Parallel to `PasteAnalysis::entities`; `None` for non-secret entities.
    pub values: Vec<Option<crate::secret::SecretString>>,
    /// The spans used for redaction, retained for the audit record.
    pub spans: Vec<SecretSpan>,
}

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

    collect_project_matches(&detections, lookup, &mut matches)?;
    collect_identity_matches(&detections, index_key, lookup, &mut matches)?;

    warn_client_exposure(&detections, &mut warnings);
    warn_project_ref_mismatch(&detections, &mut warnings);
    warn_expired_credentials(&detections, now_unix, &mut warnings);
    if entities.is_empty() {
        warnings.push(Warning::new(
            WarningCode::NothingDetected,
            Severity::Info,
            "Nothing recognised",
            "DevLedger found no credentials, URLs or identities in this text.",
            vec![],
        ));
    }

    let inferred_project_ref = single_project_ref(&detections);
    let proposed_relations =
        propose_relations(&detections, lookup, inferred_project_ref.as_deref())?;

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
        proposed_relations,
        warnings,
        subscription: subscription::parse(text),
        provenance,
        blocks_save,
        inferred_project_ref,
    };
    Ok((analysis, staged))
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

    // Exact duplicate: the identical value is already in the vault.
    if let Some(existing) = lookup.secret_by_blind_index(&bi)? {
        let project = lookup
            .project_name(existing.project_id)?
            .unwrap_or_else(|| "an existing project".to_string());
        matches.push(ExistingMatch {
            entity_index: index,
            matched: EntityRef::new(EntityKind::Secret, existing.id),
            match_type: MatchType::ExactValue,
            label: existing.name.clone(),
            detail: format!("Already stored in {project}"),
        });
        warnings.push(Warning::new(
            WarningCode::DuplicateSecret,
            Severity::Info,
            "Already stored",
            format!(
                "{} holds this exact value in {project}. Saving again would change nothing.",
                existing.name
            ),
            vec![index],
        ));
        return Ok(RecommendedAction::Skip {
            reason: format!("Identical value already stored as {}", existing.name),
        });
    }

    // Same name, different value: a rotation.
    if let Some(existing) = lookup.secret_by_name(&det.entity.label)? {
        let project = lookup
            .project_name(existing.project_id)?
            .unwrap_or_else(|| "an existing project".to_string());
        matches.push(ExistingMatch {
            entity_index: index,
            matched: EntityRef::new(EntityKind::Secret, existing.id),
            match_type: MatchType::SameNameDifferentValue,
            label: existing.name.clone(),
            detail: format!("Different value stored in {project}"),
        });
        warnings.push(Warning::new(
            WarningCode::SecretRotated,
            Severity::Warning,
            "Value changed",
            format!(
                "{} already exists in {project} with a different value. Saving will replace it and record the change.",
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

fn collect_project_matches(
    detections: &[Detection],
    lookup: &dyn MatchLookup,
    matches: &mut Vec<ExistingMatch>,
) -> Result<()> {
    let mut seen: Vec<String> = Vec::new();
    for (i, det) in detections.iter().enumerate() {
        let Some(project_ref) = det.entity.project_ref.as_ref() else {
            continue;
        };
        if seen.contains(project_ref) {
            continue;
        }
        seen.push(project_ref.clone());
        if let Some(project) = lookup.project_by_ref(project_ref)? {
            matches.push(ExistingMatch {
                entity_index: i,
                matched: EntityRef::new(EntityKind::Project, project.id),
                match_type: MatchType::SameProjectRef,
                label: project.name.clone(),
                detail: format!("Project ref {project_ref} is already tracked"),
            });
        }
    }
    Ok(())
}

fn collect_identity_matches(
    detections: &[Detection],
    index_key: &SecretBytes,
    lookup: &dyn MatchLookup,
    matches: &mut Vec<ExistingMatch>,
) -> Result<()> {
    for (i, det) in detections.iter().enumerate() {
        if det.entity.kind != DetectedKind::Email {
            continue;
        }
        let email = det.entity.value_preview.to_ascii_lowercase();
        let bi = blind_index::blind_index(index_key, DOMAIN_IDENTITY_EMAIL, &email)?;
        if let Some(id) = lookup.identity_by_email_index(&bi)? {
            matches.push(ExistingMatch {
                entity_index: i,
                matched: EntityRef::new(EntityKind::Identity, id),
                match_type: MatchType::SameEmail,
                label: det.entity.value_preview.clone(),
                detail: "This identity is already known".to_string(),
            });
        }
    }
    Ok(())
}

/// A privileged credential bound to a variable that ships to the browser.
fn warn_client_exposure(detections: &[Detection], warnings: &mut Vec<Warning>) {
    for (i, det) in detections.iter().enumerate() {
        let Some(kind) = det.entity.secret_kind else {
            continue;
        };
        if !kind.is_client_unsafe() {
            continue;
        }
        if !detect::is_client_exposed_name(&det.entity.label) {
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

/// Two different project refs in one paste usually means mixed environments.
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
            "Mixed projects in one paste",
            format!(
                "This text references {} different Supabase projects ({}). Check you are not \
                 mixing a production key into a development configuration.",
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

/// Build the proposed relation graph.
///
/// Every secret authenticates to the project the paste is about; when the URL
/// and a JWT independently agree on the project ref, that agreement is recorded
/// as [`EvidenceLevel::Strong`] rather than merely heuristic.
fn propose_relations(
    detections: &[Detection],
    lookup: &dyn MatchLookup,
    project_ref: Option<&str>,
) -> Result<Vec<ProposedRelation>> {
    let mut proposals = Vec::new();
    let Some(project_ref) = project_ref else {
        return Ok(proposals);
    };

    // How many independent detections vouch for this ref?
    let corroborations = detections
        .iter()
        .filter(|d| d.entity.project_ref.as_deref() == Some(project_ref))
        .count();

    let project_endpoint = match lookup.project_by_ref(project_ref)? {
        Some(project) => ProposedEndpoint::Existing {
            entity: EntityRef::new(EntityKind::Project, project.id),
            label: project.name,
        },
        None => ProposedEndpoint::New {
            kind: EntityKind::Project,
            label: project_ref.to_string(),
            entity_index: None,
        },
    };

    for (i, det) in detections.iter().enumerate() {
        if det.entity.kind != DetectedKind::Secret {
            continue;
        }
        let vouches = det.entity.project_ref.as_deref() == Some(project_ref);
        let evidence = if vouches && corroborations > 1 {
            Evidence::new(
                EvidenceLevel::Strong,
                "project_ref.corroborated",
                format!(
                    "{} independent values in this paste name project {project_ref}",
                    corroborations
                ),
            )
        } else if vouches {
            Evidence::new(
                EvidenceLevel::Explicit,
                "project_ref.self_declared",
                format!("The value itself names project {project_ref}"),
            )
        } else {
            Evidence::new(
                EvidenceLevel::Heuristic,
                "project_ref.colocated",
                format!("Pasted alongside credentials for project {project_ref}"),
            )
        };
        let selected_by_default = evidence.level.auto_selected();
        proposals.push(ProposedRelation {
            index: proposals.len(),
            from: ProposedEndpoint::New {
                kind: EntityKind::Secret,
                label: det.entity.label.clone(),
                entity_index: Some(i),
            },
            to: project_endpoint.clone(),
            kind: RelationKind::AuthenticatesTo,
            evidence,
            selected_by_default,
        });
    }

    Ok(proposals)
}
