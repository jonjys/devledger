//! Typed reads and writes over the encrypted database.

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{
    Account, EntityKind, EntityRef, Environment, Evidence, Identity, IdentityEmail, Organization,
    Project, Provider, Relation, RelationKind, SecretKind, SecretRecord, ServiceProject,
    Subscription,
};
use crate::paste::ParsedSubscription;
use crate::redact::Provenance;

use super::enums::*;
use super::{now_rfc3339, parse_rfc3339, to_rfc3339, Store};

/// A DevLedger project with the counts the project list needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSummary {
    /// The project itself.
    pub project: Project,
    /// How many provider resources are linked to it.
    pub service_project_count: i64,
    /// How many secrets it can reach, directly or through its resources.
    pub secret_count: i64,
    /// Which providers it touches, for at-a-glance context.
    pub providers: Vec<Provider>,
}

/// A provider resource with the context needed to show it in the map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceProjectSummary {
    /// The resource itself.
    pub service_project: ServiceProject,
    /// Label of the owning account.
    pub account_label: String,
    /// Email of the identity behind that account, when known.
    pub identity_email: Option<String>,
    /// Name of the organization, when assigned.
    pub organization_name: Option<String>,
    /// How many secrets authenticate to it.
    pub secret_count: i64,
    /// DevLedger projects that use it.
    pub used_by: Vec<ProjectRefLabel>,
}

/// A minimal (id, name) pair for cross-references in the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRefLabel {
    /// Row id.
    pub id: Uuid,
    /// Display name.
    pub name: String,
}

/// One identity and everything hanging off it, for the map view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityNode {
    /// The identity.
    pub identity: Identity,
    /// Its provider accounts.
    pub accounts: Vec<AccountNode>,
}

/// One provider account and its organizations and unassigned resources.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountNode {
    /// The account.
    pub account: Account,
    /// Organizations known under it.
    pub organizations: Vec<OrganizationNode>,
    /// Resources under this account with no organization assigned.
    pub unassigned: Vec<ServiceProjectSummary>,
    /// Subscriptions billed to it.
    pub subscriptions: Vec<Subscription>,
}

impl AccountNode {
    /// The account's id, without reaching through the struct at every call site.
    pub fn id(&self) -> Uuid {
        self.account.id
    }
}

/// One organization and the resources inside it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrganizationNode {
    /// The organization.
    pub organization: Organization,
    /// Resources assigned to it.
    pub service_projects: Vec<ServiceProjectSummary>,
}

/// A secret as shown in a vault: metadata only, never a value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultEntry {
    /// The secret's metadata.
    pub secret: SecretRecord,
    /// Whether exposing this to client code would be a defect.
    pub client_unsafe: bool,
    /// Provider implied by the secret kind.
    pub provider: Provider,
    /// Name of the resource it authenticates to, when it has one.
    pub service_project_name: Option<String>,
}

/// A subscription with the context needed to display it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionSummary {
    /// The subscription.
    pub subscription: Subscription,
    /// Which provider bills it.
    pub provider: Provider,
    /// Label of the account it bills.
    pub account_label: String,
    /// Email of the identity behind that account, when known.
    pub identity_email: Option<String>,
}

/// What a secret belongs to.
///
/// All three may be set: a service_role key belongs to a Supabase resource, is
/// used by a DevLedger project, and both facts are worth keeping. At least one
/// must be, which the database also enforces.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretOwner {
    /// The DevLedger project it is filed under.
    pub project_id: Option<Uuid>,
    /// The provider resource it authenticates to.
    pub service_project_id: Option<Uuid>,
    /// The account it belongs to, for a login password.
    pub account_id: Option<Uuid>,
}

/// The editable details of an account, as a manual entry supplies them.
///
/// Grouped into a struct rather than five more positional parameters so that
/// adding a field later cannot silently shift an argument at a call site.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountDetails {
    /// The address this account signs in with.
    pub login_email: Option<String>,
    /// The username this account signs in with.
    pub username: Option<String>,
    /// Where to sign in.
    pub url: Option<String>,
    /// Free-text note.
    pub notes: Option<String>,
}

/// Why something is on the Needs attention list.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    /// A resource whose organization is unknown.
    UnassignedOrganization,
    /// A resource not used by any DevLedger project.
    UnlinkedServiceProject,
    /// An identity with no email, so it cannot be matched against a paste.
    IdentityWithoutEmail,
    /// A secret filed against nothing in particular.
    OrphanSecret,
    /// A secret whose sealed value is gone, so it can never be revealed.
    ///
    /// The only known cause is a vault upgraded from DevLedger 0.3.0 by a build
    /// released before the migration runner stopped enforcing foreign keys
    /// while it worked: the upgrade cascade-deleted every envelope and left the
    /// metadata behind. Nothing can recover the value, so the point of
    /// surfacing it is to say so plainly rather than let the row look usable.
    SecretValueMissing,
    /// An identity holding more than one account with the same provider.
    ///
    /// Perfectly legitimate -- two Supabase accounts under one person -- but it
    /// makes an incoming paste ambiguous, so DevLedger says which account it
    /// chose rather than filing things silently.
    AmbiguousProviderAccount,
}

/// One item DevLedger cannot resolve on its own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttentionItem {
    /// What sort of gap this is.
    pub kind: AttentionKind,
    /// Short headline.
    pub title: String,
    /// What the user can do about it.
    pub detail: String,
    /// The entity concerned, so the UI can navigate to it.
    pub entity: EntityRef,
}

/// One line of the append-only audit log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditEntry {
    /// Monotonic sequence number.
    pub seq: i64,
    /// When it happened, RFC 3339.
    pub at: String,
    /// What happened.
    pub action: String,
    /// Which kind of entity, when applicable.
    pub entity_kind: Option<String>,
    /// Which entity, when applicable.
    pub entity_id: Option<String>,
    /// Human-readable detail. Never contains a secret value.
    pub detail: String,
}

fn uuid_from(row: &Row<'_>, idx: usize) -> rusqlite::Result<Uuid> {
    let raw: String = row.get(idx)?;
    Uuid::parse_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn opt_uuid_from(row: &Row<'_>, idx: usize) -> rusqlite::Result<Option<Uuid>> {
    let raw: Option<String> = row.get(idx)?;
    match raw {
        None => Ok(None),
        Some(text) => Uuid::parse_str(&text).map(Some).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
        }),
    }
}

fn parse_uuid(raw: &str, what: &str) -> Result<Uuid> {
    Uuid::parse_str(raw).map_err(|e| CoreError::Storage(format!("corrupt {what} id: {e}")))
}

impl Store {
    // ---------------------------------------------------------------- identity

