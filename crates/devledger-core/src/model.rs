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
    /// The address this account signs in with, when it differs from the
    /// identity's primary address.
    ///
    /// Separate from the identity's email on purpose: one person often signs in
    /// to different services with different addresses, and flattening the two
    /// would either lose that or split the person into several identities.
    pub login_email: Option<String>,
    /// The username this account signs in with, for services that use one.
    pub username: Option<String>,
    /// Where to sign in.
    pub url: Option<String>,
    /// Free-text note. Never put a credential here: it is not treated as one.
    pub notes: Option<String>,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// One email address belonging to an identity.
///
/// An identity is a person, not an address. Keeping addresses in their own
/// table is what lets one person hold accounts under several of them without
/// becoming several people in the map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityEmail {
    /// Stable local id.
    pub id: Uuid,
    /// Which identity this address belongs to.
    pub identity_id: Uuid,
    /// The address itself, lowercased.
    pub address: String,
    /// Blind index over the address, for duplicate detection.
    pub blind_index: String,
    /// Whether this is the address shown as the identity's own.
    pub is_primary: bool,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A field the user named themselves: a label and the value that goes with it.
///
/// For anything no built-in field covers -- a customer number, a support PIN,
/// the username on a forum. Shown in the clear; a sensitive value belongs in a
/// secret instead, where it is sealed and only shown on Reveal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomField {
    /// Stable local id.
    pub id: Uuid,
    /// What the field is attached to.
    pub entity: EntityRef,
    /// The name the user gave the field.
    pub label: String,
    /// Its value.
    pub value: String,
    /// Display order among the entity's fields.
    pub position: i64,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
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

/// A resource inside a provider: a Supabase project, a Vercel project, a GitHub
/// repo, a Stripe account's dashboard.
///
/// This is **not** the thing a developer calls "my project". It is the
/// provider-side object that a [`Project`] uses. Keeping the two apart is what
/// lets one DevLedger project draw on a Supabase project, a Vercel project and
/// a Stripe account at once, and lets one Supabase project be shared by two
/// DevLedger projects.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceProject {
    /// Stable local id.
    pub id: Uuid,
    /// The provider account this lives under.
    pub account_id: Uuid,
    /// The organization it belongs to, when that is known.
    ///
    /// `None` means unassigned. DevLedger never invents an organization to fill
    /// this in; an unassigned resource is surfaced under Needs attention
    /// instead.
    pub organization_id: Option<Uuid>,
    /// Which provider.
    pub provider: Provider,
    /// Provider-side reference, e.g. a Supabase project ref or a repo slug.
    pub provider_ref: Option<String>,
    /// Display name.
    pub name: String,
    /// Deployment region, when known.
    pub region: Option<String>,
    /// Which environment this resource represents.
    pub environment: Environment,
    /// Where this resource lives, for a service with no connector.
    pub url: Option<String>,
    /// Free-text note. Never put a credential here.
    pub notes: Option<String>,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A DevLedger project: the thing a developer actually works on.
///
/// It has no provider of its own. It is given meaning by the
/// [`ServiceProject`]s linked to it and the secrets filed against it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    /// Stable local id.
    pub id: Uuid,
    /// What the developer calls it, e.g. "Curl-to-Buy".
    pub name: String,
    /// Optional free-text note.
    pub description: Option<String>,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A service an account can be held with.
///
/// The named variants are the ones DevLedger can recognise from a paste or
/// reach with a connector. [`Provider::Other`] carries anything else by name,
/// because a developer's accounts are not limited to the services this program
/// happens to know about: a hosting panel, a bank, a domain registrar and a
/// hobby forum all belong in the ledger on the same terms.
///
/// # Wire and storage format
///
/// One string, used both on disk and over IPC: the named variants keep their
/// snake_case spelling, and [`Provider::Other`] is `other:<name>`. Having a
/// single encoding means a value read from the database and a value received
/// from the UI cannot disagree. Unrecognised text decodes to
/// [`Provider::Other`] rather than failing, so a vault touched by a newer build
/// still opens.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
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
    /// Anthropic.
    Anthropic,
    /// A service DevLedger has no built-in knowledge of, named by the user.
    Other(String),
    /// Anything recognised as a credential but not attributable.
    Unknown,
}

/// The `other:` prefix that marks a user-named service on disk and over IPC.
const OTHER_PREFIX: &str = "other:";

impl Provider {
    /// Human-readable provider name.
    pub fn label(&self) -> &str {
        match self {
            Provider::Supabase => "Supabase",
            Provider::Postgres => "Postgres",
            Provider::GitHub => "GitHub",
            Provider::Stripe => "Stripe",
            Provider::OpenAi => "OpenAI",
            Provider::Aws => "AWS",
            Provider::Vercel => "Vercel",
            Provider::Anthropic => "Anthropic",
            Provider::Other(name) => name,
            Provider::Unknown => "Unknown",
        }
    }

