//! Warnings raised during Smart Paste analysis.
//!
//! These are the findings the review sheet surfaces before anything is saved.
//! The severity ordering matters: the UI blocks the default Save action on a
//! [`Severity::Critical`] finding, so a service_role key cannot be filed into a
//! client-side variable without the user actively overriding it.

use serde::{Deserialize, Serialize};

/// How serious a finding is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Worth knowing, no action implied.
    Info,
    /// Probably a mistake.
    Warning,
    /// Almost certainly a security defect. Blocks the default Save action.
    Critical,
}

/// Machine-readable warning codes, so the UI can special-case presentation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WarningCode {
    /// A privileged credential is bound to a client-exposed variable name.
    ServerSecretInClientVariable,
    /// Two entities in the same paste disagree about the project ref.
    ProjectRefMismatch,
    /// This exact secret value is already stored.
    DuplicateSecret,
    /// The same variable name already exists with a different value.
    SecretRotated,
    /// A JWT in the paste is past its expiry.
    ExpiredCredential,
    /// A credential was recognised but no project could be attributed to it.
    UnattributedSecret,
    /// The paste contained no recognisable entity.
    NothingDetected,
    /// The paste was split on `---` lines, one account section each.
    SplitSections,
}

/// A single finding attached to an analysis.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Warning {
    /// Machine-readable code.
    pub code: WarningCode,
    /// How serious it is.
    pub severity: Severity,
    /// Short headline for the review sheet.
    pub title: String,
    /// Full explanation, including what to do about it.
    pub detail: String,
    /// Indexes of the detected entities this finding refers to.
    pub entity_indexes: Vec<usize>,
}

impl Warning {
    /// Build a warning.
    pub fn new(
        code: WarningCode,
        severity: Severity,
        title: impl Into<String>,
        detail: impl Into<String>,
        entity_indexes: Vec<usize>,
    ) -> Self {
        Warning {
            code,
            severity,
            title: title.into(),
            detail: detail.into(),
            entity_indexes,
        }
    }

    /// Whether this finding should block the default Save action.
    pub fn blocks_save(&self) -> bool {
        self.severity == Severity::Critical
    }
}
