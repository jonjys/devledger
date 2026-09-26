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
    /// When a trial ends or the next renewal falls, as `YYYY-MM-DD` when known.
    pub trial_ends_at: Option<String>,
    /// Email this billing note belongs to, when the excerpt named one.
    #[serde(default)]
    pub identity_email: Option<String>,
    /// How many days before `trial_ends_at` Needs attention should fire.
    #[serde(default)]
    pub reminder_days: Option<i64>,
    /// Whether that reminder is on.
    #[serde(default = "default_warn")]
    pub warn_enabled: bool,
}

fn default_warn() -> bool {
    true
}

static PLAN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(free|pro|team|enterprise|hobby|starter|scale|business|cursor|grok)\b[ \t]*(?:plan|tier|usage)?",
    )
    .expect("plan pattern must compile")
});

static PRICE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:([$€£])\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]{1,6})[.,]([0-9]{2})\s*(USD|EUR|GBP))",
    )
    .expect("price pattern must compile")
});

static EMAIL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})")
        .expect("email pattern must compile")
});

static BLOCK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^---\s*$").expect("block pattern must compile"));

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

/// Split a notes file on `---` lines and parse each billing block.
pub fn parse_blocks(text: &str) -> Vec<ParsedSubscription> {
    BLOCK
        .split(text)
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .filter_map(parse)
        .collect()
}

/// Parse a billing excerpt. Returns `None` when no plan name is present.
pub fn parse(text: &str) -> Option<ParsedSubscription> {
    let plan_caps = PLAN.captures(text)?;
    let raw_plan = plan_caps[1].to_string();
    let plan = title_case(&raw_plan);

    let (amount_cents, currency) = match PRICE.captures(text) {
        Some(c) => {
            if let Some(symbol) = c.get(1) {
                let digits = c[2].replace(',', ".");
                let amount = digits
                    .parse::<f64>()
                    .ok()
                    .map(|v| (v * 100.0).round() as i64);
                (amount, Some(currency_for(symbol.as_str()).to_string()))
            } else {
                let whole: i64 = c[3].parse().unwrap_or(0);
                let frac: i64 = c[4].parse().unwrap_or(0);
                let code = c.get(5).map(|m| m.as_str().to_ascii_uppercase());
                (Some(whole * 100 + frac), code)
            }
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

    let mut interval = interval;
    if interval.is_none()
        && (text.to_ascii_lowercase().contains("cycle")
            || text.to_ascii_lowercase().contains("paid"))
    {
        interval = Some(BillingInterval::Monthly);
    }

    let trialish =
        status == SubscriptionStatus::Trialing || text.to_ascii_lowercase().contains("trial");
    let trial_ends_at = resolve_end(text, trialish, interval);

    // A stated trial end date is itself evidence of a trial, even when no
    // status word appeared.
    let mentions_trial = text.to_ascii_lowercase().contains("trial");
    let status = match (
        status,
        trialish || (trial_ends_at.is_some() && mentions_trial),
    ) {
        (SubscriptionStatus::Unknown, true) => SubscriptionStatus::Trialing,
        (other, _) => other,
    };

    let identity_email = EMAIL.captures(text).map(|c| c[1].to_string());
    let reminder_days = trial_ends_at.as_ref().map(|_| 1);

    Some(ParsedSubscription {
        plan,
        status,
        amount_cents,
        currency,
        interval,
        trial_ends_at,
        identity_email,
        reminder_days,
        warn_enabled: true,
    })
}

/// Prefer an explicit "dvs 1 okt", then "N dagar från 09-25", then a cycle
/// start plus one month, then a paid date plus one month.
fn resolve_end(text: &str, trialish: bool, interval: Option<BillingInterval>) -> Option<String> {
    if let Some(c) = TRIAL_END.captures(text) {
        return Some(c[1].to_string());
    }
    let year = year_in(text);
    if trialish {
        if let Some(date) = dvs_date(text, year) {
            return Some(date);
        }
        if let Some(date) = days_from(text, year) {
            return Some(date);
        }
    }
    if let Some(start) = cycle_start(text, year) {
        return Some(shift_months(&start, 1));
    }
    if matches!(
        interval,
        Some(BillingInterval::Monthly) | Some(BillingInterval::Yearly)
    ) {
        if let Some(paid) = first_full_date(text, year) {
            let months = if interval == Some(BillingInterval::Yearly) {
                12
            } else {
                1
            };
            return Some(shift_months(&paid, months));
        }
    }
    None
}

fn year_in(text: &str) -> i32 {
    static YEAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(20\d{2})\b").expect("year"));
    YEAR.captures(text)
        .and_then(|c| c[1].parse().ok())
        .unwrap_or_else(|| time::OffsetDateTime::now_utc().year())
}

fn dvs_date(text: &str, year: i32) -> Option<String> {
    static DVS: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)\bdvs\s+(\d{1,2})\s+([a-zåäö]+)").expect("dvs date"));
    let caps = DVS.captures(text)?;
    let day: u8 = caps[1].parse().ok()?;
    let month = month_from(&caps[2])?;
    iso(year, month, day)
}

fn days_from(text: &str, year: i32) -> Option<String> {
    static FROM: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)(\d+)\s+dagar\s+fr[åa]n(?:\s+och\s+med)?\s+(\d{1,2})-(\d{1,2})")
            .expect("days from")
    });
    let caps = FROM.captures(text)?;
    let days: i64 = caps[1].parse().ok()?;
    let month: u8 = caps[2].parse().ok()?;
    let day: u8 = caps[3].parse().ok()?;
    let date = iso_date(year, month, day)?;
    let end = date.checked_add(time::Duration::days(days))?;
    Some(format!(
        "{:04}-{:02}-{:02}",
        end.year(),
        u8::from(end.month()),
        end.day()
    ))
}

