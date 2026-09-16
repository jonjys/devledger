//! Deterministic entity detection.
//!
//! Every detector here is a pure function of the input text: same paste in,
//! byte-identical analysis out, no model, no network, no clock (the one
//! time-dependent check, JWT expiry, takes `now` as a parameter). That property
//! is what M2 called "deterministic Smart Paste" and the tests assert it
//! directly.
//!
//! Detectors run in a fixed order and results are sorted by their position in
//! the source text, so ordering is stable across runs and platforms.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::model::{Environment, Evidence, EvidenceLevel, Provider, SecretKind};
use crate::secret::{mask_preview, SecretString};

use super::jwt;

/// What a detector recognised.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DetectedKind {
    /// A credential. Its value is withheld from the UI.
    Secret,
    /// A Supabase project reference.
    ProjectRef,
    /// A provider API URL.
    ProjectUrl,
    /// An email address.
    Email,
    /// A non-secret environment variable.
    EnvVar,
    /// A subscription plan line.
    SubscriptionPlan,
    /// A deployment region.
    Region,
}

/// One thing found in a paste.
///
/// `value_preview` is always safe to display: for secrets it is masked by
/// [`mask_preview`], for everything else it is the literal value. The plaintext
/// of a secret lives only in the staging area inside Rust.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DetectedEntity {
    /// Index of this entity within its analysis. Stable for a given input.
    pub index: usize,
    /// What was recognised.
    pub kind: DetectedKind,
    /// Variable name or descriptive label.
    pub label: String,
    /// Display-safe rendering of the value.
    pub value_preview: String,
    /// For secrets, which kind of credential.
    pub secret_kind: Option<SecretKind>,
    /// Which provider this points at.
    pub provider: Provider,
    /// Which environment it belongs to.
    pub environment: Environment,
    /// Project reference carried by this entity, when it has one.
    pub project_ref: Option<String>,
    /// Why the detector believes this.
    pub evidence: Evidence,
}

impl DetectedEntity {
    /// Whether this entity's value is withheld from the frontend.
    pub fn is_secret(&self) -> bool {
        self.kind == DetectedKind::Secret
    }
}

/// A detected entity together with the plaintext that must stay in Rust.
#[derive(Debug, Clone)]
pub struct Detection {
    /// The display-safe entity.
    pub entity: DetectedEntity,
    /// The plaintext value, present only for secrets.
    pub secret_value: Option<SecretString>,
    /// Byte range of the value in the source text, used for redaction.
    pub span: (usize, usize),
}

static ENV_LINE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([^\r\n]*)")
        .expect("env line pattern must compile")
});

static SUPABASE_API_URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"https://([a-z]{20})\.supabase\.(?:co|in)")
        .expect("supabase url pattern must compile")
});

static SUPABASE_DASHBOARD_URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"https://supabase\.com/dashboard/project/([a-z]{20})")
        .expect("dashboard url pattern must compile")
});

static EMAIL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
        .expect("email pattern must compile")
});

static BARE_TOKEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}
      | sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}
      | gh[pousr]_[A-Za-z0-9]{16,}
      | (?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}
      | sk-[A-Za-z0-9_-]{20,}
      | \b(?:AKIA|ASIA)[0-9A-Z]{16}\b
      | postgres(?:ql)?://[^\s\x22']+
    ",
    )
    .expect("bare token pattern must compile")
});

/// Supabase pooler host, which carries the project ref in the username.
static POOLER_USER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"postgres(?:ql)?://postgres\.([a-z]{20}):")
        .expect("pooler user pattern must compile")
});

/// Direct database host `db.<ref>.supabase.co`.
static DIRECT_DB_HOST: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"@db\.([a-z]{20})\.supabase\.(?:co|in)")
        .expect("direct db host pattern must compile")
});

/// Strip surrounding quotes and a trailing `# comment` from an env value.
fn clean_env_value(raw: &str) -> &str {
    let mut v = raw.trim();
    if v.len() >= 2 {
        let b = v.as_bytes();
        if (b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\'') {
            return v[1..v.len() - 1].trim();
        }
    }
    // Only treat `#` as a comment when it is preceded by whitespace, so that a
    // value which legitimately contains `#` (a URL fragment, a password) survives.
    if let Some(pos) = v.find(" #") {
        v = v[..pos].trim();
    }
    v
}