    /// Insert an identity.
    pub fn create_identity(
        &self,
        label: &str,
        email: Option<&str>,
        email_blind_index: Option<&str>,
    ) -> Result<Identity> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO identities (id, label, email, email_blind_index, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id.to_string(), label, email, email_blind_index, created_at],
        )?;
        // Every path that creates an identity with an address -- Smart Paste,
        // Connect, manual entry -- comes through here, so this is where the
        // address table is kept complete. Without it an identity created by a
        // paste would have a primary address the alias lookups cannot see.
        if let (Some(address), Some(index)) = (email, email_blind_index) {
            self.conn().execute(
                "INSERT INTO identity_emails
                    (id, identity_id, address, blind_index, is_primary, created_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)
                 ON CONFLICT (blind_index) DO NOTHING",
                params![
                    Uuid::new_v4().to_string(),
                    id.to_string(),
                    address,
                    index,
                    created_at
                ],
            )?;
        }
        self.audit(
            "identity.create",
            Some("identity"),
            Some(id),
            &format!("Created identity {label}"),
        )?;
        Ok(Identity {
            id,
            label: label.to_string(),
            email: email.map(str::to_string),
            email_blind_index: email_blind_index.map(str::to_string),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Look up an identity id by the blind index of its email.
    ///
    /// Matches *any* address the identity holds, not only its primary one. That
    /// is what makes a second address useful: a paste or a connection signed in
    /// with an alias lands on the same person instead of creating a duplicate.
    pub fn identity_id_by_email_index(&self, index: &str) -> Result<Option<Uuid>> {
        let found: Option<String> = self
            .conn()
            .query_row(
                "SELECT identity_id FROM identity_emails WHERE blind_index = ?1
                 UNION ALL
                 SELECT id FROM identities WHERE email_blind_index = ?1
                 LIMIT 1",
                params![index],
                |r| r.get(0),
            )
            .optional()?;
        match found {
            Some(raw) => Ok(Some(parse_uuid(&raw, "identity")?)),
            None => Ok(None),
        }
    }

    fn identity_from_row(row: &Row<'_>) -> rusqlite::Result<(Identity, String)> {
        let created: String = row.get(4)?;
        Ok((
            Identity {
                id: uuid_from(row, 0)?,
                label: row.get(1)?,
                email: row.get(2)?,
                email_blind_index: row.get(3)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created,
        ))
    }

    /// List every identity, oldest first.
    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, label, email, email_blind_index, created_at
             FROM identities ORDER BY created_at, id",
        )?;
        let raw = stmt
            .query_map([], Self::identity_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (mut identity, created) in raw {
            identity.created_at = parse_rfc3339(&created)?;
            out.push(identity);
        }
        Ok(out)
    }

    /// Fetch one identity.
    pub fn identity(&self, id: Uuid) -> Result<Option<Identity>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, label, email, email_blind_index, created_at
                 FROM identities WHERE id = ?1",
                params![id.to_string()],
                Self::identity_from_row,
            )
            .optional()?;
        match row {
            Some((mut identity, created)) => {
                identity.created_at = parse_rfc3339(&created)?;
                Ok(Some(identity))
            }
            None => Ok(None),
        }
    }

    /// Rename an identity.
    pub fn update_identity_label(&self, identity_id: Uuid, label: &str) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE identities SET label = ?2 WHERE id = ?1",
            params![identity_id.to_string(), label],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("identity {identity_id}")));
        }
        self.audit(
            "identity.update",
            Some("identity"),
            Some(identity_id),
            &format!("Renamed identity to {label}"),
        )
    }

    /// Delete an identity, and with it every account filed under it.
    pub fn delete_identity(&self, identity_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM identities WHERE id = ?1",
            params![identity_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("identity {identity_id}")));
        }
        self.audit(
            "identity.delete",
            Some("identity"),
            Some(identity_id),
            "Deleted an identity and everything filed under it",
        )
    }

    // ---------------------------------------------------------- identity email

    /// Attach another email address to an identity.
    ///
    /// The blind index is unique across the whole vault, so the same address
    /// cannot end up under two identities -- which is what would otherwise let
    /// one person's accounts drift apart into two half-populated maps.
    pub fn add_identity_email(
        &self,
        identity_id: Uuid,
        address: &str,
        blind_index: &str,
        is_primary: bool,
    ) -> Result<IdentityEmail> {
        if let Some(owner) = self.identity_id_by_email_index(blind_index)? {
            if owner != identity_id {
                return Err(CoreError::Invalid(
                    "that email address is already attached to another identity".into(),
                ));
            }
        }
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO identity_emails
                (id, identity_id, address, blind_index, is_primary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (blind_index) DO NOTHING",
            params![
                id.to_string(),
                identity_id.to_string(),
                address,
                blind_index,
                is_primary as i64,
                created_at
            ],
        )?;
        if is_primary {
            self.set_primary_email(identity_id, blind_index)?;
        }
        self.audit(
            "identity.email.add",
            Some("identity"),
            Some(identity_id),
            "Added an email address to an identity",
        )?;
        Ok(IdentityEmail {
            id,
            identity_id,
            address: address.to_string(),
            blind_index: blind_index.to_string(),
            is_primary,
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Every address attached to an identity, primary first.
    pub fn identity_emails(&self, identity_id: Uuid) -> Result<Vec<IdentityEmail>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, identity_id, address, blind_index, is_primary, created_at
               FROM identity_emails WHERE identity_id = ?1
              ORDER BY is_primary DESC, address",
        )?;
        let raw = stmt
            .query_map(params![identity_id.to_string()], |row| {
                Ok((
                    IdentityEmail {
                        id: uuid_from(row, 0)?,
                        identity_id: uuid_from(row, 1)?,
                        address: row.get(2)?,
                        blind_index: row.get(3)?,
                        is_primary: row.get::<_, i64>(4)? != 0,
                        created_at: OffsetDateTime::UNIX_EPOCH,
                    },
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (mut email, created) in raw {
            email.created_at = parse_rfc3339(&created)?;
            out.push(email);
        }
        Ok(out)
    }

    /// Make one address the identity's primary, and mirror it onto the identity.
    ///
    /// `identities.email` remains the primary address so that every existing
    /// lookup keeps working; this is the one place the two are kept in step.
    pub fn set_primary_email(&self, identity_id: Uuid, blind_index: &str) -> Result<()> {
        let address: Option<String> = self
            .conn()
            .query_row(
                "SELECT address FROM identity_emails WHERE identity_id = ?1 AND blind_index = ?2",
                params![identity_id.to_string(), blind_index],
                |r| r.get(0),
            )
            .optional()?;
        let address = address.ok_or_else(|| {
            CoreError::NotFound("that address is not attached to this identity".to_string())
        })?;
        self.conn().execute(
            "UPDATE identity_emails SET is_primary = (blind_index = ?2) WHERE identity_id = ?1",
            params![identity_id.to_string(), blind_index],
        )?;
        self.conn().execute(
            "UPDATE identities SET email = ?2, email_blind_index = ?3 WHERE id = ?1",
            params![identity_id.to_string(), address, blind_index],
        )?;
        self.audit(
            "identity.email.primary",
            Some("identity"),
            Some(identity_id),
            "Changed the primary email address of an identity",
        )
    }

    /// Detach an address from an identity.
    ///
    /// The last address cannot be removed while it is the primary one, because
    /// an identity with no address cannot be matched to anything afterwards.
    pub fn remove_identity_email(&self, identity_id: Uuid, email_id: Uuid) -> Result<()> {
        let emails = self.identity_emails(identity_id)?;
        let target = emails
            .iter()
            .find(|e| e.id == email_id)
            .ok_or_else(|| CoreError::NotFound(format!("email {email_id}")))?;
        if target.is_primary && emails.len() > 1 {
            return Err(CoreError::Invalid(
                "choose another primary address before removing this one".into(),
            ));
        }
        self.conn().execute(
            "DELETE FROM identity_emails WHERE id = ?1",
            params![email_id.to_string()],
        )?;
        if target.is_primary {
            self.conn().execute(
                "UPDATE identities SET email = NULL, email_blind_index = NULL WHERE id = ?1",
                params![identity_id.to_string()],
            )?;
        }
        self.audit(
            "identity.email.remove",
            Some("identity"),
            Some(identity_id),
            "Removed an email address from an identity",
        )
    }

    // ----------------------------------------------------------------- account

    pub(crate) const ACCOUNT_COLUMNS: &'static str =
        "id, identity_id, provider, external_ref, label, login_email, username, url, notes, \
         created_at";

    /// Insert an account under an identity.
    pub fn create_account(
        &self,
        identity_id: Uuid,
        provider: &Provider,
        external_ref: Option<&str>,
        label: &str,
    ) -> Result<Account> {
        self.create_account_full(
            identity_id,
            provider,
            external_ref,
            label,
            &AccountDetails::default(),
        )
    }

    /// Insert an account together with the details a manual entry carries.
    pub fn create_account_full(
        &self,
        identity_id: Uuid,
        provider: &Provider,
        external_ref: Option<&str>,
        label: &str,
        details: &AccountDetails,
    ) -> Result<Account> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO accounts
                (id, identity_id, provider, external_ref, label, login_email, username, url,
                 notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id.to_string(),
                identity_id.to_string(),
                provider_to_str(provider),
                external_ref,
                label,
                details.login_email,
                details.username,
                details.url,
                details.notes,
                created_at
            ],
        )?;
        self.audit(
            "account.create",
            Some("account"),
            Some(id),
            &format!("Created {} account {label}", provider.label()),
        )?;
        Ok(Account {
            id,
            identity_id,
            provider: provider.clone(),
            external_ref: external_ref.map(str::to_string),
            label: label.to_string(),
            login_email: details.login_email.clone(),
            username: details.username.clone(),
            url: details.url.clone(),
            notes: details.notes.clone(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Update the editable fields of an account.
    pub fn update_account(
        &self,
        account_id: Uuid,
        label: &str,
        details: &AccountDetails,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE accounts SET label = ?2, login_email = ?3, username = ?4, url = ?5,
                    notes = ?6
              WHERE id = ?1",
            params![
                account_id.to_string(),
                label,
                details.login_email,
                details.username,
                details.url,
                details.notes
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("account {account_id}")));
        }
        self.audit(
            "account.update",
            Some("account"),
            Some(account_id),
            &format!("Updated account {label}"),
        )
    }

    /// Fetch one account.
    pub fn account(&self, account_id: Uuid) -> Result<Option<Account>> {
        let sql = format!(
            "SELECT {} FROM accounts WHERE id = ?1",
            Self::ACCOUNT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![account_id.to_string()],
                Self::account_from_row,
            )
            .optional()?;
        Self::finish_account(row)
    }

    /// Every account an identity holds with a given provider.
    ///
    /// Returns a list rather than an option because holding two accounts with
    /// the same provider is legitimate -- two Supabase accounts under one
    /// person, signed in with different addresses. Callers that need exactly
    /// one have to decide what to do about the ambiguity rather than being
    /// handed an arbitrary row.
    pub fn accounts_for(&self, identity_id: Uuid, provider: &Provider) -> Result<Vec<Account>> {
        let sql = format!(
            "SELECT {} FROM accounts WHERE identity_id = ?1 AND provider = ?2
              ORDER BY created_at, id",
            Self::ACCOUNT_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(
                params![identity_id.to_string(), provider_to_str(provider)],
                Self::account_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for row in raw {
            if let Some(account) = Self::finish_account(Some(row))? {
                out.push(account);
            }
        }
        Ok(out)
    }

    /// The single account an identity holds with a provider, if it is unambiguous.
    ///
    /// `Ok(None)` means either none exists or several do; [`Self::accounts_for`]
    /// distinguishes the two.
    pub fn account_for(&self, identity_id: Uuid, provider: &Provider) -> Result<Option<Account>> {
        let mut accounts = self.accounts_for(identity_id, provider)?;
        if accounts.len() == 1 {
            Ok(Some(accounts.remove(0)))
        } else {
            Ok(None)
        }
    }

    fn account_from_row(row: &Row<'_>) -> rusqlite::Result<(Account, String, String)> {
        let provider: String = row.get(2)?;
        let created: String = row.get(9)?;
        Ok((
            Account {
                id: uuid_from(row, 0)?,
                identity_id: uuid_from(row, 1)?,
                provider: Provider::Unknown,
                external_ref: row.get(3)?,
                label: row.get(4)?,
                login_email: row.get(5)?,
                username: row.get(6)?,
                url: row.get(7)?,
                notes: row.get(8)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            provider,
            created,
        ))
    }

    fn finish_account(row: Option<(Account, String, String)>) -> Result<Option<Account>> {
        match row {
            Some((mut account, provider, created)) => {
                account.provider = provider_from_str(&provider)?;
                account.created_at = parse_rfc3339(&created)?;
                Ok(Some(account))
            }
            None => Ok(None),
        }
    }

    /// Move an account under a different identity.
    pub fn set_account_identity(&self, account_id: Uuid, identity_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE accounts SET identity_id = ?2 WHERE id = ?1",
            params![account_id.to_string(), identity_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("account {account_id}")));
        }
        self.audit(
            "account.move",
            Some("account"),
            Some(account_id),
            "Re-parented to another identity",
        )?;
        Ok(())
    }

    /// Delete an account and everything under it.
    ///
    /// Organizations, service resources, subscriptions and connections cascade
    /// through foreign keys; relations that referenced the account are cleared
    /// here because that table carries no foreign key of its own.
    pub fn delete_account(&self, account_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM accounts WHERE id = ?1",
            params![account_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("account {account_id}")));
        }
        self.conn().execute(
            "DELETE FROM relations
             WHERE (from_kind = 'account' AND from_id = ?1)
                OR (to_kind = 'account' AND to_id = ?1)",
            params![account_id.to_string()],
        )?;
        self.audit(
            "account.delete",
            Some("account"),
            Some(account_id),
            "Deleted account and everything under it",
        )?;
        Ok(())
    }

    /// Every account belonging to an identity.
    pub fn accounts_for_identity(&self, identity_id: Uuid) -> Result<Vec<Account>> {
        let sql = format!(
            "SELECT {} FROM accounts WHERE identity_id = ?1 ORDER BY provider, label",
            Self::ACCOUNT_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![identity_id.to_string()], Self::account_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            if let Some(account) = Self::finish_account(Some(entry))? {
                out.push(account);
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------ organization

    /// Insert an organization under an account.
    ///
    /// Only ever called with a name that came from the user or from the paste.
    /// DevLedger does not invent organizations.
    pub fn create_organization(
        &self,
        account_id: Uuid,
        provider_org_id: Option<&str>,
        name: &str,
    ) -> Result<Organization> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO organizations (id, account_id, provider_org_id, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id.to_string(),
                account_id.to_string(),
                provider_org_id,
                name,
                created_at
            ],
        )?;
        self.audit(
            "organization.create",
            Some("organization"),
            Some(id),
            &format!("Created organization {name}"),
        )?;
        Ok(Organization {
            id,
            account_id,
            provider_org_id: provider_org_id.map(str::to_string),
            name: name.to_string(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    pub(crate) fn organization_from_row(row: &Row<'_>) -> rusqlite::Result<(Organization, String)> {
        let created: String = row.get(4)?;
        Ok((
            Organization {
                id: uuid_from(row, 0)?,
                account_id: uuid_from(row, 1)?,
                provider_org_id: row.get(2)?,
                name: row.get(3)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created,
        ))
    }

    /// Find an organization by name within an account, case-insensitively.
    pub fn organization_by_name(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> Result<Option<Organization>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, account_id, provider_org_id, name, created_at
                 FROM organizations
                 WHERE account_id = ?1 AND name = ?2 COLLATE NOCASE",
                params![account_id.to_string(), name],
                Self::organization_from_row,
            )
            .optional()?;
        match row {
            Some((mut org, created)) => {
                org.created_at = parse_rfc3339(&created)?;
                Ok(Some(org))
            }
            None => Ok(None),
        }
    }

    /// Find an organization by name anywhere in the vault.
    ///
    /// Used by Smart Paste to notice that a pasted organization name already
    /// exists, even under a different account.
    pub fn organization_by_name_anywhere(&self, name: &str) -> Result<Option<Organization>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, account_id, provider_org_id, name, created_at
                 FROM organizations WHERE name = ?1 COLLATE NOCASE
                 ORDER BY created_at LIMIT 1",
                params![name],
                Self::organization_from_row,
            )
            .optional()?;
        match row {
            Some((mut org, created)) => {
                org.created_at = parse_rfc3339(&created)?;
                Ok(Some(org))
            }
            None => Ok(None),
        }
    }

    /// Move an organization under a different account.
    pub fn set_organization_account(&self, organization_id: Uuid, account_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE organizations SET account_id = ?2 WHERE id = ?1",
            params![organization_id.to_string(), account_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "organization {organization_id}"
            )));
        }
        self.audit(
            "organization.move",
            Some("organization"),
            Some(organization_id),
            "Re-parented to another account",
        )?;
        Ok(())
    }

    /// Delete an organization. Its resources survive, unassigned.
    pub fn delete_organization(&self, organization_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM organizations WHERE id = ?1",
            params![organization_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "organization {organization_id}"
            )));
        }
        self.conn().execute(
            "DELETE FROM relations
             WHERE (from_kind = 'organization' AND from_id = ?1)
                OR (to_kind = 'organization' AND to_id = ?1)",
            params![organization_id.to_string()],
        )?;
        self.audit(
            "organization.delete",
            Some("organization"),
            Some(organization_id),
            "Deleted organization",
        )?;
        Ok(())
    }

    /// Organizations under an account.
    pub fn organizations_for_account(&self, account_id: Uuid) -> Result<Vec<Organization>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, account_id, provider_org_id, name, created_at
             FROM organizations WHERE account_id = ?1 ORDER BY name",
        )?;
        let raw = stmt
            .query_map(params![account_id.to_string()], Self::organization_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for (mut org, created) in raw {
            org.created_at = parse_rfc3339(&created)?;
            out.push(org);
        }
        Ok(out)
    }

    // --------------------------------------------------------- service project

    pub(crate) const SERVICE_PROJECT_COLUMNS: &'static str =
        "id, account_id, organization_id, provider, provider_ref, name, region, environment, \
         url, notes, created_at";

    /// Insert a provider resource.
    #[allow(clippy::too_many_arguments)]
    pub fn create_service_project(
        &self,
        account_id: Uuid,
        organization_id: Option<Uuid>,
        provider: &Provider,
        provider_ref: Option<&str>,
        name: &str,
        region: Option<&str>,
        environment: Environment,
    ) -> Result<ServiceProject> {
        self.create_service_project_full(
            account_id,
            organization_id,
            provider,
            provider_ref,
            name,
            region,
            environment,
            None,
            None,
        )
    }

    /// Insert a provider resource, including the details a manual entry carries.
    #[allow(clippy::too_many_arguments)]
    pub fn create_service_project_full(
        &self,
        account_id: Uuid,
        organization_id: Option<Uuid>,
        provider: &Provider,
        provider_ref: Option<&str>,
        name: &str,
        region: Option<&str>,
        environment: Environment,
        url: Option<&str>,
        notes: Option<&str>,
    ) -> Result<ServiceProject> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO service_projects
                (id, account_id, organization_id, provider, provider_ref, name, region,
                 environment, url, notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id.to_string(),
                account_id.to_string(),
                organization_id.map(|v| v.to_string()),
                provider_to_str(provider),
                provider_ref,
                name,
                region,
                environment_to_str(environment),
                url,
                notes,
                created_at
            ],
        )?;
        self.audit(
            "service_project.create",
            Some("service_project"),
            Some(id),
            &format!("Recorded {} resource {name}", provider.label()),
        )?;
        Ok(ServiceProject {
            id,
            account_id,
            organization_id,
            provider: provider.clone(),
            provider_ref: provider_ref.map(str::to_string),
            name: name.to_string(),
            region: region.map(str::to_string),
            environment,
            url: url.map(str::to_string),
            notes: notes.map(str::to_string),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    pub(crate) fn service_project_from_row(
        row: &Row<'_>,
    ) -> rusqlite::Result<(ServiceProject, String, String, String)> {
        let provider: String = row.get(3)?;
        let environment: String = row.get(7)?;
        let created: String = row.get(10)?;
        Ok((
            ServiceProject {
                id: uuid_from(row, 0)?,
                account_id: uuid_from(row, 1)?,
                organization_id: opt_uuid_from(row, 2)?,
                provider: Provider::Unknown,
                provider_ref: row.get(4)?,
                name: row.get(5)?,
                region: row.get(6)?,
                url: row.get(8)?,
                notes: row.get(9)?,
                environment: Environment::Unknown,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            provider,
            environment,
            created,
        ))
    }

    pub(crate) fn finish_service_project(
        entry: (ServiceProject, String, String, String),
    ) -> Result<ServiceProject> {
        let (mut sp, provider, environment, created) = entry;
        sp.provider = provider_from_str(&provider)?;
        sp.environment = environment_from_str(&environment)?;
        sp.created_at = parse_rfc3339(&created)?;
        Ok(sp)
    }

    /// Find a resource by its provider-side reference.
    pub fn service_project_by_ref(
        &self,
        provider: &Provider,
        provider_ref: &str,
    ) -> Result<Option<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects WHERE provider = ?1 AND provider_ref = ?2",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![provider_to_str(provider), provider_ref],
                Self::service_project_from_row,
            )
            .optional()?;
        match row {
            Some(entry) => Ok(Some(Self::finish_service_project(entry)?)),
            None => Ok(None),
        }
    }

    /// Fetch a resource by id.
    pub fn service_project(&self, id: Uuid) -> Result<Option<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects WHERE id = ?1",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let row = self
            .conn()
            .query_row(
                &sql,
                params![id.to_string()],
                Self::service_project_from_row,
            )
            .optional()?;
        match row {
            Some(entry) => Ok(Some(Self::finish_service_project(entry)?)),
            None => Ok(None),
        }
    }

    /// Move a resource into an organization, or clear its assignment.
    pub fn set_service_project_organization(
        &self,
        service_project_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE service_projects SET organization_id = ?2 WHERE id = ?1",
            params![
                service_project_id.to_string(),
                organization_id.map(|v| v.to_string())
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "service project {service_project_id}"
            )));
        }
        self.audit(
            "service_project.assign_organization",
            Some("service_project"),
            Some(service_project_id),
            match organization_id {
                Some(_) => "Assigned to an organization",
                None => "Cleared its organization",
            },
        )?;
        Ok(())
    }

    /// Move a resource under a different account, setting its organization.
    ///
    /// The organization is written verbatim (including `None`), so a resource
    /// moved to another account never keeps an organization that belongs to the
    /// account it left.
    pub fn set_service_project_account(
        &self,
        service_project_id: Uuid,
        account_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE service_projects SET account_id = ?2, organization_id = ?3 WHERE id = ?1",
            params![
                service_project_id.to_string(),
                account_id.to_string(),
                organization_id.map(|v| v.to_string())
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "service project {service_project_id}"
            )));
        }
        self.audit(
            "service_project.move",
            Some("service_project"),
            Some(service_project_id),
            "Re-parented to another account",
        )?;
        Ok(())
    }

    /// Delete a resource. Its secrets cascade; project links are cleared.
    pub fn delete_service_project(&self, service_project_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM service_projects WHERE id = ?1",
            params![service_project_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "service project {service_project_id}"
            )));
        }
        self.conn().execute(
            "DELETE FROM relations
             WHERE (from_kind = 'service_project' AND from_id = ?1)
                OR (to_kind = 'service_project' AND to_id = ?1)",
            params![service_project_id.to_string()],
        )?;
        self.audit(
            "service_project.delete",
            Some("service_project"),
            Some(service_project_id),
            "Deleted resource",
        )?;
        Ok(())
    }

    /// All resources, newest last.
    pub fn list_service_projects(&self) -> Result<Vec<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects ORDER BY name, id",
            Self::SERVICE_PROJECT_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map([], Self::service_project_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_service_project).collect()
    }

    /// Build the display summary for a resource.
    pub fn service_project_summary(&self, sp: ServiceProject) -> Result<ServiceProjectSummary> {
        let account_label: String = self.conn().query_row(
            "SELECT label FROM accounts WHERE id = ?1",
            params![sp.account_id.to_string()],
            |r| r.get(0),
        )?;
        let identity_email: Option<String> = self
            .conn()
            .query_row(
                "SELECT i.email FROM accounts a
                 JOIN identities i ON i.id = a.identity_id
                 WHERE a.id = ?1",
                params![sp.account_id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let organization_name: Option<String> = match sp.organization_id {
            Some(org_id) => self
                .conn()
                .query_row(
                    "SELECT name FROM organizations WHERE id = ?1",
                    params![org_id.to_string()],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let secret_count: i64 = self.conn().query_row(
            "SELECT count(*) FROM secrets WHERE service_project_id = ?1",
            params![sp.id.to_string()],
            |r| r.get(0),
        )?;
        let used_by = self.projects_using(sp.id)?;
        Ok(ServiceProjectSummary {
            service_project: sp,
            account_label,
            identity_email,
            organization_name,
            secret_count,
            used_by,
        })
    }

    /// DevLedger projects linked to a resource.
    pub fn projects_using(&self, service_project_id: Uuid) -> Result<Vec<ProjectRefLabel>> {
        let mut stmt = self.conn().prepare(
            "SELECT p.id, p.name FROM relations r
             JOIN projects p ON p.id = r.to_id
             WHERE r.from_kind = 'service_project' AND r.from_id = ?1
               AND r.to_kind = 'project' AND r.kind = 'used_by'
             ORDER BY p.name",
        )?;
        let raw = stmt
            .query_map(params![service_project_id.to_string()], |r| {
                Ok((uuid_from(r, 0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(raw
            .into_iter()
            .map(|(id, name)| ProjectRefLabel { id, name })
            .collect())
    }

    /// Resources linked to a DevLedger project.
    pub fn service_projects_for_project(&self, project_id: Uuid) -> Result<Vec<ServiceProject>> {
        let sql = format!(
            "SELECT {} FROM service_projects sp
             JOIN relations r ON r.from_id = sp.id
             WHERE r.from_kind = 'service_project' AND r.to_kind = 'project'
               AND r.to_id = ?1 AND r.kind = 'used_by'
             ORDER BY sp.provider, sp.name",
            Self::SERVICE_PROJECT_COLUMNS
                .split(", ")
                .map(|c| format!("sp.{c}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(
                params![project_id.to_string()],
                Self::service_project_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_service_project).collect()
    }

    // ----------------------------------------------------------------- project

    /// Insert a DevLedger project.
    pub fn create_project(&self, name: &str, description: Option<&str>) -> Result<Project> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn()
            .execute(
                "INSERT INTO projects (id, name, description, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id.to_string(), name, description, created_at],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    CoreError::Invalid(format!("a project called {name} already exists"))
                }
                other => CoreError::from(other),
            })?;
        self.audit(
            "project.create",
            Some("project"),
            Some(id),
            &format!("Created project {name}"),
        )?;
        Ok(Project {
            id,
            name: name.to_string(),
            description: description.map(str::to_string),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    fn project_from_row(row: &Row<'_>) -> rusqlite::Result<(Project, String)> {
        let created: String = row.get(3)?;
        Ok((
            Project {
                id: uuid_from(row, 0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            created,
        ))
    }

    /// Fetch a project by id.
    pub fn project(&self, id: Uuid) -> Result<Option<Project>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, name, description, created_at FROM projects WHERE id = ?1",
                params![id.to_string()],
                Self::project_from_row,
            )
            .optional()?;
        match row {
            Some((mut p, created)) => {
                p.created_at = parse_rfc3339(&created)?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    /// Find a project by name, case-insensitively.
    pub fn project_by_name(&self, name: &str) -> Result<Option<Project>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, name, description, created_at
                 FROM projects WHERE name = ?1 COLLATE NOCASE",
                params![name],
                Self::project_from_row,
            )
            .optional()?;
        match row {
            Some((mut p, created)) => {
                p.created_at = parse_rfc3339(&created)?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    /// Every DevLedger project with its counts.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id, name, description, created_at FROM projects ORDER BY name, id")?;
        let raw = stmt
            .query_map([], Self::project_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (mut project, created) in raw {
            project.created_at = parse_rfc3339(&created)?;
            let resources = self.service_projects_for_project(project.id)?;
            let mut providers: Vec<Provider> = Vec::new();
            for r in &resources {
                if !providers.contains(&r.provider) {
                    providers.push(r.provider.clone());
                }
            }
            out.push(ProjectSummary {
                service_project_count: resources.len() as i64,
                secret_count: self.count_secrets_for_project(project.id)?,
                providers,
                project,
            });
        }
        Ok(out)
    }

    /// Rename a project or change its description.
    pub fn update_project(
        &self,
        project_id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<()> {
        let changed = self
            .conn()
            .execute(
                "UPDATE projects SET name = ?2, description = ?3 WHERE id = ?1",
                params![project_id.to_string(), name, description],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    CoreError::Invalid(format!("a project called {name} already exists"))
                }
                other => CoreError::from(other),
            })?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("project {project_id}")));
        }
        self.audit(
            "project.update",
            Some("project"),
            Some(project_id),
            &format!("Renamed to {name}"),
        )?;
        Ok(())
    }

    /// Delete a project. Its resources survive; only the link is lost.
    pub fn delete_project(&self, project_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM projects WHERE id = ?1",
            params![project_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("project {project_id}")));
        }
        self.conn().execute(
            "DELETE FROM relations WHERE to_kind = 'project' AND to_id = ?1",
            params![project_id.to_string()],
        )?;
        self.audit(
            "project.delete",
            Some("project"),
            Some(project_id),
            "Deleted project",
        )?;
        Ok(())
    }

    /// Update the editable fields of a provider resource.
    #[allow(clippy::too_many_arguments)]
    pub fn update_service_project(
        &self,
        id: Uuid,
        name: &str,
        provider_ref: Option<&str>,
        region: Option<&str>,
        environment: Environment,
        url: Option<&str>,
        notes: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE service_projects
                SET name = ?2, provider_ref = ?3, region = ?4, environment = ?5, url = ?6,
                    notes = ?7
              WHERE id = ?1",
            params![
                id.to_string(),
                name,
                provider_ref,
                region,
                environment_to_str(environment),
                url,
                notes
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("resource {id}")));
        }
        self.audit(
            "service_project.update",
            Some("service_project"),
            Some(id),
            &format!("Updated resource {name}"),
        )
    }

    // ------------------------------------------------------------------ secret

    const SECRET_COLUMNS: &'static str =
        "id, project_id, service_project_id, kind, name, preview, value_blind_index, \
         environment, account_id, notes, created_at, updated_at";

    /// Insert a secret's metadata and its sealed value together.
    #[allow(clippy::too_many_arguments)]
    pub fn create_secret(
        &mut self,
        project_id: Option<Uuid>,
        service_project_id: Option<Uuid>,
        kind: SecretKind,
        name: &str,
        preview: &str,
        value_blind_index: &str,
        environment: Environment,
        envelope: &[u8],
    ) -> Result<SecretRecord> {
        self.create_secret_owned(
            SecretOwner {
                project_id,
                service_project_id,
                account_id: None,
            },
            kind,
            name,
            preview,
            value_blind_index,
            environment,
            None,
            envelope,
        )
    }

    /// Insert a secret against any of the three things one can belong to.
    #[allow(clippy::too_many_arguments)]
    pub fn create_secret_owned(
        &mut self,
        owner: SecretOwner,
        kind: SecretKind,
        name: &str,
        preview: &str,
        value_blind_index: &str,
        environment: Environment,
        notes: Option<&str>,
        envelope: &[u8],
    ) -> Result<SecretRecord> {
        let SecretOwner {
            project_id,
            service_project_id,
            account_id,
        } = owner;
        if project_id.is_none() && service_project_id.is_none() && account_id.is_none() {
            return Err(CoreError::Invalid(
                "a secret must belong to a project, a service resource or an account".into(),
            ));
        }
        let id = Uuid::new_v4();
        let at = now_rfc3339()?;
        let tx = self.conn_mut().transaction()?;
        tx.execute(
            "INSERT INTO secrets
                (id, project_id, service_project_id, account_id, kind, name, preview,
                 value_blind_index, environment, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id.to_string(),
                project_id.map(|v| v.to_string()),
                service_project_id.map(|v| v.to_string()),
                account_id.map(|v| v.to_string()),
                secret_kind_to_str(kind),
                name,
                preview,
                value_blind_index,
                environment_to_str(environment),
                notes,
                at
            ],
        )?;
        tx.execute(
            "INSERT INTO secret_values (secret_id, envelope) VALUES (?1, ?2)",
            params![id.to_string(), envelope],
        )?;
        tx.execute(
            "INSERT INTO audit_log (at, action, entity_kind, entity_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                at,
                "secret.create",
                "secret",
                id.to_string(),
                format!("Stored {} as {name}", kind.label())
            ],
        )?;
        tx.commit()?;

        Ok(SecretRecord {
            id,
            project_id,
            service_project_id,
            account_id,
            kind,
            name: name.to_string(),
            preview: preview.to_string(),
            value_blind_index: value_blind_index.to_string(),
            environment,
            notes: notes.map(str::to_string),
            created_at: parse_rfc3339(&at)?,
            updated_at: parse_rfc3339(&at)?,
        })
    }

    /// Replace a secret's value, keeping its identity and history.
    pub fn update_secret_value(
        &mut self,
        secret_id: Uuid,
        preview: &str,
        value_blind_index: &str,
        envelope: &[u8],
    ) -> Result<()> {
        let at = now_rfc3339()?;
        let tx = self.conn_mut().transaction()?;
        let changed = tx.execute(
            "UPDATE secrets SET preview = ?2, value_blind_index = ?3, updated_at = ?4
             WHERE id = ?1",
            params![secret_id.to_string(), preview, value_blind_index, at],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        tx.execute(
            "UPDATE secret_values SET envelope = ?2 WHERE secret_id = ?1",
            params![secret_id.to_string(), envelope],
        )?;
        tx.execute(
            "INSERT INTO audit_log (at, action, entity_kind, entity_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                at,
                "secret.rotate",
                "secret",
                secret_id.to_string(),
                "Replaced stored value"
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn secret_from_row(row: &Row<'_>) -> rusqlite::Result<(SecretRecord, String, String, String)> {
        let kind: String = row.get(3)?;
        let env: String = row.get(7)?;
        let created: String = row.get(10)?;
        let updated: String = row.get(11)?;
        Ok((
            SecretRecord {
                id: uuid_from(row, 0)?,
                project_id: opt_uuid_from(row, 1)?,
                service_project_id: opt_uuid_from(row, 2)?,
                account_id: opt_uuid_from(row, 8)?,
                kind: SecretKind::GenericApiKey,
                name: row.get(4)?,
                preview: row.get(5)?,
                value_blind_index: row.get(6)?,
                environment: Environment::Unknown,
                notes: row.get(9)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
            },
            kind,
            env,
            format!("{created}|{updated}"),
        ))
    }

    fn finish_secret(entry: (SecretRecord, String, String, String)) -> Result<SecretRecord> {
        let (mut record, kind, env, stamps) = entry;
        record.kind = secret_kind_from_str(&kind)?;
        record.environment = environment_from_str(&env)?;
        let (created, updated) = stamps
            .split_once('|')
            .ok_or_else(|| CoreError::Storage("corrupt timestamp pair".into()))?;
        record.created_at = parse_rfc3339(created)?;
        record.updated_at = parse_rfc3339(updated)?;
        Ok(record)
    }

    /// Find a secret by the blind index of its value.
    pub fn secret_by_blind_index(&self, index: &str) -> Result<Option<SecretRecord>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE value_blind_index = ?1 LIMIT 1",
            Self::SECRET_COLUMNS
        );
        let row = self
            .conn()
            .query_row(&sql, params![index], Self::secret_from_row)
            .optional()?;
        row.map(Self::finish_secret).transpose()
    }

    /// Find a secret by name, anywhere in the vault.
    pub fn secret_by_name(&self, name: &str) -> Result<Option<SecretRecord>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE name = ?1 ORDER BY created_at LIMIT 1",
            Self::SECRET_COLUMNS
        );
        let row = self
            .conn()
            .query_row(&sql, params![name], Self::secret_from_row)
            .optional()?;
        row.map(Self::finish_secret).transpose()
    }

    /// Fetch a secret by id.
    pub fn secret(&self, id: Uuid) -> Result<Option<SecretRecord>> {
        let sql = format!("SELECT {} FROM secrets WHERE id = ?1", Self::SECRET_COLUMNS);
        let row = self
            .conn()
            .query_row(&sql, params![id.to_string()], Self::secret_from_row)
            .optional()?;
        row.map(Self::finish_secret).transpose()
    }

    /// The SQL fragment matching every secret a DevLedger project can reach.
    ///
    /// That is: filed directly against the project, or against any resource the
    /// project uses.
    const SECRETS_FOR_PROJECT_WHERE: &'static str = "
        project_id = ?1
        OR service_project_id IN (
            SELECT r.from_id FROM relations r
            WHERE r.from_kind = 'service_project' AND r.to_kind = 'project'
              AND r.to_id = ?1 AND r.kind = 'used_by'
        )";

    fn count_secrets_for_project(&self, project_id: Uuid) -> Result<i64> {
        let sql = format!(
            "SELECT count(*) FROM secrets WHERE {}",
            Self::SECRETS_FOR_PROJECT_WHERE
        );
        Ok(self
            .conn()
            .query_row(&sql, params![project_id.to_string()], |r| r.get(0))?)
    }

    fn decorate(&self, secret: SecretRecord) -> Result<VaultEntry> {
        let service_project_name = match secret.service_project_id {
            Some(id) => self
                .conn()
                .query_row(
                    "SELECT name FROM service_projects WHERE id = ?1",
                    params![id.to_string()],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        Ok(VaultEntry {
            client_unsafe: secret.kind.is_client_unsafe(),
            provider: secret.kind.provider(),
            service_project_name,
            secret,
        })
    }

    /// Every secret a DevLedger project can reach.
    pub fn list_secrets_for_project(&self, project_id: Uuid) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE {} ORDER BY name",
            Self::SECRET_COLUMNS,
            Self::SECRETS_FOR_PROJECT_WHERE
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![project_id.to_string()], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            out.push(self.decorate(Self::finish_secret(entry)?)?);
        }
        Ok(out)
    }

    /// Every secret filed against a provider resource.
    pub fn list_secrets_for_service_project(
        &self,
        service_project_id: Uuid,
    ) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE service_project_id = ?1 ORDER BY name",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(
                params![service_project_id.to_string()],
                Self::secret_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            out.push(self.decorate(Self::finish_secret(entry)?)?);
        }
        Ok(out)
    }

    /// Update a secret's metadata, leaving its value untouched.
    pub fn update_secret_meta(
        &self,
        secret_id: Uuid,
        name: &str,
        environment: Environment,
        notes: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE secrets SET name = ?2, environment = ?3, notes = ?4, updated_at = ?5
              WHERE id = ?1",
            params![
                secret_id.to_string(),
                name,
                environment_to_str(environment),
                notes,
                now_rfc3339()?
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        self.audit(
            "secret.update",
            Some("secret"),
            Some(secret_id),
            &format!("Updated the details of {name}"),
        )
    }

    /// Every secret filed against an account, metadata only.
    pub fn list_secrets_for_account(&self, account_id: Uuid) -> Result<Vec<VaultEntry>> {
        let sql = format!(
            "SELECT {} FROM secrets WHERE account_id = ?1 ORDER BY name",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![account_id.to_string()], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            out.push(self.decorate(Self::finish_secret(entry)?)?);
        }
        Ok(out)
    }

    /// How many secrets a delete would take with it.
    ///
    /// Deleting cascades, and a count shown before the fact is the difference
    /// between an informed decision and an unrecoverable surprise.
    pub fn secrets_owned_directly(&self, project_id: Uuid) -> Result<i64> {
        Ok(self.conn().query_row(
            "SELECT count(*) FROM secrets WHERE project_id = ?1",
            params![project_id.to_string()],
            |r| r.get(0),
        )?)
    }

    /// Read the sealed envelope for a secret.
    pub fn secret_envelope(&self, secret_id: Uuid) -> Result<Vec<u8>> {
        self.conn()
            .query_row(
                "SELECT envelope FROM secret_values WHERE secret_id = ?1",
                params![secret_id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound(format!("envelope for secret {secret_id}")))
    }

    /// Delete a secret and its envelope.
    pub fn delete_secret(&self, secret_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM secrets WHERE id = ?1",
            params![secret_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("secret {secret_id}")));
        }
        self.audit(
            "secret.delete",
            Some("secret"),
            Some(secret_id),
            "Deleted secret",
        )?;
        Ok(())
    }

    // --------------------------------------------------------------- relations

    /// Record a relation, ignoring an exact duplicate.
    pub fn create_relation(
        &self,
        from: EntityRef,
        to: EntityRef,
        kind: RelationKind,
        evidence: &Evidence,
    ) -> Result<Relation> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT OR IGNORE INTO relations
                (id, from_kind, from_id, to_kind, to_id, kind,
                 evidence_level, evidence_rule, evidence_reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id.to_string(),
                entity_kind_to_str(from.kind),
                from.id.to_string(),
                entity_kind_to_str(to.kind),
                to.id.to_string(),
                relation_kind_to_str(kind),
                evidence_level_to_str(evidence.level),
                evidence.rule,
                evidence.reason,
                created_at
            ],
        )?;
        Ok(Relation {
            id,
            from,
            to,
            kind,
            evidence: evidence.clone(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Remove a relation between two entities.
    pub fn delete_relation(
        &self,
        from: EntityRef,
        to: EntityRef,
        kind: RelationKind,
    ) -> Result<()> {
        self.conn().execute(
            "DELETE FROM relations
             WHERE from_kind = ?1 AND from_id = ?2 AND to_kind = ?3 AND to_id = ?4 AND kind = ?5",
            params![
                entity_kind_to_str(from.kind),
                from.id.to_string(),
                entity_kind_to_str(to.kind),
                to.id.to_string(),
                relation_kind_to_str(kind)
            ],
        )?;
        self.audit(
            "relation.delete",
            Some(entity_kind_to_str(from.kind)),
            Some(from.id),
            &format!("Unlinked {} {}", kind.label(), to.id),
        )?;
        Ok(())
    }

    /// Every relation touching an entity, in either direction.
    pub fn relations_for(&self, entity: EntityRef) -> Result<Vec<Relation>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, from_kind, from_id, to_kind, to_id, kind,
                    evidence_level, evidence_rule, evidence_reason, created_at
             FROM relations
             WHERE (from_kind = ?1 AND from_id = ?2) OR (to_kind = ?1 AND to_id = ?2)
             ORDER BY created_at, id",
        )?;
        let raw = stmt
            .query_map(
                params![entity_kind_to_str(entity.kind), entity.id.to_string()],
                |r| {
                    Ok((
                        uuid_from(r, 0)?,
                        r.get::<_, String>(1)?,
                        uuid_from(r, 2)?,
                        r.get::<_, String>(3)?,
                        uuid_from(r, 4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (id, fk, fi, tk, ti, kind, level, rule, reason, created) in raw {
            out.push(Relation {
                id,
                from: EntityRef::new(entity_kind_from_str(&fk)?, fi),
                to: EntityRef::new(entity_kind_from_str(&tk)?, ti),
                kind: relation_kind_from_str(&kind)?,
                evidence: Evidence {
                    level: evidence_level_from_str(&level)?,
                    rule,
                    reason,
                },
                created_at: parse_rfc3339(&created)?,
            });
        }
        Ok(out)
    }

    // ----------------------------------------------------------- subscriptions

    /// Record a parsed subscription against an account.
    pub fn create_subscription(
        &self,
        account_id: Uuid,
        parsed: &ParsedSubscription,
    ) -> Result<Subscription> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO subscriptions
                (id, account_id, plan, status, amount_cents, currency, interval,
                 trial_ends_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id.to_string(),
                account_id.to_string(),
                parsed.plan,
                subscription_status_to_str(parsed.status),
                parsed.amount_cents,
                parsed.currency,
                parsed.interval.map(billing_interval_to_str),
                parsed.trial_ends_at,
                created_at
            ],
        )?;
        self.audit(
            "subscription.create",
            Some("subscription"),
            Some(id),
            &format!("Recorded {} subscription", parsed.plan),
        )?;
        Ok(Subscription {
            id,
            account_id,
            plan: parsed.plan.clone(),
            status: parsed.status,
            amount_cents: parsed.amount_cents,
            currency: parsed.currency.clone(),
            interval: parsed.interval,
            trial_ends_at: parsed.trial_ends_at.clone(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Delete a subscription.
    pub fn delete_subscription(&self, subscription_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM subscriptions WHERE id = ?1",
            params![subscription_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "subscription {subscription_id}"
            )));
        }
        self.audit(
            "subscription.delete",
            Some("subscription"),
            Some(subscription_id),
            "Deleted subscription",
        )?;
        Ok(())
    }

    const SUBSCRIPTION_COLUMNS: &'static str =
        "id, account_id, plan, status, amount_cents, currency, interval, trial_ends_at, created_at";

    fn subscription_from_row(
        row: &Row<'_>,
    ) -> rusqlite::Result<(Subscription, String, Option<String>, String)> {
        let status: String = row.get(3)?;
        let interval: Option<String> = row.get(6)?;
        let created: String = row.get(8)?;
        Ok((
            Subscription {
                id: uuid_from(row, 0)?,
                account_id: uuid_from(row, 1)?,
                plan: row.get(2)?,
                status: crate::model::SubscriptionStatus::Unknown,
                amount_cents: row.get(4)?,
                currency: row.get(5)?,
                interval: None,
                trial_ends_at: row.get(7)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            status,
            interval,
            created,
        ))
    }

    fn finish_subscription(
        entry: (Subscription, String, Option<String>, String),
    ) -> Result<Subscription> {
        let (mut sub, status, interval, created) = entry;
        sub.status = subscription_status_from_str(&status)?;
        sub.interval = match interval {
            Some(i) => Some(billing_interval_from_str(&i)?),
            None => None,
        };
        sub.created_at = parse_rfc3339(&created)?;
        Ok(sub)
    }

    /// Subscriptions attached to an account.
    pub fn subscriptions_for_account(&self, account_id: Uuid) -> Result<Vec<Subscription>> {
        let sql = format!(
            "SELECT {} FROM subscriptions WHERE account_id = ?1 ORDER BY created_at",
            Self::SUBSCRIPTION_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![account_id.to_string()], Self::subscription_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_subscription).collect()
    }

    /// Every subscription in the vault, with the account behind it.
    pub fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>> {
        let sql = format!(
            "SELECT {} FROM subscriptions ORDER BY created_at DESC",
            Self::SUBSCRIPTION_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map([], Self::subscription_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            let subscription = Self::finish_subscription(entry)?;
            let row: Option<(String, String, Option<String>)> = self
                .conn()
                .query_row(
                    "SELECT a.label, a.provider, i.email FROM accounts a
                     JOIN identities i ON i.id = a.identity_id
                     WHERE a.id = ?1",
                    params![subscription.account_id.to_string()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let (account_label, provider, identity_email) = match row {
                Some((label, provider, email)) => (label, provider_from_str(&provider)?, email),
                None => ("Unknown account".to_string(), Provider::Unknown, None),
            };
            out.push(SubscriptionSummary {
                subscription,
                provider,
                account_label,
                identity_email,
            });
        }
        Ok(out)
    }

    // ------------------------------------------------------------------- map

    /// The whole graph, for the map view.
    pub fn identity_graph(&self) -> Result<Vec<IdentityNode>> {
        let mut nodes = Vec::new();
        for identity in self.list_identities()? {
            let mut accounts = Vec::new();
            for account in self.accounts_for_identity(identity.id)? {
                let mut organizations = Vec::new();
                for organization in self.organizations_for_account(account.id)? {
                    let mut service_projects = Vec::new();
                    for sp in self.list_service_projects()? {
                        if sp.organization_id == Some(organization.id) {
                            service_projects.push(self.service_project_summary(sp)?);
                        }
                    }
                    organizations.push(OrganizationNode {
                        organization,
                        service_projects,
                    });
                }
                let mut unassigned = Vec::new();
                for sp in self.list_service_projects()? {
                    if sp.account_id == account.id && sp.organization_id.is_none() {
                        unassigned.push(self.service_project_summary(sp)?);
                    }
                }
                accounts.push(AccountNode {
                    subscriptions: self.subscriptions_for_account(account.id)?,
                    account,
                    organizations,
                    unassigned,
                });
            }
            nodes.push(IdentityNode { identity, accounts });
        }
        Ok(nodes)
    }

    /// Everything DevLedger could not work out on its own.
    pub fn needs_attention(&self) -> Result<Vec<AttentionItem>> {
        let mut items = Vec::new();

        for sp in self.list_service_projects()? {
            if sp.organization_id.is_none() {
                items.push(AttentionItem {
                    kind: AttentionKind::UnassignedOrganization,
                    title: format!("{} has no organization", sp.name),
                    detail: format!(
                        "DevLedger does not know which {} organization owns this resource. \
                         Assign it so the map is accurate.",
                        sp.provider.label()
                    ),
                    entity: EntityRef::new(EntityKind::ServiceProject, sp.id),
                });
            }
            if self.projects_using(sp.id)?.is_empty() {
                items.push(AttentionItem {
                    kind: AttentionKind::UnlinkedServiceProject,
                    title: format!("{} is not used by any project", sp.name),
                    detail: "Link it to the project that uses it, so its secrets appear in that \
                         project's vault."
                        .to_string(),
                    entity: EntityRef::new(EntityKind::ServiceProject, sp.id),
                });
            }
        }

        for identity in self.list_identities()? {
            if identity.email.is_none() {
                items.push(AttentionItem {
                    kind: AttentionKind::IdentityWithoutEmail,
                    title: format!("{} has no email", identity.label),
                    detail: "Without an email, DevLedger cannot match future pastes to this \
                             identity."
                        .to_string(),
                    entity: EntityRef::new(EntityKind::Identity, identity.id),
                });
            }
        }

        let orphan_sql = format!(
            "SELECT {} FROM secrets WHERE project_id IS NULL AND service_project_id IS NULL",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&orphan_sql)?;
        let raw = stmt
            .query_map([], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for entry in raw {
            let secret = Self::finish_secret(entry)?;
            items.push(AttentionItem {
                kind: AttentionKind::OrphanSecret,
                title: format!("{} is filed against nothing", secret.name),
                detail: "Attach it to a project or a service resource.".to_string(),
                entity: EntityRef::new(EntityKind::Secret, secret.id),
            });
        }

        let mut stmt = self.conn().prepare(
            "SELECT id, name FROM secrets s
              WHERE NOT EXISTS (SELECT 1 FROM secret_values v WHERE v.secret_id = s.id)",
        )?;
        let missing = stmt
            .query_map([], |row| Ok((uuid_from(row, 0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name) in missing {
            items.push(AttentionItem {
                kind: AttentionKind::SecretValueMissing,
                title: format!("{name} has no stored value"),
                detail: "This entry lost its encrypted value, which a DevLedger build before \
                         0.6.0 could do while upgrading a 0.3.0 vault. The value cannot be \
                         recovered. Delete the entry and store the credential again."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Secret, id),
            });
        }

        let mut stmt = self.conn().prepare(
            "SELECT a.identity_id, a.provider, count(*) FROM accounts a
              GROUP BY a.identity_id, a.provider HAVING count(*) > 1",
        )?;
        let ambiguous = stmt
            .query_map([], |row| {
                Ok((
                    uuid_from(row, 0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (identity_id, provider, count) in ambiguous {
            let provider = provider_from_str(&provider)?;
            let label = self
                .identity(identity_id)?
                .map(|i| i.label)
                .unwrap_or_else(|| "an identity".to_string());
            items.push(AttentionItem {
                kind: AttentionKind::AmbiguousProviderAccount,
                title: format!("{label} holds {count} {} accounts", provider.label()),
                detail: "That is fine, but a paste naming only the provider cannot say which \
                         account it belongs to. DevLedger will file it under the oldest one and \
                         tell you; move it from the map if it guessed wrong."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Identity, identity_id),
            });
        }

        Ok(items)
    }

    // ------------------------------------------------------------- provenance

    /// Attach a redacted provenance record to an entity.
    pub fn record_provenance(&self, entity: EntityRef, provenance: &Provenance) -> Result<()> {
        self.conn().execute(
            "INSERT INTO provenance_records
                (id, entity_kind, entity_id, source, redacted_excerpt, original_len, captured_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                entity_kind_to_str(entity.kind),
                entity.id.to_string(),
                source_kind_to_str(provenance.source),
                provenance.redacted_excerpt,
                provenance.original_len as i64,
                to_rfc3339(provenance.captured_at)?
            ],
        )?;
        Ok(())
    }

    /// Provenance records attached to an entity, newest first.
    pub fn provenance_for(&self, entity: EntityRef) -> Result<Vec<Provenance>> {
        let mut stmt = self.conn().prepare(
            "SELECT source, redacted_excerpt, original_len, captured_at
             FROM provenance_records
             WHERE entity_kind = ?1 AND entity_id = ?2
             ORDER BY captured_at DESC",
        )?;
        let raw = stmt
            .query_map(
                params![entity_kind_to_str(entity.kind), entity.id.to_string()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for (source, redacted_excerpt, original_len, captured) in raw {
            out.push(Provenance {
                source: source_kind_from_str(&source)?,
                redacted_excerpt,
                original_len: original_len as usize,
                captured_at: parse_rfc3339(&captured)?,
            });
        }
        Ok(out)
    }

    // -------------------------------------------------------------- audit log

    /// Read the most recent audit entries, newest first.
    pub fn recent_audit(&self, limit: i64) -> Result<Vec<AuditEntry>> {
        let mut stmt = self.conn().prepare(
            "SELECT seq, at, action, entity_kind, entity_id, detail
             FROM audit_log ORDER BY seq DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(AuditEntry {
                    seq: r.get(0)?,
                    at: r.get(1)?,
                    action: r.get(2)?,
                    entity_kind: r.get(3)?,
                    entity_id: r.get(4)?,
                    detail: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}
