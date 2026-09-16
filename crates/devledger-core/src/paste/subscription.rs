//! Deterministic subscription / billing parsing.
//!
//! Developers routinely paste a chunk of a provider billing page. This module
//! pulls out the plan, status, price and interval with plain regexes so the
//! account can be annotated without asking the user to retype it.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::model::{BillingInterval, SubscriptionStatus};

/// What [`parse`] recovers from a billing excerpt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParsedSubscription {
    /// Plan name, normalised to title case, e.g. `Pro`.
    pub plan: String,
    /// Billing status.
    pub status: SubscriptionStatus,
    /// Price in minor units, when a price was present.
    pub amount_cents: Option<i64>,
    /// ISO currency code, when a currency symbol was present.
    pub currency: Option<String>,
    /// Billing interval, when stated.
    pub interval: Option<BillingInterval>,
    /// When a trial ends, if the excerpt gave an ISO date.
    pub trial_ends_at: Option<String>,
}

static PLAN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(free|pro|team|enterprise|hobby|starter|scale|business)\b[ \t]*(?:plan|tier)?",
    )
    .expect("plan pattern must compile")
});

static PRICE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)([$€£])\s*([0-9]+(?:[.,][0-9]{1,2})?)").expect("price pattern must compile")
});

static INTERVAL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:per|/|a)\s*(month|mo\b|year|yr\b|annually|monthly|yearly)")
        .expect("interval pattern must compile")
});

/// `trial ends 2026-10-01`, `trial expires on 2026-10-01`, `free until 2026-10-01`.
///
/// Only ISO dates are accepted: parsing prose dates would make the result
/// locale-dependent, and Smart Paste has to stay deterministic.
static TRIAL_END: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:trial\s+(?:ends?|expires?)|free)\s*(?:on|until|:)?\s*(\d{4}-\d{2}-\d{2})")
        .expect("trial end pattern must compile")
});

static STATUS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(active|trialing|trial|past[ _-]?due|canceled|cancelled|unpaid|incomplete)\b",
    )
    .expect("status pattern must compile")
});

/// Parse a billing excerpt. Returns `None` when no plan name is present.
pub fn parse(text: &str) -> Option<ParsedSubscription> {
    let plan_caps = PLAN.captures(text)?;
    let raw_plan = plan_caps[1].to_string();
    let plan = title_case(&raw_plan);

    let (amount_cents, currency) = match PRICE.captures(text) {
        Some(c) => {
            let symbol = &c[1];
            let digits = c[2].replace(',', ".");
            let amount = digits
                .parse::<f64>()
                .ok()
                .map(|v| (v * 100.0).round() as i64);
            (amount, Some(currency_for(symbol).to_string()))
        }
        None => (None, None),
    };

    let interval = INTERVAL.captures(text).and_then(|c| {
        let word = c[1].to_ascii_lowercase();
        if word.starts_with("month") || word == "mo" {
            Some(BillingInterval::Monthly)
        } else if word.starts_with("year") || word.starts_with("annual") || word == "yr" {
            Some(BillingInterval::Yearly)
        } else {
            None
        }
    });

    // An explicit status word wins; otherwise a Free plan is Free, a priced plan
    // with no stated status is Unknown rather than assumed Active.
    let status = match STATUS.captures(text) {
        Some(c) => match c[1].to_ascii_lowercase().replace(['_', '-', ' '], "") {
            s if s == "active" => SubscriptionStatus::Active,
            s if s == "trialing" || s == "trial" => SubscriptionStatus::Trialing,
            s if s == "pastdue" || s == "unpaid" => SubscriptionStatus::PastDue,
            s if s == "canceled" || s == "cancelled" => SubscriptionStatus::Canceled,
            _ => SubscriptionStatus::Unknown,
        },
        None if plan.eq_ignore_ascii_case("free") => SubscriptionStatus::Free,
        None => SubscriptionStatus::Unknown,
    };

    let trial_ends_at = TRIAL_END.captures(text).map(|c| c[1].to_string());

    // A stated trial end date is itself evidence of a trial, even when no
    // status word appeared.
    let status = match (status, trial_ends_at.is_some()) {
        (SubscriptionStatus::Unknown, true) => SubscriptionStatus::Trialing,
        (other, _) => other,
    };

    Some(ParsedSubscription {
        plan,
        status,
        amount_cents,
        currency,
        interval,
        trial_ends_at,
    })
}

fn currency_for(symbol: &str) -> &'static str {
    match symbol {
        "€" => "EUR",
        "£" => "GBP",
        _ => "USD",
    }
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}