/// Classify a raw value into a [`SecretKind`], using the variable name as a
/// tiebreaker only when the value itself is not self-describing.
pub fn classify_value(name: Option<&str>, value: &str) -> Option<(SecretKind, Evidence)> {
    if value.is_empty() {
        return None;
    }

    if jwt::looks_like_jwt(value) {
        if let Some(claims) = jwt::decode_claims(value) {
            let is_supabase = claims.iss.as_deref() == Some("supabase");
            match claims.role.as_deref() {
                Some("service_role") => {
                    return Some((
                        SecretKind::SupabaseServiceRoleKey,
                        Evidence::new(
                            EvidenceLevel::Explicit,
                            "jwt.role",
                            "JWT payload declares role=service_role",
                        ),
                    ));
                }
                Some("anon") => {
                    return Some((
                        SecretKind::SupabaseAnonKey,
                        Evidence::new(
                            EvidenceLevel::Explicit,
                            "jwt.role",
                            "JWT payload declares role=anon",
                        ),
                    ));
                }
                _ if is_supabase => {
                    return Some((
                        SecretKind::JwtSecret,
                        Evidence::new(
                            EvidenceLevel::Strong,
                            "jwt.iss",
                            "JWT issued by Supabase with an unrecognised role",
                        ),
                    ));
                }
                _ => {}
            }
        }
        return Some((
            SecretKind::JwtSecret,
            Evidence::new(
                EvidenceLevel::Heuristic,
                "jwt.shape",
                "Value has the three-segment shape of a JWT",
            ),
        ));
    }

    let prefix_match = [
        (
            "sb_secret_",
            SecretKind::SupabaseServiceRoleKey,
            "Supabase secret key prefix",
        ),
        (
            "sb_publishable_",
            SecretKind::SupabaseAnonKey,
            "Supabase publishable key prefix",
        ),
        (
            "ghp_",
            SecretKind::GitHubToken,
            "GitHub personal access token prefix",
        ),
        ("gho_", SecretKind::GitHubToken, "GitHub OAuth token prefix"),
        ("ghu_", SecretKind::GitHubToken, "GitHub user token prefix"),
        (
            "ghs_",
            SecretKind::GitHubToken,
            "GitHub server token prefix",
        ),
        (
            "ghr_",
            SecretKind::GitHubToken,
            "GitHub refresh token prefix",
        ),
        (
            "sk_live_",
            SecretKind::StripeSecretKey,
            "Stripe live secret key prefix",
        ),
        (
            "sk_test_",
            SecretKind::StripeSecretKey,
            "Stripe test secret key prefix",
        ),
        (
            "rk_live_",
            SecretKind::StripeSecretKey,
            "Stripe restricted key prefix",
        ),
        (
            "rk_test_",
            SecretKind::StripeSecretKey,
            "Stripe restricted key prefix",
        ),
        ("sk-", SecretKind::OpenAiApiKey, "OpenAI API key prefix"),
    ];
    for (prefix, kind, reason) in prefix_match {
        if value.starts_with(prefix) {
            return Some((
                kind,
                Evidence::new(EvidenceLevel::Explicit, "prefix", reason),
            ));
        }
    }

    if value.starts_with("postgres://") || value.starts_with("postgresql://") {
        // Only a connection string carrying a password is a secret.
        if POOLER_USER.is_match(value) || value.contains(":") && value.contains('@') {
            return Some((
                SecretKind::PostgresConnectionString,
                Evidence::new(
                    EvidenceLevel::Explicit,
                    "url.scheme",
                    "Postgres connection URL containing credentials",
                ),
            ));
        }
    }

    if (value.starts_with("AKIA") || value.starts_with("ASIA"))
        && value.len() == 20
        && value[4..]
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Some((
            SecretKind::AwsAccessKeyId,
            Evidence::new(
                EvidenceLevel::Explicit,
                "prefix",
                "AWS access key id prefix and length",
            ),
        ));
    }

    // Fall back to the variable name.
    let upper = name?.to_ascii_uppercase();
    if upper.contains("AWS_SECRET_ACCESS_KEY") {
        return Some((
            SecretKind::AwsSecretAccessKey,
            Evidence::new(
                EvidenceLevel::Strong,
                "name",
                "Variable is the AWS secret access key",
            ),
        ));
    }
    if upper.contains("PASSWORD") || upper.ends_with("_PWD") {
        return Some((
            SecretKind::Password,
            Evidence::new(
                EvidenceLevel::Heuristic,
                "name",
                "Variable name implies a password",
            ),
        ));
    }
    if upper.contains("SECRET")
        || upper.contains("TOKEN")
        || upper.contains("API_KEY")
        || upper.contains("APIKEY")
        || upper.ends_with("_KEY")
    {
        return Some((
            SecretKind::GenericApiKey,
            Evidence::new(
                EvidenceLevel::Heuristic,
                "name",
                "Variable name implies a credential",
            ),
        ));
    }
    None
}