    /// The stable string form used on disk and over IPC.
    pub fn as_key(&self) -> String {
        match self {
            Provider::Supabase => "supabase".to_string(),
            Provider::Postgres => "postgres".to_string(),
            Provider::GitHub => "github".to_string(),
            Provider::Stripe => "stripe".to_string(),
            Provider::OpenAi => "openai".to_string(),
            Provider::Aws => "aws".to_string(),
            Provider::Vercel => "vercel".to_string(),
            Provider::Anthropic => "anthropic".to_string(),
            Provider::Other(name) => format!("{OTHER_PREFIX}{name}"),
            Provider::Unknown => "unknown".to_string(),
        }
    }

    /// Parse the string form. Never fails: anything unrecognised is a service
    /// DevLedger does not know, which is a fact about DevLedger, not an error.
    ///
    /// Tolerant on purpose. The database only ever holds the lowercase keys
    /// [`Self::as_key`] writes, but values also arrive over IPC, and a UI that
    /// sends "Supabase" or an older build's `git_hub` must still land on the
    /// provider DevLedger knows rather than on a look-alike custom service.
    pub fn from_key(text: &str) -> Provider {
        match text.strip_prefix(OTHER_PREFIX) {
            Some(name) => match name.trim() {
                "" => Provider::Unknown,
                named => Provider::Other(named.to_string()),
            },
            None => Provider::from_user_input(text),
        }
    }

    /// Build a provider from what a user typed in the "service" box.
    ///
    /// A name that matches one DevLedger knows resolves to that variant, so
    /// typing "Supabase" by hand and discovering it through the connector end
    /// up as the same provider rather than two look-alikes.
    pub fn from_user_input(text: &str) -> Provider {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Provider::Unknown;
        }
        match trimmed.to_ascii_lowercase().as_str() {
            "supabase" => Provider::Supabase,
            "postgres" | "postgresql" => Provider::Postgres,
            "github" | "git_hub" => Provider::GitHub,
            "stripe" => Provider::Stripe,
            "openai" | "open_ai" => Provider::OpenAi,
            "aws" | "amazon web services" => Provider::Aws,
            "vercel" => Provider::Vercel,
            "anthropic" => Provider::Anthropic,
            "unknown" => Provider::Unknown,
            _ => Provider::Other(trimmed.to_string()),
        }
    }

    /// Whether this is a service the user named rather than one DevLedger knows.
    pub fn is_custom(&self) -> bool {
        matches!(self, Provider::Other(_))
    }
}

impl Serialize for Provider {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.as_key())
    }
}

impl<'de> Deserialize<'de> for Provider {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Ok(Provider::from_key(&text))
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
    ///
    /// `rename_all = "snake_case"` splits GitHub into `git_hub_token`, which is
    /// not what the database or the frontend call it. The wire name is pinned to
    /// `github_token`; the old spelling is still accepted inbound.
    #[serde(rename = "github_token", alias = "git_hub_token")]
    GitHubToken,
    /// Stripe secret key.
    StripeSecretKey,
    /// OpenAI API key. Pinned to `openai_api_key` for the same reason;
    /// `open_ai_api_key` is still accepted inbound.
    #[serde(rename = "openai_api_key", alias = "open_ai_api_key")]
    OpenAiApiKey,
    /// AWS access key id (paired with a secret access key).
    AwsAccessKeyId,
    /// AWS secret access key.
    AwsSecretAccessKey,
    /// Something that matched a generic credential shape.
    GenericApiKey,
    /// A password field.
    Password,
    /// A configuration value the user filed by hand.
    ///
    /// DevLedger has no way to tell whether a value a user typed is sensitive,
    /// so it is stored encrypted like everything else and treated as unsafe to
    /// expose to client code until the user says otherwise.
    EnvVar,
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
            SecretKind::EnvVar => "environment variable",
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
            SecretKind::GenericApiKey | SecretKind::Password | SecretKind::EnvVar => {
                Provider::Unknown
            }
        }
    }
}

