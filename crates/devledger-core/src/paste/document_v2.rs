//! Detect document context before the generic project-name heuristic.
//! Receipts are previews only until a reviewed receipt persistence model exists.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::error::Result;
use crate::redact::{self, SecretSpan, SourceKind};
use crate::secret::SecretBytes;

use super::base_pipeline::{self, MatchLookup, PasteAnalysis, StagedSecrets};
use super::detect;
use super::warn::{Severity, Warning, WarningCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Receipt,
    Invoice,
    Environment,
    AccountMessage,
    SubscriptionMessage,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptPreview {
    pub kind: DocumentKind,
    pub merchant: Option<String>,
    pub service: Option<String>,
    pub plan: Option<String>,
    pub billing_email: Option<String>,
    pub merchant_email: Option<String>,
    pub invoice_number: Option<String>,
    pub receipt_number: Option<String>,
    pub amount_minor: Option<i64>,
    pub currency: Option<&'static str>,
    pub payment_date: Option<String>,
    pub service_period: Option<String>,
    pub card_last_four: Option<String>,
    pub paid: bool,
}

static EMAIL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").expect("email pattern")
});
static AMOUNT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)([$€£])\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)").expect("amount pattern")
});
static CARD: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:visa|mastercard|amex)\s*[-*•· ]+\s*(\d{4})\b").expect("card pattern")
});
static ENV: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*(?:export\s+)?[A-Za-z_][A-Za-z_0-9]*\s*=")
        .expect("environment assignment pattern")
});

/// Prioritize credential-containing .env blocks over document interpretation.
pub fn classify(text: &str) -> DocumentKind {
    let lower = text.to_lowercase();
    if ENV.is_match(text) {
        return DocumentKind::Environment;
    }
    let billing = lower.contains("bill to")
        || lower.contains("amount paid")
        || lower.contains("total paid")
        || lower.contains("fakturera till")
        || lower.contains("betalt belopp");
    let invoice = lower.contains("invoice number")
        || lower.contains("invoice #")
        || lower.contains("fakturanummer")
        || lower.contains("faktura nr");
    let receipt = lower.contains("receipt number")
        || lower.contains("kvittonummer")
        || lower.lines().any(|line| {
            matches!(
                line.trim(),
                "receipt" | "Receipt" | "RECEIPT" | "Kvitto" | "KVITTO"
            )
        });
    if (receipt || invoice) && (billing || AMOUNT.is_match(text)) {
        return if receipt {
            DocumentKind::Receipt
        } else {
            DocumentKind::Invoice
        };
    }
    if lower.contains("verify your email")
        || lower.contains("confirm your account")
        || lower.contains("verifiera din e-post")
    {
        return DocumentKind::AccountMessage;
    }
    if lower.contains("subscription renewed")
        || lower.contains("subscription renewal")
        || lower.contains("abonnemang förnyas")
        || lower.contains("abonnemanget förnyas")
    {
        return DocumentKind::SubscriptionMessage;
    }
    DocumentKind::Generic
}

fn value_after_label(text: &str, labels: &[&str]) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let lowered = trimmed.to_lowercase();
        for label in labels {
            if lowered.starts_with(label) {
                let suffix = trimmed
                    .get(label.len()..)?
                    .trim_start_matches([' ', ':', '#', '-']);
                if !suffix.is_empty() {
                    return Some(suffix.trim().to_string());
                }
            }
        }
    }
    None
}

fn first_email(text: &str) -> Option<String> {
    EMAIL.find(text).map(|m| m.as_str().to_ascii_lowercase())
}

fn billing_email(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for marker in ["bill to", "billed to", "faktureras till", "fakturera till"] {
        if let Some(start) = lower.find(marker) {
            let tail = text.get(start + marker.len()..)?;
            let segment = tail
                .lines()
                .take(9)
                .take_while(|line| {
                    let s = line.trim().to_lowercase();
                    !s.starts_with("description")
                        && !s.starts_with("subtotal")
                        && !s.starts_with("amount paid")
                        && !s.starts_with("beskrivning")
                })
                .collect::<Vec<_>>()
                .join("\n");
            return first_email(&segment);
        }
    }
    None
}

fn merchant_name(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| {
            let upper = line.to_uppercase();
            line.len() <= 110
                && [
                    " INC", " INC.", " LLC", " LTD", " LTD.", " GMBH", " AB", " OY",
                ]
                .iter()
                .any(|suffix| upper.contains(suffix))
                && !upper.starts_with("INVOICE")
                && !upper.starts_with("RECEIPT")
        })
        .map(|line| line.split(" @").next().unwrap_or(line).trim().to_string())
}

