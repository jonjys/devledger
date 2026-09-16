//! The DevLedger domain model: Identity -> Account -> Organization -> Project.
//!
//! Every type here is safe to serialize to the UI. Secret *values* are never
//! part of a model struct -- a [`SecretRecord`] carries metadata and a masked
//! preview, and the ciphertext lives in a separate table reachable only through
//! an explicit reveal.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

/// A human identity, usually keyed by the email used to sign in to a provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    /// Stable local id.
    pub id: Uuid,
    /// Display label, e.g. "Work" or the email itself.
    pub label: String,
    /// Email address, if one was detected.
    pub email: Option<String>,
    /// Blind index over the email, for duplicate detection.
    pub email_blind_index: Option<String>,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A provider account owned by an [`Identity`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    /// Stable local id.
    pub id: Uuid,
    /// Owning identity.
    pub identity_id: Uuid,
    /// Which provider this account belongs to.
    pub provider: Provider,
    /// Provider-side identifier when one is known.
    pub external_ref: Option<String>,
    /// Display label.
    pub label: String,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// An organization inside a provider account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Organization {
    /// Stable local id.
    pub id: Uuid,
    /// Owning account.
    pub account_id: Uuid,
    /// Provider-side org id, when known.
    pub provider_org_id: Option<String>,
    /// Display name.
    pub name: String,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A project: the unit a developer actually works in, and the vault scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    /// Stable local id.
    pub id: Uuid,
    /// Owning organization.
    pub organization_id: Uuid,
    /// Provider project reference, e.g. a Supabase project ref.
    pub provider_project_ref: Option<String>,
    /// Display name.
    pub name: String,
    /// Deployment region, when known.
    pub region: Option<String>,
    /// Which environment this project represents.
    pub environment: Environment,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Providers DevLedger can recognise deterministically.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    /// Supabase.
    Supabase,
    /// Generic Postgres, not tied to a managed provider.
    Postgres,
    /// GitHub.
    GitHub,
    /// Stripe.
    Stripe,
    /// OpenAI.
    OpenAi,
    /// Amazon Web Services.
    Aws,
    /// Vercel.
    Vercel,
    /// Anything recognised as a credential but not attributable.
    Unknown,
}

impl Provider {
    /// Human-readable provider name.
    pub fn label(&self) -> &'static str {
        match self {
            Provider::Supabase => "Supabase",
            Provider::Postgres => "Postgres",
            Provider::GitHub => "GitHub",
            Provider::Stripe => "Stripe",
            Provider::OpenAi => "OpenAI",
            Provider::Aws => "AWS",
            Provider::Vercel => "Vercel",
            Provider::Unknown => "Unknown",
        }
    }
}

/// Which deployment environment a project or secret belongs to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    /// Local development.
    Development,
    /// Preview / staging.
    Staging,
    /// Production.
    Production,
    /// Not determined.
    #[default]
    Unknown,
}

/// What kind of credential a secret is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    /// Supabase anon / publishable key. Safe for clients.
    SupabaseAnonKey,
    /// Supabase service_role / secret key. Never safe for clients.
    SupabaseServiceRoleKey,
    /// Postgres connection string including a password.
    PostgresConnectionString,
    /// JWT signing secret.
    JwtSecret,
    /// GitHub personal access token.
    GitHubToken,
    /// Stripe secret key.
    StripeSecretKey,
    /// OpenAI API key.
    OpenAiApiKey,
    /// AWS access key id (paired with a secret access key).
    AwsAccessKeyId,
    /// AWS secret access key.
    AwsSecretAccessKey,
    /// Something that matched a generic credential shape.
    GenericApiKey,
    /// A password field.
    Password,
}

impl SecretKind {
    /// Human-readable label used in the UI and in redaction placeholders.
    pub fn label(&self) -> &'static str {
        match self {
            SecretKind::SupabaseAnonKey => "Supabase anon key",
            SecretKind::SupabaseServiceRoleKey => "Supabase service_role key",
            SecretKind::PostgresConnectionString => "Postgres connection string",
            SecretKind::JwtSecret => "JWT secret",
            SecretKind::GitHubToken => "GitHub token",
            SecretKind::StripeSecretKey => "Stripe secret key",
            SecretKind::OpenAiApiKey => "OpenAI API key",
            SecretKind::AwsAccessKeyId => "AWS access key id",
            SecretKind::AwsSecretAccessKey => "AWS secret access key",
            SecretKind::GenericApiKey => "API key",
            SecretKind::Password => "password",
        }
    }

    /// Whether exposing this value to browser/client code is a security defect.
    ///
    /// Supabase anon keys are explicitly designed to ship to clients; everything
    /// else here grants privileges a client must never hold.
    pub fn is_client_unsafe(&self) -> bool {
        !matches!(self, SecretKind::SupabaseAnonKey)
    }

    /// Which provider this kind implies.
    pub fn provider(&self) -> Provider {
        match self {
            SecretKind::SupabaseAnonKey
            | SecretKind::SupabaseServiceRoleKey
            | SecretKind::JwtSecret => Provider::Supabase,
            SecretKind::PostgresConnectionString => Provider::Postgres,
            SecretKind::GitHubToken => Provider::GitHub,
            SecretKind::StripeSecretKey => Provider::Stripe,
            SecretKind::OpenAiApiKey => Provider::OpenAi,
            SecretKind::AwsAccessKeyId | SecretKind::AwsSecretAccessKey => Provider::Aws,
            SecretKind::GenericApiKey | SecretKind::Password => Provider::Unknown,
        }
    }
}