/// Infer an environment from a variable name.
///
/// `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_` prefixes mean the value is compiled into
/// client bundles; that is not an environment as such, but it is exactly the
/// signal the client-exposure warning needs, so it is surfaced here too.
pub fn is_client_exposed_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("NEXT_PUBLIC_")
        || upper.starts_with("VITE_")
        || upper.starts_with("PUBLIC_")
        || upper.starts_with("REACT_APP_")
        || upper.starts_with("EXPO_PUBLIC_")
        || upper.starts_with("NUXT_PUBLIC_")
        || upper.starts_with("GATSBY_")
}

/// Infer the deployment environment from a variable name.
pub fn environment_from_name(name: &str) -> Environment {
    let upper = name.to_ascii_uppercase();
    if upper.contains("PROD") {
        Environment::Production
    } else if upper.contains("STAGING") || upper.contains("PREVIEW") {
        Environment::Staging
    } else if upper.contains("DEV") || upper.contains("LOCAL") {
        Environment::Development
    } else {
        Environment::Unknown
    }
}

/// Extract a Supabase project ref from a connection string or URL.
pub fn project_ref_from_value(value: &str) -> Option<String> {
    if let Some(c) = POOLER_USER.captures(value) {
        return Some(c[1].to_string());
    }
    if let Some(c) = DIRECT_DB_HOST.captures(value) {
        return Some(c[1].to_string());
    }
    if let Some(c) = SUPABASE_API_URL.captures(value) {
        return Some(c[1].to_string());
    }
    if let Some(c) = SUPABASE_DASHBOARD_URL.captures(value) {
        return Some(c[1].to_string());
    }
    None
}

/// Run every detector over `text` and return detections ordered by position.
pub fn detect_all(text: &str) -> Vec<Detection> {
    let mut found: Vec<Detection> = Vec::new();
    // Byte ranges already claimed, so a bare-token sweep does not re-report a
    // value that an env assignment already captured.
    let mut claimed: Vec<(usize, usize)> = Vec::new();

    detect_env_assignments(text, &mut found, &mut claimed);
    detect_bare_tokens(text, &mut found, &mut claimed);
    detect_urls(text, &mut found, &mut claimed);
    detect_emails(text, &mut found, &mut claimed);

    found.sort_by_key(|d| (d.span.0, d.span.1));
    for (i, d) in found.iter_mut().enumerate() {
        d.entity.index = i;
    }
    found
}

fn overlaps(claimed: &[(usize, usize)], span: (usize, usize)) -> bool {
    claimed.iter().any(|(s, e)| span.0 < *e && *s < span.1)
}

