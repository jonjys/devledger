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
    /// An existing resource carries this provider reference.
    SameProjectRef,
    /// An existing row already carries this exact name.
    SameName,
    /// An existing identity carries this email.
    SameEmail,
}

impl MatchType {
    /// Short label for the review sheet.
    pub fn label(&self) -> &'static str {
        match self {
            MatchType::ExactValue => "Already stored",
            MatchType::SameNameDifferentValue => "Rotated value",
            MatchType::SameProjectRef => "Known resource",
            MatchType::SameName => "Known name",
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

/// Where a node sits in the Identity -> Account -> Organization -> Service
/// project -> Project chain.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ChainRole {
    /// The person, keyed by email.
    Identity,
    /// Their account with the provider.
    Account,
    /// The organization or team inside that account.
    Organization,
    /// The provider-side resource, e.g. a Supabase project.
    ServiceProject,
    /// The DevLedger project that uses it.
    Project,
}

impl ChainRole {
    /// Human-readable label for the review sheet.
    pub fn label(&self) -> &'static str {
        match self {
            ChainRole::Identity => "Identity",
            ChainRole::Account => "Account",
            ChainRole::Organization => "Organization",
            ChainRole::ServiceProject => "Service project",
            ChainRole::Project => "Project",
        }
    }
}

/// One rung of the proposed chain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChainNode {
    /// Which rung.
    pub role: ChainRole,
    /// Proposed display name.
    pub label: String,
    /// The existing row this matched, when it matched one.
    pub existing_id: Option<Uuid>,
    /// Why DevLedger believes this.
    pub evidence: Evidence,
    /// The detected entity this came from, when it came from one.
    pub entity_index: Option<usize>,
}

/// The full chain a paste implies.
///
/// Any rung may be `None`, which means the paste did not say. DevLedger does
/// not fill a gap with a placeholder: it raises an [`OpenQuestion`] instead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProposedChain {
    /// The person.
    pub identity: Option<ChainNode>,
    /// Their provider account.
    pub account: Option<ChainNode>,
    /// The organization, when named.
    pub organization: Option<ChainNode>,
    /// The provider resource.
    pub service_project: Option<ChainNode>,
    /// The DevLedger project.
    pub project: Option<ChainNode>,
}

/// What DevLedger needs the user to decide.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    /// Which DevLedger project this belongs to.
    WhichProject,
    /// Which organization owns the resource.
    WhichOrganization,
    /// Which identity holds the account.
    WhichIdentity,
    /// Whether a detected label is a project or an organization.
    LabelRole,
}

/// One option offered in answer to a question.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionCandidate {
    /// An existing row, when this option points at one.
    pub existing: Option<EntityRef>,
    /// The name shown on the option.
    pub label: String,
    /// Why this option is offered.
    pub reason: String,
    /// Whether the sheet pre-selects it.
    pub recommended: bool,
}

/// A decision DevLedger will not make on the user's behalf.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenQuestion {
    /// Stable key, used to match the answer back. e.g. `"organization"`.
    pub id: String,
    /// What sort of decision this is.
    pub kind: QuestionKind,
    /// The question, in plain language.
    pub prompt: String,
    /// Options to choose from.
    pub candidates: Vec<QuestionCandidate>,
    /// Whether a name typed by hand is accepted.
    pub allow_free_text: bool,
    /// Whether leaving it unanswered blocks the save.
    pub required: bool,
}

/// How the user answered an [`OpenQuestion`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "sort", rename_all = "snake_case")]
pub enum AnswerChoice {
    /// Use this existing row.
    Existing {
        /// The chosen row.
        entity: EntityRef,
    },
    /// Create something new with this name.
    NewNamed {
        /// The name to create.
        name: String,
    },
    /// Explicitly leave it unknown. The result is surfaced under Needs
    /// attention rather than filled in with a guess.
    Unknown,
}

/// One answer in a submission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionAnswer {
    /// Which question this answers.
    pub question_id: String,
    /// The user's choice.
    pub choice: AnswerChoice,
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
    /// Points at a rung of the chain, resolved once the chain is committed.
    Chain {
        /// Which rung.
        role: ChainRole,
        /// Its display name at analysis time.
        label: String,
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
    /// Answers to the analysis's open questions.
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
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
    /// Provider accounts created.
    pub accounts_created: usize,
    /// Organizations created, only ever from a name the user supplied or the
    /// paste stated.
    pub organizations_created: usize,
    /// Provider resources recorded.
    pub service_projects_created: usize,
    /// Resources left without an organization, and so surfaced under Needs
    /// attention.
    pub left_unassigned: usize,
    /// Relations recorded.
    pub relations_created: usize,
    /// Ids of the projects touched, so the UI can navigate there.
    pub touched_project_ids: Vec<Uuid>,
    /// Things the user should know about how the save was interpreted.
    ///
    /// Not errors: the save happened. These are the judgement calls DevLedger
    /// had to make and would rather state out loud than bury, such as filing a
    /// paste under one of several accounts the same person holds with the same
    /// provider.
    pub notes: Vec<String>,
}