/// Stored metadata about a secret. The value itself is not in this struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretRecord {
    /// Stable local id.
    pub id: Uuid,
    /// Project this secret belongs to.
    pub project_id: Uuid,
    /// What kind of credential it is.
    pub kind: SecretKind,
    /// The environment-variable style name, e.g. `SUPABASE_SERVICE_ROLE_KEY`.
    pub name: String,
    /// Masked preview, safe for display.
    pub preview: String,
    /// Blind index of the value, used for duplicate detection.
    pub value_blind_index: String,
    /// Environment this secret applies to.
    pub environment: Environment,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// A provider subscription attached to an account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Subscription {
    /// Stable local id.
    pub id: Uuid,
    /// Owning account.
    pub account_id: Uuid,
    /// Plan name as parsed, e.g. "Pro".
    pub plan: String,
    /// Billing status.
    pub status: SubscriptionStatus,
    /// Price in minor units (cents), when parsed.
    pub amount_cents: Option<i64>,
    /// ISO currency code, when parsed.
    pub currency: Option<String>,
    /// Billing interval, when parsed.
    pub interval: Option<BillingInterval>,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Billing status of a subscription.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionStatus {
    /// Paid and current.
    Active,
    /// In a trial period.
    Trialing,
    /// Payment failed.
    PastDue,
    /// Ended.
    Canceled,
    /// Free tier.
    Free,
    /// Could not be determined.
    Unknown,
}

/// How often a subscription bills.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BillingInterval {
    /// Billed monthly.
    Monthly,
    /// Billed yearly.
    Yearly,
}

/// The kinds of node a relation can point at.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    /// An [`Identity`].
    Identity,
    /// An [`Account`].
    Account,
    /// An [`Organization`].
    Organization,
    /// A [`Project`].
    Project,
    /// A [`SecretRecord`].
    Secret,
    /// A [`Subscription`].
    Subscription,
}

/// A typed reference to a stored entity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct EntityRef {
    /// Which table the id lives in.
    pub kind: EntityKind,
    /// The row id.
    pub id: Uuid,
}

impl EntityRef {
    /// Build a reference.
    pub fn new(kind: EntityKind, id: Uuid) -> Self {
        EntityRef { kind, id }
    }
}

/// How two entities relate.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    /// Parent owns child (identity owns account, account owns org, ...).
    Owns,
    /// A secret authenticates against a project.
    AuthenticatesTo,
    /// A subscription bills an account.
    Bills,
    /// Two entities are believed to be the same thing.
    SameAs,
}

/// How confident DevLedger is about an inference, and why.
///
/// The level is set by the deterministic rule that fired; the reason is the
/// human-readable justification shown in the review sheet so a user can
/// disagree with it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceLevel {
    /// The paste literally stated the link (e.g. a JWT's own `ref` claim).
    Explicit,
    /// Two independent signals agreed (e.g. URL ref == JWT ref).
    Strong,
    /// A naming convention implied it (e.g. `NEXT_PUBLIC_SUPABASE_URL`).
    Heuristic,
    /// A single weak signal; shown but never auto-applied.
    Weak,
}

impl EvidenceLevel {
    /// Whether a proposal at this level is pre-selected in the review sheet.
    ///
    /// Weak evidence is always left for the user to opt into.
    pub fn auto_selected(&self) -> bool {
        matches!(
            self,
            EvidenceLevel::Explicit | EvidenceLevel::Strong | EvidenceLevel::Heuristic
        )
    }

    /// Short label for the UI.
    pub fn label(&self) -> &'static str {
        match self {
            EvidenceLevel::Explicit => "Explicit",
            EvidenceLevel::Strong => "Strong",
            EvidenceLevel::Heuristic => "Heuristic",
            EvidenceLevel::Weak => "Weak",
        }
    }
}

/// The justification attached to a relation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Evidence {
    /// How confident the rule is.
    pub level: EvidenceLevel,
    /// Why, in plain language, for display in the review sheet.
    pub reason: String,
    /// Which detector or rule produced this.
    pub rule: String,
}

impl Evidence {
    /// Build an evidence record.
    pub fn new(level: EvidenceLevel, rule: impl Into<String>, reason: impl Into<String>) -> Self {
        Evidence {
            level,
            rule: rule.into(),
            reason: reason.into(),
        }
    }
}

/// A persisted relation between two entities.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Relation {
    /// Stable local id.
    pub id: Uuid,
    /// Source entity.
    pub from: EntityRef,
    /// Target entity.
    pub to: EntityRef,
    /// Relation type.
    pub kind: RelationKind,
    /// Why this relation exists.
    pub evidence: Evidence,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}