fn detect_env_assignments(
    text: &str,
    found: &mut Vec<Detection>,
    claimed: &mut Vec<(usize, usize)>,
) {
    for caps in ENV_LINE.captures_iter(text) {
        let name_m = caps.get(1).expect("group 1 always present");
        let raw_m = caps.get(2).expect("group 2 always present");
        let name = name_m.as_str();
        let raw = raw_m.as_str();
        let cleaned = clean_env_value(raw);
        if cleaned.is_empty() {
            continue;
        }
        // Locate the cleaned value inside the raw match so spans stay exact.
        let offset = raw.find(cleaned).unwrap_or(0);
        let span = (
            raw_m.start() + offset,
            raw_m.start() + offset + cleaned.len(),
        );

        let environment = environment_from_name(name);
        let project_ref = project_ref_from_value(cleaned)
            .or_else(|| jwt::decode_claims(cleaned).and_then(|c| c.r#ref));

        match classify_value(Some(name), cleaned) {
            Some((kind, evidence)) => {
                claimed.push(span);
                found.push(Detection {
                    entity: DetectedEntity {
                        index: 0,
                        kind: DetectedKind::Secret,
                        label: name.to_string(),
                        value_preview: mask_preview(cleaned),
                        secret_kind: Some(kind),
                        provider: kind.provider(),
                        environment,
                        project_ref,
                        evidence,
                    },
                    secret_value: Some(SecretString::new(cleaned)),
                    span,
                });
            }
            None => {
                claimed.push(span);
                found.push(Detection {
                    entity: DetectedEntity {
                        index: 0,
                        kind: DetectedKind::EnvVar,
                        label: name.to_string(),
                        value_preview: cleaned.to_string(),
                        secret_kind: None,
                        provider: if project_ref.is_some() {
                            Provider::Supabase
                        } else {
                            Provider::Unknown
                        },
                        environment,
                        project_ref,
                        evidence: Evidence::new(
                            EvidenceLevel::Explicit,
                            "env.assignment",
                            "Plain environment variable assignment",
                        ),
                    },
                    secret_value: None,
                    span,
                });
            }
        }
    }
}

fn detect_bare_tokens(text: &str, found: &mut Vec<Detection>, claimed: &mut Vec<(usize, usize)>) {
    for m in BARE_TOKEN.find_iter(text) {
        let span = (m.start(), m.end());
        if overlaps(claimed, span) {
            continue;
        }
        let value = m.as_str();
        let Some((kind, evidence)) = classify_value(None, value) else {
            continue;
        };
        let project_ref = project_ref_from_value(value)
            .or_else(|| jwt::decode_claims(value).and_then(|c| c.r#ref));
        claimed.push(span);
        found.push(Detection {
            entity: DetectedEntity {
                index: 0,
                kind: DetectedKind::Secret,
                label: kind.label().to_string(),
                value_preview: mask_preview(value),
                secret_kind: Some(kind),
                provider: kind.provider(),
                environment: Environment::Unknown,
                project_ref,
                evidence,
            },
            secret_value: Some(SecretString::new(value)),
            span,
        });
    }
}

fn detect_urls(text: &str, found: &mut Vec<Detection>, claimed: &mut Vec<(usize, usize)>) {
    for (re, label, reason) in [
        (
            &*SUPABASE_API_URL,
            "Supabase API URL",
            "Hostname matches <ref>.supabase.co",
        ),
        (
            &*SUPABASE_DASHBOARD_URL,
            "Supabase dashboard URL",
            "Dashboard URL contains the project ref",
        ),
    ] {
        for caps in re.captures_iter(text) {
            let whole = caps.get(0).expect("group 0 always present");
            let span = (whole.start(), whole.end());
            if overlaps(claimed, span) {
                continue;
            }
            claimed.push(span);
            let project_ref = caps[1].to_string();
            found.push(Detection {
                entity: DetectedEntity {
                    index: 0,
                    kind: DetectedKind::ProjectUrl,
                    label: label.to_string(),
                    value_preview: whole.as_str().to_string(),
                    secret_kind: None,
                    provider: Provider::Supabase,
                    environment: Environment::Unknown,
                    project_ref: Some(project_ref),
                    evidence: Evidence::new(EvidenceLevel::Explicit, "url", reason),
                },
                secret_value: None,
                span,
            });
        }
    }
}

fn detect_emails(text: &str, found: &mut Vec<Detection>, claimed: &mut Vec<(usize, usize)>) {
    for m in EMAIL.find_iter(text) {
        let span = (m.start(), m.end());
        if overlaps(claimed, span) {
            continue;
        }
        claimed.push(span);
        found.push(Detection {
            entity: DetectedEntity {
                index: 0,
                kind: DetectedKind::Email,
                label: "Email".to_string(),
                value_preview: m.as_str().to_string(),
                secret_kind: None,
                provider: Provider::Unknown,
                environment: Environment::Unknown,
                project_ref: None,
                evidence: Evidence::new(
                    EvidenceLevel::Explicit,
                    "email",
                    "Value has the shape of an email address",
                ),
            },
            secret_value: None,
            span,
        });
    }
}
