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
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Environment, Provider, SecretKind};
use crate::store::{AccountDetails, SecretOwner};

/// What a manual entry says about a new account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NewAccount {
    /// The identity that holds it.
    pub identity_id: Uuid,
    /// The service, as the user typed it.
    ///
    /// Free text on purpose. "Supabase" resolves to the provider DevLedger
    /// knows; "Loopia" or "my NAS" becomes [`Provider::Other`] and works
    /// exactly the same way everywhere else.
    pub service: String,
    /// What to call this account in the map.
    pub label: String,
    /// The address it signs in with.
    pub login_email: Option<String>,
    /// The username it signs in with.
    pub username: Option<String>,
    /// Where to sign in.
    pub url: Option<String>,
    /// Free-text note.
    pub notes: Option<String>,
}

/// What a manual entry says about a new provider resource.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NewResource {
    /// The account it lives under.
    pub account_id: Uuid,
    /// The organization it belongs to, when the user knows.
    ///
    /// Left as `None` rather than guessed. An unassigned resource is surfaced
    /// under Needs attention, which is honest; a made-up organization is not.
    pub organization_id: Option<Uuid>,
    /// Display name.
    pub name: String,
    /// Provider-side reference, when there is one.
    pub provider_ref: Option<String>,
    /// Region, when it matters.
    pub region: Option<String>,
    /// Which environment this resource represents.
    pub environment: Environment,
    /// Where it lives.
    pub url: Option<String>,
    /// Free-text note.
    pub notes: Option<String>,
}

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

impl NewAccount {
    /// The provider this entry resolves to.
    pub fn provider(&self) -> Provider {
        Provider::from_user_input(&self.service)
    }

    /// The account details, trimmed, with blanks treated as absent.
    pub fn details(&self) -> AccountDetails {
        AccountDetails {
            login_email: clean(self.login_email.as_deref()),
            username: clean(self.username.as_deref()),
            url: clean(self.url.as_deref()),
            notes: clean(self.notes.as_deref()),
        }
    }

    /// Reject an entry that would create a nameless account.
    pub fn validate(&self) -> Result<()> {
        if self.label.trim().is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        if self.service.trim().is_empty() {
            return Err(CoreError::Invalid(
                "name the service this account is with".into(),
            ));
        }
        Ok(())
    }
}

impl NewResource {
    /// Reject an entry that would create a nameless resource.
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(CoreError::Invalid("a resource needs a name".into()));
        }
        Ok(())
    }
}

impl NewSecret {
    /// Reject an entry that has no name or belongs to nothing.
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(CoreError::Invalid("a secret needs a name".into()));
        }
        if self.owner.project_id.is_none()
            && self.owner.service_project_id.is_none()
            && self.owner.account_id.is_none()
        {
            return Err(CoreError::Invalid(
                "choose what this belongs to: a project, a resource or an account".into(),
            ));
        }
        Ok(())
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
    fn an_unknown_service_keeps_the_name_the_user_typed() {
        let entry = NewAccount {
            identity_id: Uuid::nil(),
            service: "Loopia".into(),
            label: "Domains".into(),
            login_email: None,
            username: None,
            url: None,
            notes: None,
        };
        assert_eq!(entry.provider(), Provider::Other("Loopia".into()));
        assert_eq!(entry.provider().label(), "Loopia");
    }

    #[test]
    fn a_known_service_resolves_however_it_is_typed() {
        for spelling in ["Supabase", "supabase", "  SUPABASE  "] {
            assert_eq!(Provider::from_user_input(spelling), Provider::Supabase);
        }
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
