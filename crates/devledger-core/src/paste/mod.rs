//! Smart Paste: deterministic extraction of structure from pasted text.

pub mod detect;
pub mod jwt;
pub mod pipeline;
pub mod review;
pub mod subscription;
pub mod warn;

pub use detect::{DetectedEntity, DetectedKind};
pub use pipeline::{analyze, EmptyLookup, MatchLookup, PasteAnalysis, StagedSecrets};
pub use review::{
    CommitOutcome, EntityDecision, ExistingMatch, MatchType, ProposedEndpoint, ProposedRelation,
    RecommendedAction, ReviewDecision, ReviewSubmission,
};
pub use subscription::ParsedSubscription;
pub use warn::{Severity, Warning, WarningCode};
