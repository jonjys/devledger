//! Smart Paste: deterministic extraction of structure from pasted text.

pub mod detect;
pub mod jwt;
pub mod pipeline;
pub mod review;
pub mod subscription;
pub mod warn;

pub use detect::{DetectedEntity, DetectedKind};
pub use pipeline::{
    analyze, answer_for, EmptyLookup, MatchLookup, PasteAnalysis, StagedSecrets, Q_IDENTITY,
    Q_ORGANIZATION, Q_PROJECT,
};
pub use review::{
    AnswerChoice, ChainNode, ChainRole, CommitOutcome, EntityDecision, ExistingMatch, MatchType,
    OpenQuestion, ProposedChain, ProposedEndpoint, ProposedRelation, QuestionAnswer,
    QuestionCandidate, QuestionKind, RecommendedAction, ReviewDecision, ReviewSubmission,
};
pub use subscription::ParsedSubscription;
pub use warn::{Severity, Warning, WarningCode};