/// Stored metadata about a secret. The value itself is not in this struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretRecord {
    /// Stable local id.
    pub id: Uuid,
    /// The DevLedger project this secret is filed under, when one is known.
    pub project_id: Option<Uuid>,
    /// The provider resource this secret authenticates to, when one is known.
    ///
    /// At least one of `project_id`, `service_project_id` and `account_id` is
    /// always set, so no secret is filed against nothing.
    pub service_project_id: Option<Uuid>,
    /// The account this secret belongs to, for a login password or a token that
    /// is a property of the account rather than of one resource.
    pub account_id: Option<Uuid>,
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
    /// Free-text note. Never put a credential here.
    pub notes: Option<String>,
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
    /// When a trial ends, if the excerpt stated an ISO date.
    pub trial_ends_at: Option<String>,
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
    /// A [`ServiceProject`].
    ServiceProject,
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
    /// An identity owns a provider account.
    Owns,
    /// An account is a member of an organization.
    MemberOf,
    /// An organization contains a service project.
    Contains,
    /// A service project is used by a DevLedger project.
    UsedBy,
    /// A secret authenticates against a service project.
    AuthenticatesTo,
    /// A subscription bills an account.
    Bills,
    /// Two entities are believed to be the same thing.
    SameAs,
    /// A person works on a DevLedger project.
    ///
    /// Beside the accounts a project runs on, never above them: the email is
    /// not the project's parent, it is one of the people behind it.
    WorksOn,
}

impl RelationKind {
    /// Human-readable verb for the review sheet and the map.
    pub fn label(&self) -> &'static str {
        match self {
            RelationKind::Owns => "owns",
            RelationKind::MemberOf => "is a member of",
            RelationKind::Contains => "contains",
            RelationKind::UsedBy => "is used by",
            RelationKind::AuthenticatesTo => "authenticates to",
            RelationKind::Bills => "bills",
            RelationKind::SameAs => "is the same as",
            RelationKind::WorksOn => "works on",
        }
    }
}

/// How confident DevLedger is about an inference, and why.
///
/// The level is set by the deterministic rule that fired; the reason is the
/// human-readable justification shown in the review sheet so a user can
/// disagree with it.
///
/// # Ordering
///
/// Variants are declared **most confident first**, so the derived [`Ord`] runs
/// backwards from intuition: `Explicit < Strong < Heuristic < Weak`. Comparing
/// with `>=` to mean "at least this confident" is therefore wrong. Use
/// [`EvidenceLevel::is_at_least`] and [`EvidenceLevel::weaker_of`] instead of
/// comparing directly.
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
    /// Whether this level is at least as confident as `floor`.
    ///
    /// Reads the way the name suggests, unlike the raw comparison operators.
    pub fn is_at_least(&self, floor: EvidenceLevel) -> bool {
        *self <= floor
    }

    /// The less confident of two levels.
    ///
    /// A chain of inferences is only as good as its weakest link, so this is
    /// what combines them.
    pub fn weaker_of(a: EvidenceLevel, b: EvidenceLevel) -> EvidenceLevel {
        a.max(b)
    }

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

#[cfg(test)]
mod provider_tests {
    use super::Provider;

    #[test]
    fn every_known_provider_round_trips_through_its_key() {
        for p in [
            Provider::Supabase,
            Provider::Postgres,
            Provider::GitHub,
            Provider::Stripe,
            Provider::OpenAi,
            Provider::Aws,
            Provider::Vercel,
            Provider::Anthropic,
            Provider::Unknown,
            Provider::Other("Loopia".into()),
            Provider::Other("My NAS".into()),
        ] {
            assert_eq!(Provider::from_key(&p.as_key()), p, "{p:?}");
        }
    }

    #[test]
    fn the_on_disk_keys_are_unchanged() {
        // Existing vaults store these exact strings. Changing one would turn
        // every existing account with that provider into a custom service.
        assert_eq!(Provider::GitHub.as_key(), "github");
        assert_eq!(Provider::OpenAi.as_key(), "openai");
        assert_eq!(Provider::Supabase.as_key(), "supabase");
    }

    #[test]
    fn a_known_name_typed_in_any_case_is_the_known_provider() {
        assert_eq!(Provider::from_key("Supabase"), Provider::Supabase);
        assert_eq!(Provider::from_key("GitHub"), Provider::GitHub);
        assert_eq!(Provider::from_key("git_hub"), Provider::GitHub);
        assert_eq!(Provider::from_key("open_ai"), Provider::OpenAi);
    }

    #[test]
    fn a_custom_service_named_like_a_known_one_stays_custom_when_marked() {
        // `other:` is explicit; it is never reinterpreted.
        assert_eq!(
            Provider::from_key("other:supabase"),
            Provider::Other("supabase".into())
        );
        assert_eq!(Provider::from_key("other:"), Provider::Unknown);
    }

    #[test]
    fn serde_uses_the_same_string_as_storage() {
        let json = serde_json::to_string(&Provider::Other("Loopia".into())).unwrap();
        assert_eq!(json, "\"other:Loopia\"");
        let back: Provider = serde_json::from_str("\"github\"").unwrap();
        assert_eq!(back, Provider::GitHub);
    }
}
