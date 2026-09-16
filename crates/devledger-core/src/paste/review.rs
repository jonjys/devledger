//! The review-sheet data model.
//!
//! Everything in this file is what the user is shown *before* anything is
//! written. DevLedger never persists a Smart Paste result without an explicit
//! decision coming back from the UI, so these types are the full contract
//! between the deterministic analysis and the user's judgement.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{EntityKind, EntityRef, Evidence, RelationKind};

/// How a detected entity lines up with something already in the vault.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    /// Byte-identical value already stored (found via blind index).
    ExactValue,
    /// Same variable name in the same project, different value: a rotation.
    SameNameDifferentValue,
    /// An existing project carries this project ref.
    SameProjectRef,
    /// An existing identity carries this email.
    SameEmail,
}

impl MatchType {
    /// Short label for the review sheet.
    pub fn label(&self) -> &'static str {
        match self {
            MatchType::ExactValue => "Already stored",
            MatchType::SameNameDifferentValue => "Rotated value",
            MatchType::SameProjectRef => "Known project",
            MatchType::SameEmail => "Known identity",
        }
    }
}

/// A link between a detected entity and an existing record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExistingMatch {
    /// Which detected entity this concerns.
    pub entity_index: usize,
    /// The record it matched.
    pub matched: EntityRef,
    /// How it matched.
    pub match_type: MatchType,
    /// Display name of the existing record.
    pub label: String,
    /// Extra context, e.g. which project the existing secret sits in.
    pub detail: String,
}

/// One end of a proposed relation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "sort", rename_all = "snake_case")]
pub enum ProposedEndpoint {
    /// Points at a record that already exists.
    Existing {
        /// The existing record.
        entity: EntityRef,
        /// Its display name.
        label: String,
    },
    /// Points at something this paste would create.
    New {
        /// What kind of record would be created.
        kind: EntityKind,
        /// Proposed display name.
        label: String,
        /// The detected entity that would become it, when there is one.
        entity_index: Option<usize>,
    },
}

/// A relation Smart Paste suggests recording.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedRelation {
    /// Index within the analysis, used as the UI key.
    pub index: usize,
    /// Source endpoint.
    pub from: ProposedEndpoint,
    /// Target endpoint.
    pub to: ProposedEndpoint,
    /// Relation type.
    pub kind: RelationKind,
    /// Why this is being proposed, shown verbatim in the review sheet.
    pub evidence: Evidence,
    /// Whether the checkbox starts ticked. Weak evidence never does.
    pub selected_by_default: bool,
}

/// What DevLedger recommends doing with a detected entity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "sort", rename_all = "snake_case")]
pub enum RecommendedAction {
    /// Store it as a new record.
    Create,
    /// Update the named existing secret with this new value.
    Update {
        /// The secret that would be overwritten.
        secret_id: Uuid,
    },
    /// Do nothing: the identical value is already stored.
    Skip {
        /// Why it is being skipped.
        reason: String,
    },
}

/// The decision the user sends back for a single entity.
///
/// This is the "Save / Change / Create new" triple from the review sheet:
/// `Accept` takes the recommendation, `Change` retargets it at a record the
/// user picked, `CreateNew` forces a new record even when a match exists, and
/// `Skip` drops the entity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "sort", rename_all = "snake_case")]
pub enum EntityDecision {
    /// Take the recommended action as-is.
    Accept,
    /// Write this value over an existing secret the user chose.
    Change {
        /// The secret to overwrite.
        secret_id: Uuid,
    },
    /// Always create a new record.
    CreateNew,
    /// Discard this entity.
    Skip,
}

/// One entry in the submitted review.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewDecision {
    /// Which detected entity.
    pub entity_index: usize,
    /// What to do with it.
    pub decision: EntityDecision,
    /// Optional override of the stored name.
    pub name_override: Option<String>,
}

/// The full payload the UI submits when the user presses Save.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewSubmission {
    /// Which staged analysis this answers.
    pub analysis_id: Uuid,
    /// Per-entity decisions. Entities with no entry here are skipped.
    pub decisions: Vec<ReviewDecision>,
    /// Indexes of the proposed relations the user kept ticked.
    pub accepted_relations: Vec<usize>,
    /// Set when the user knowingly overrides a critical warning.
    pub acknowledge_critical: bool,
    /// Project to file everything under when the analysis could not infer one.
    pub target_project_id: Option<Uuid>,
}

/// What actually happened after a [`ReviewSubmission`] was applied.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CommitOutcome {
    /// Secrets newly written.
    pub secrets_created: usize,
    /// Secrets overwritten with a rotated value.
    pub secrets_updated: usize,
    /// Entities deliberately dropped.
    pub entities_skipped: usize,
    /// Projects created as a side effect.
    pub projects_created: usize,
    /// Identities created as a side effect.
    pub identities_created: usize,
    /// Relations recorded.
    pub relations_created: usize,
    /// Ids of the projects touched, so the UI can navigate there.
    pub touched_project_ids: Vec<Uuid>,
}