fn cycle_start(text: &str, year: i32) -> Option<String> {
    static CYCLE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)cycle starting\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})")
            .expect("cycle")
    });
    let caps = CYCLE.captures(text)?;
    let month = month_from(&caps[1])?;
    let day: u8 = caps[2].parse().ok()?;
    let y: i32 = caps[3].parse().unwrap_or(year);
    iso(y, month, day)
}

fn first_full_date(text: &str, year: i32) -> Option<String> {
    static DAY_MONTH: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)\b(\d{1,2})\s+([a-zåäö]+)\.?\s+(\d{4})").expect("day month year")
    });
    let caps = DAY_MONTH.captures(text)?;
    let day: u8 = caps[1].parse().ok()?;
    let month = month_from(&caps[2])?;
    let y: i32 = caps[3].parse().unwrap_or(year);
    iso(y, month, day)
}

fn month_from(name: &str) -> Option<u8> {
    let key = name
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .take(3)
        .collect::<String>()
        .to_ascii_lowercase();
    match key.as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "maj" | "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "okt" | "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

fn iso_date(year: i32, month: u8, day: u8) -> Option<time::Date> {
    let month = time::Month::try_from(month).ok()?;
    time::Date::from_calendar_date(year, month, day).ok()
}

fn iso(year: i32, month: u8, day: u8) -> Option<String> {
    let date = iso_date(year, month, day)?;
    Some(format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    ))
}

/// Which `---` section a byte offset falls in. A paste with no separator is section 0.
pub fn block_index(text: &str, offset: usize) -> u32 {
    let mut index = 0u32;
    for separator in BLOCK.find_iter(text) {
        if offset >= separator.end() {
            index += 1;
        } else {
            break;
        }
    }
    index
}

fn shift_months(iso: &str, months: i32) -> String {
    let Some(date) = parse_iso(iso) else {
        return iso.to_string();
    };
    let mut month = i32::from(u8::from(date.month())) + months;
    let mut year = date.year();
    while month > 12 {
        month -= 12;
        year += 1;
    }
    let Some(month) = u8::try_from(month)
        .ok()
        .and_then(|m| time::Month::try_from(m).ok())
    else {
        return iso.to_string();
    };
    let day = date.day().min(month.length(year));
    time::Date::from_calendar_date(year, month, day)
        .map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day()))
        .unwrap_or_else(|_| iso.to_string())
}

fn parse_iso(iso: &str) -> Option<time::Date> {
    let mut parts = iso.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let day: u8 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    iso_date(year, month, day)
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
