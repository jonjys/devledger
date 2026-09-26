//! Entering things by hand.
//!
//! Smart Paste and the connectors both work by *recognising* something: text a
//! detector understands, or a provider an API can be read from. That leaves out
//! most of what a developer actually has to keep track of — the hosting panel
//! with no API, the registrar, the bank, the account whose password lives in a
//! browser and nowhere else. Those are not edge cases; for many people they are
//! the majority of the ledger.
//!
//! So manual entry is not a fallback here. It is the baseline, and automatic
//! discovery is the optional accelerator on top of it. Everything below can be
//! done with no token, no network and no provider that DevLedger has ever heard
//! of.
//!
//! Two rules shape the API:
//!
//! - **Nothing is invented.** A field the user did not fill in stays empty and
//!   shows up under Needs attention. DevLedger never supplies a plausible
//!   organization name, never guesses which account a resource belongs to, and
//!   never merges two records because their names look alike.
//! - **Nothing existing is overwritten.** Every function here either creates a
//!   new row or edits the one row it was given by id. There is no "upsert by
//!   name" anywhere in this module.

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::model::{Environment, SecretKind};
use crate::store::SecretOwner;

/// The editable fields of an existing provider resource.
///
/// Every field is sent, not just the changed ones, so an edit is a full
/// statement of what the row should now say rather than a merge the backend has
/// to guess at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceEdit {
    /// Display name.
    pub name: String,
    /// Provider-side reference.
    pub provider_ref: Option<String>,
    /// Region.
    pub region: Option<String>,
    /// Which environment this resource represents.
    pub environment: Environment,
    /// Where it lives.
    pub url: Option<String>,
    /// Free-text note.
    pub notes: Option<String>,
}

/// What a manual entry says about a new secret.
///
/// The value is deliberately not part of this struct: it is passed separately
/// as a [`crate::secret::SecretString`] so that a credential never travels
/// inside something that derives `Serialize`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NewSecret {
    /// What it belongs to. At least one field must be set.
    pub owner: SecretOwner,
    /// What sort of credential it is.
    pub kind: SecretKind,
    /// The variable or field name.
    pub name: String,
    /// Which environment it applies to.
    pub environment: Environment,
    /// Free-text note. Never put the value here.
    pub notes: Option<String>,
}

impl NewSecret {
    /// Reject an entry that has no name, or that belongs to nothing or to
    /// more than one thing.
    ///
    /// Exactly one owner, as the rest of the manual API already required: a
    /// secret filed under a project *and* a resource shows up twice in the
    /// ways people look for it, and deleting either owner would then delete it
    /// out from under the other.
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(CoreError::Invalid("a secret needs a name".into()));
        }
        let owners = [
            self.owner.project_id.is_some(),
            self.owner.service_project_id.is_some(),
            self.owner.account_id.is_some(),
        ]
        .into_iter()
        .filter(|set| *set)
        .count();
        match owners {
            0 => Err(CoreError::Invalid(
                "choose what this belongs to: a project, a resource or an account".into(),
            )),
            1 => Ok(()),
            _ => Err(CoreError::Invalid(
                "a secret belongs to exactly one project, resource or account".into(),
            )),
        }
    }
}

/// Trim, and treat an empty string as absent.
///
/// A form submits `""` for a field the user left alone, and storing that as a
/// value rather than as nothing is the difference between "no username" and "a
/// username that is blank".
pub(crate) fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// Normalise an email address for storage and comparison.
pub(crate) fn normalize_email(address: &str) -> Result<String> {
    let lowered = address.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return Err(CoreError::Invalid("enter an email address".into()));
    }
    // Deliberately minimal. DevLedger records what a user tells it; refusing an
    // unusual but real address would be worse than storing one with a typo,
    // which the user can see and correct.
    if !lowered.contains('@') || lowered.starts_with('@') || lowered.ends_with('@') {
        return Err(CoreError::Invalid(
            "that does not look like an email address".into(),
        ));
    }
    Ok(lowered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_field_is_absent_rather_than_empty() {
        assert_eq!(clean(Some("  ")), None);
        assert_eq!(clean(Some(" dev ")), Some("dev".to_string()));
        assert_eq!(clean(None), None);
    }

    #[test]
    fn a_secret_belongs_to_exactly_one_thing() {
        use uuid::Uuid;
        let with = |owner: SecretOwner| NewSecret {
            owner,
            kind: SecretKind::Password,
            name: "Login".into(),
            environment: Environment::Unknown,
            notes: None,
        };
        let id = Some(Uuid::nil());
        assert!(with(SecretOwner::default()).validate().is_err(), "nothing");
        assert!(with(SecretOwner {
            account_id: id,
            ..SecretOwner::default()
        })
        .validate()
        .is_ok());
        assert!(
            with(SecretOwner {
                project_id: id,
                service_project_id: id,
                account_id: None
            })
            .validate()
            .is_err(),
            "two owners"
        );
    }

    #[test]
    fn emails_are_normalised_but_not_second_guessed() {
        assert_eq!(
            normalize_email("  Dev@Example.COM ").unwrap(),
            "dev@example.com"
        );
        assert!(normalize_email("dev+tag@sub.example.co.uk").is_ok());
        assert!(normalize_email("not-an-email").is_err());
        assert!(normalize_email("").is_err());
    }
}
