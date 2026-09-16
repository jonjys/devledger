//! Secret redaction and paste provenance.
//!
//! DevLedger keeps a short excerpt of every paste so a user can later remember
//! where a credential came from. That excerpt must never contain the credential
//! itself, so it goes through two passes:
//!
//! 1. **Span redaction** -- every byte range the detectors flagged as secret is
//!    replaced by a typed placeholder.
//! 2. **Sweep redaction** -- a set of standalone patterns runs over whatever is
//!    left, catching credential shapes the detectors did not attribute to an
//!    entity.
//!
//! The second pass is what makes this safe against detector gaps: an unknown
//! token that merely *looks* like a key is still removed from the excerpt.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::model::SecretKind;

/// Maximum number of characters kept in a stored excerpt.
pub const MAX_EXCERPT_CHARS: usize = 600;

/// A byte range in the pasted text that holds a secret value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretSpan {
    /// Inclusive byte offset where the secret starts.
    pub start: usize,
    /// Exclusive byte offset where the secret ends.
    pub end: usize,
    /// What kind of secret it is, used to label the placeholder.
    pub kind: SecretKind,
}

/// Where a paste came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Typed or pasted into the global Smart Paste box.
    SmartPaste,
    /// Read from a `.env` style file.
    EnvFile,
    /// Entered by hand in a form.
    Manual,
}

/// The auditable, secret-free record of where data came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Provenance {
    /// Fully redacted excerpt of the original paste.
    pub redacted_excerpt: String,
    /// How the text arrived.
    pub source: SourceKind,
    /// Number of characters in the original text, before truncation.
    pub original_len: usize,
    /// When it was captured.
    #[serde(with = "time::serde::rfc3339")]
    pub captured_at: OffsetDateTime,
}

/// Replace every flagged span with a typed placeholder, then sweep the rest.
///
/// Spans are applied back-to-front so earlier offsets stay valid.
pub fn redact(text: &str, spans: &[SecretSpan]) -> String {
    let mut ordered: Vec<&SecretSpan> = spans.iter().collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.start));

    let mut out = text.to_string();
    let mut last_start = usize::MAX;
    for span in ordered {
        // Guard against overlapping or out-of-bounds spans from a buggy detector.
        if span.end > out.len() || span.start >= span.end || span.end > last_start {
            continue;
        }
        if !out.is_char_boundary(span.start) || !out.is_char_boundary(span.end) {
            continue;
        }
        out.replace_range(span.start..span.end, &placeholder(span.kind));
        last_start = span.start;
    }
    sweep(&out)
}

/// Build a redacted [`Provenance`] from raw text and the detected spans.
pub fn provenance(text: &str, spans: &[SecretSpan], source: SourceKind) -> Provenance {
    let redacted = redact(text, spans);
    Provenance {
        redacted_excerpt: truncate_chars(&redacted, MAX_EXCERPT_CHARS),
        source,
        original_len: text.chars().count(),
        captured_at: OffsetDateTime::now_utc(),
    }
}

fn placeholder(kind: SecretKind) -> String {
    format!(
        "[REDACTED:{}]",
        kind.label().to_uppercase().replace(' ', "_")
    )
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

/// Patterns applied as a safety net after span redaction.
///
/// Ordered most specific first so a Supabase JWT is not swallowed by the
/// generic long-token rule.
static SWEEP_PATTERNS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    let patterns: Vec<(&str, &str)> = vec![
        // JWTs (Supabase legacy anon/service_role keys are JWTs).
        (
            r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}",
            "[REDACTED:JWT]",
        ),
        // Supabase new-style publishable/secret keys.
        (
            r"sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}",
            "[REDACTED:SUPABASE_KEY]",
        ),
        // Password inside a URL userinfo section.
        (
            r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]+):[^\s@/]+@",
            "$1:[REDACTED:PASSWORD]@",
        ),
        // GitHub tokens.
        (r"gh[pousr]_[A-Za-z0-9]{16,}", "[REDACTED:GITHUB_TOKEN]"),
        // Stripe secret / restricted keys.
        (
            r"sk_(?:live|test)_[A-Za-z0-9]{10,}",
            "[REDACTED:STRIPE_KEY]",
        ),
        (
            r"rk_(?:live|test)_[A-Za-z0-9]{10,}",
            "[REDACTED:STRIPE_KEY]",
        ),
        // OpenAI keys.
        (r"sk-[A-Za-z0-9_-]{20,}", "[REDACTED:OPENAI_API_KEY]"),
        // AWS access key ids.
        (
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            "[REDACTED:AWS_ACCESS_KEY_ID]",
        ),
        // Anything assigned to a suspiciously named variable.
        (
            r"(?im)^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)\S+",
            "$1[REDACTED:VALUE]",
        ),
    ];
    patterns
        .into_iter()
        .map(|(p, r)| (Regex::new(p).expect("sweep pattern must compile"), r))
        .collect()
});

/// Run the standalone credential patterns over `text`.
///
/// Exposed so callers can redact text that never went through the detectors.
pub fn sweep(text: &str) -> String {
    let mut out = text.to_string();
    for (re, replacement) in SWEEP_PATTERNS.iter() {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}
