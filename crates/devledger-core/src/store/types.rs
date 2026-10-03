//! What the store hands back: summaries and nodes shaped for the UI.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{
    Account, EntityRef, Identity, Organization, Project, Provider, SecretRecord, ServiceProject,
    Subscription,
};

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

/// A secret with a short label for what it belongs to, for vault-wide lists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretListing {
    /// The secret, metadata only.
    pub entry: VaultEntry,
    /// "Storefront", "Loopia · Domains", "Storefront via storefront-api".
    pub owner: String,
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
    /// A resource holding keys that no DevLedger project uses.
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
