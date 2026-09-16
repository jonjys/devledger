//! Stable string encodings for model enums.
//!
//! These strings are written into the database, so they are part of the on-disk
//! format and must not be renamed casually. They are kept here rather than
//! derived from `serde` so that changing a UI-facing serde rename can never
//! silently invalidate an existing vault.

use crate::error::{CoreError, Result};
use crate::model::{
    BillingInterval, EntityKind, Environment, EvidenceLevel, Provider, RelationKind, SecretKind,
    SubscriptionStatus,
};
use crate::redact::SourceKind;

macro_rules! str_enum {
    ($ty:ty, $to:ident, $from:ident, $( $variant:path => $text:literal ),+ $(,)?) => {
        // The encode/decode pair is the on-disk format contract for this enum.
        // Both halves are kept even when only one currently has a call site.
        #[allow(dead_code)]
        pub(crate) fn $to(value: $ty) -> &'static str {
            match value {
                $( $variant => $text, )+
            }
        }

        #[allow(dead_code)]
        pub(crate) fn $from(text: &str) -> Result<$ty> {
            match text {
                $( $text => Ok($variant), )+
                other => Err(CoreError::Storage(format!(
                    concat!("unknown ", stringify!($ty), " {:?} in database"),
                    other
                ))),
            }
        }
    };
}

str_enum!(
    Provider, provider_to_str, provider_from_str,
    Provider::Supabase => "supabase",
    Provider::Postgres => "postgres",
    Provider::GitHub => "github",
    Provider::Stripe => "stripe",
    Provider::OpenAi => "openai",
    Provider::Aws => "aws",
    Provider::Vercel => "vercel",
    Provider::Unknown => "unknown",
);

str_enum!(
    Environment, environment_to_str, environment_from_str,
    Environment::Development => "development",
    Environment::Staging => "staging",
    Environment::Production => "production",
    Environment::Unknown => "unknown",
);

str_enum!(
    SecretKind, secret_kind_to_str, secret_kind_from_str,
    SecretKind::SupabaseAnonKey => "supabase_anon_key",
    SecretKind::SupabaseServiceRoleKey => "supabase_service_role_key",
    SecretKind::PostgresConnectionString => "postgres_connection_string",
    SecretKind::JwtSecret => "jwt_secret",
    SecretKind::GitHubToken => "github_token",
    SecretKind::StripeSecretKey => "stripe_secret_key",
    SecretKind::OpenAiApiKey => "openai_api_key",
    SecretKind::AwsAccessKeyId => "aws_access_key_id",
    SecretKind::AwsSecretAccessKey => "aws_secret_access_key",
    SecretKind::GenericApiKey => "generic_api_key",
    SecretKind::Password => "password",
);

str_enum!(
    EntityKind, entity_kind_to_str, entity_kind_from_str,
    EntityKind::Identity => "identity",
    EntityKind::Account => "account",
    EntityKind::Organization => "organization",
    EntityKind::ServiceProject => "service_project",
    EntityKind::Project => "project",
    EntityKind::Secret => "secret",
    EntityKind::Subscription => "subscription",
);

str_enum!(
    RelationKind, relation_kind_to_str, relation_kind_from_str,
    RelationKind::Owns => "owns",
    RelationKind::MemberOf => "member_of",
    RelationKind::Contains => "contains",
    RelationKind::UsedBy => "used_by",
    RelationKind::AuthenticatesTo => "authenticates_to",
    RelationKind::Bills => "bills",
    RelationKind::SameAs => "same_as",
);

str_enum!(
    EvidenceLevel, evidence_level_to_str, evidence_level_from_str,
    EvidenceLevel::Explicit => "explicit",
    EvidenceLevel::Strong => "strong",
    EvidenceLevel::Heuristic => "heuristic",
    EvidenceLevel::Weak => "weak",
);

str_enum!(
    SubscriptionStatus, subscription_status_to_str, subscription_status_from_str,
    SubscriptionStatus::Active => "active",
    SubscriptionStatus::Trialing => "trialing",
    SubscriptionStatus::PastDue => "past_due",
    SubscriptionStatus::Canceled => "canceled",
    SubscriptionStatus::Free => "free",
    SubscriptionStatus::Unknown => "unknown",
);

str_enum!(
    BillingInterval, billing_interval_to_str, billing_interval_from_str,
    BillingInterval::Monthly => "monthly",
    BillingInterval::Yearly => "yearly",
);

str_enum!(
    SourceKind, source_kind_to_str, source_kind_from_str,
    SourceKind::SmartPaste => "smart_paste",
    SourceKind::EnvFile => "env_file",
    SourceKind::Manual => "manual",
);