fn paid_amount(text: &str) -> Option<(i64, &'static str)> {
    let target = text.lines().map(str::trim).find(|line| {
        let lower = line.to_lowercase();
        (lower.starts_with("amount paid")
            || lower.starts_with("total paid")
            || lower.starts_with("betalt belopp")
            || lower.contains(" paid on "))
            && AMOUNT.is_match(line)
    })?;
    let caps = AMOUNT.captures(target)?;
    let currency = match &caps[1] {
        "€" => "EUR",
        "£" => "GBP",
        _ => "USD",
    };
    let digits = caps[2].replace(',', "");
    let mut parts = digits.split('.');
    let whole = parts.next()?.parse::<i64>().ok()?;
    let fraction = parts.next().unwrap_or("0");
    if parts.next().is_some() {
        return None;
    }
    let cents = match fraction.len() {
        1 => fraction.parse::<i64>().ok()?.checked_mul(10)?,
        2 => fraction.parse::<i64>().ok()?,
        _ if fraction == "0" => 0,
        _ => return None,
    };
    Some((whole.checked_mul(100)?.checked_add(cents)?, currency))
}

pub fn extract_receipt(text: &str) -> Option<ReceiptPreview> {
    let kind = classify(text);
    if !matches!(kind, DocumentKind::Receipt | DocumentKind::Invoice) {
        return None;
    }
    let amount = paid_amount(text);
    let service = text.lines().find_map(|line| {
        line.trim().split_once(" @").and_then(|(_, handle)| {
            let handle = handle.trim();
            if handle.len() > 1
                && handle
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                Some(handle.to_string())
            } else {
                None
            }
        })
    });
    let service_period = text
        .lines()
        .map(str::trim)
        .find(|line| {
            (line.contains('–') || line.contains(" - "))
                && [
                    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                    "dec",
                ]
                .iter()
                .any(|month| line.to_lowercase().contains(month))
        })
        .map(str::to_string);
    let card_last_four = CARD.captures(text).map(|c| c[1].to_string());
    let lower = text.to_lowercase();
    Some(ReceiptPreview {
        kind,
        merchant: merchant_name(text),
        service,
        plan: value_after_label(text, &["plan:", "plan "]).or_else(|| {
            text.lines()
                .map(str::trim)
                .find(|line| {
                    matches!(
                        line.to_lowercase().as_str(),
                        "standard" | "starter" | "pro" | "business"
                    )
                })
                .map(str::to_string)
        }),
        billing_email: billing_email(text),
        merchant_email: text
            .lines()
            .take_while(|line| !line.to_lowercase().contains("bill to"))
            .find_map(first_email),
        invoice_number: value_after_label(text, &["invoice number", "invoice #", "fakturanummer"]),
        receipt_number: value_after_label(text, &["receipt number", "kvittonummer"]),
        amount_minor: amount.map(|a| a.0),
        currency: amount.map(|a| a.1),
        payment_date: value_after_label(text, &["date paid", "betalningsdatum"]).or_else(|| {
            text.lines().find_map(|line| {
                let lower = line.to_lowercase();
                lower
                    .find(" paid on ")
                    .map(|index| line[index + " paid on ".len()..].trim().to_string())
            })
        }),
        service_period,
        card_last_four,
        paid: lower.contains("amount paid")
            || lower.contains("total paid")
            || lower.contains(" paid on ")
            || lower.contains("betalt belopp"),
    })
}

/// Receipt metadata is preview-only; it must not silently create a subscription
/// or turn an invoice number into an organization or project.
pub fn analyze(
    text: &str,
    source: SourceKind,
    index_key: &SecretBytes,
    lookup: &dyn MatchLookup,
    now_unix: i64,
) -> Result<(PasteAnalysis, StagedSecrets)> {
    let Some(receipt) = extract_receipt(text) else {
        return base_pipeline::analyze(text, source, index_key, lookup, now_unix);
    };
    let (mut analysis, staged) = base_pipeline::analyze(
        receipt.billing_email.as_deref().unwrap_or(""),
        source,
        index_key,
        lookup,
        now_unix,
    )?;
    let spans: Vec<SecretSpan> = detect::detect_all(text)
        .iter()
        .filter_map(|d| {
            d.entity.secret_kind.map(|kind| SecretSpan {
                start: d.span.0,
                end: d.span.1,
                kind,
            })
        })
        .collect();
    analysis.provenance = redact::provenance(text, &spans, source);
    analysis
        .warnings
        .retain(|warning| warning.code != WarningCode::NothingDetected);
    let mut facts = Vec::new();
    if let Some(merchant) = &receipt.merchant {
        facts.push(format!("Merchant: {merchant}"));
    }
    if let Some(service) = &receipt.service {
        facts.push(format!("Service: {service}"));
    }
    if let Some(plan) = &receipt.plan {
        facts.push(format!("Plan: {plan}"));
    }
    if let (Some(amount), Some(currency)) = (receipt.amount_minor, receipt.currency) {
        facts.push(format!(
            "Amount paid: {currency} {}.{:02}",
            amount / 100,
            amount % 100
        ));
    }
    if let Some(date) = &receipt.payment_date {
        facts.push(format!("Payment date: {date}"));
    }
    if let Some(period) = &receipt.service_period {
        facts.push(format!("Service period: {period} (renewal not confirmed)"));
    }
    if let Some(invoice) = &receipt.invoice_number {
        facts.push(format!("Invoice number: {invoice}"));
    }
    if let Some(number) = &receipt.receipt_number {
        facts.push(format!("Receipt number: {number}"));
    }
    if let Some(last_four) = &receipt.card_last_four {
        facts.push(format!("Card: ending {last_four}"));
    }
    analysis.warnings.push(Warning::new(
        WarningCode::NothingDetected,
        Severity::Info,
        "Receipt recognized — preview only",
        format!(
            "{}. This build cannot store receipts or their billing details yet. Save links only saves the identified billing email, not this receipt or a subscription.",
            facts.join(" · ")
        ),
        vec![],
    ));
    Ok((analysis, staged))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECEIPT: &str = "Receipt\nInvoice number ABC-0003\nReceipt number 2821-3523\nDate paid August 29, 2026\nEXAMPLE LABS INC @example\n2380 Via Espada\nPleasanton, California 94566\nUnited States\nsupport@example.test\n\nBill to\nExample User\nAnywhere\ncustomer@example.test\n\n$20.00 paid on August 29, 2026\n\nDescription Qty Unit price Amount\nStandard\nAug 29–Sep 29, 2026\n\n1 $20.00 $20.00\nSubtotal $20.00\nTotal $20.00\nAmount paid $20.00\nPayment history\nVisa - 5351 August 29, 2026 $20.00 2821-3523";

    #[test]
    fn receipt_extracts_billing_identity_and_facts() {
        let receipt = extract_receipt(RECEIPT).expect("receipt");
        assert_eq!(receipt.merchant.as_deref(), Some("EXAMPLE LABS INC"));
        assert_eq!(receipt.service.as_deref(), Some("example"));
        assert_eq!(receipt.plan.as_deref(), Some("Standard"));
        assert_eq!(
            receipt.billing_email.as_deref(),
            Some("customer@example.test")
        );
        assert_eq!(
            receipt.merchant_email.as_deref(),
            Some("support@example.test")
        );
        assert_eq!(receipt.invoice_number.as_deref(), Some("ABC-0003"));
        assert_eq!(receipt.receipt_number.as_deref(), Some("2821-3523"));
        assert_eq!(receipt.amount_minor, Some(2000));
        assert_eq!(receipt.currency, Some("USD"));
        assert_eq!(receipt.card_last_four.as_deref(), Some("5351"));
        assert_eq!(receipt.payment_date.as_deref(), Some("August 29, 2026"));
        assert_eq!(
            receipt.service_period.as_deref(),
            Some("Aug 29–Sep 29, 2026")
        );
    }

    #[test]
    fn receipt_does_not_create_spurious_entities_or_subscription() {
        let (analysis, _) = analyze(
            RECEIPT,
            SourceKind::SmartPaste,
            &SecretBytes::new(vec![7; 32]),
            &base_pipeline::EmptyLookup,
            1_800_000_000,
        )
        .expect("analysis");
        assert_eq!(
            analysis.chain.identity.as_ref().map(|id| id.label.as_str()),
            Some("customer@example.test")
        );
        assert!(analysis.chain.organization.is_none());
        assert!(analysis.chain.project.is_none());
        assert!(analysis.chain.account.is_none());
        assert!(analysis.subscription.is_none());
        assert!(analysis
            .warnings
            .iter()
            .any(|warning| warning.title.contains("preview only")));
    }

    #[test]
    fn support_address_is_not_a_billing_identity() {
        let input =
            "Receipt\nInvoice number INV-7\nMERCHANT INC\nsupport@merchant.test\nAmount paid $5.00";
        let receipt = extract_receipt(input).expect("receipt");
        assert!(receipt.billing_email.is_none());
        assert_eq!(
            receipt.merchant_email.as_deref(),
            Some("support@merchant.test")
        );
        assert!(receipt.service_period.is_none());
        let (analysis, _) = analyze(
            input,
            SourceKind::SmartPaste,
            &SecretBytes::new(vec![7; 32]),
            &base_pipeline::EmptyLookup,
            1_800_000_000,
        )
        .expect("analysis");
        assert!(analysis.chain.identity.is_none());
        assert!(analysis.chain.project.is_none());
    }

    #[test]
    fn environment_and_account_messages_do_not_get_receipt_parsing() {
        assert_eq!(
            classify("API_KEY=dummy\nReceipt\nAmount paid $20.00"),
            DocumentKind::Environment
        );
        assert_eq!(
            classify("Hello\nhttps://example.test"),
            DocumentKind::Generic
        );
        assert_eq!(
            classify("Verify your email to create your account"),
            DocumentKind::AccountMessage
        );
        assert_eq!(
            classify("Your subscription renewed today"),
            DocumentKind::SubscriptionMessage
        );
    }

    #[test]
    fn source_credentials_remain_redacted() {
        let text = format!("{RECEIPT}\nAPI_KEY=sk-example-secret-test-token-1234567890");
        assert_eq!(classify(&text), DocumentKind::Environment);
        let spans = detect::detect_all(&text)
            .iter()
            .filter_map(|d| {
                d.entity.secret_kind.map(|kind| SecretSpan {
                    start: d.span.0,
                    end: d.span.1,
                    kind,
                })
            })
            .collect::<Vec<_>>();
        let safe = redact::redact(&text, &spans);
        assert!(!safe.contains("sk-example-secret-test-token-1234567890"));
    }
}
