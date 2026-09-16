//! M2: deterministic Smart Paste.
//!
//! The contract these tests pin down: the same text always produces the same
//! analysis, classification comes from the value itself wherever possible
//! (a JWT's own `role` claim beats the variable name), and the warnings that
//! matter for security fire reliably.

mod common;

use devledger_core::crypto::blind_index;
use devledger_core::model::SubscriptionStatus;
use devledger_core::model::{Environment, EvidenceLevel, Provider, SecretKind};
use devledger_core::paste::detect::{self, DetectedKind};
use devledger_core::paste::pipeline::{analyze, EmptyLookup};
use devledger_core::paste::subscription;
use devledger_core::paste::warn::{Severity, WarningCode};
use devledger_core::redact::SourceKind;
use devledger_core::secret::SecretBytes;

const NOW: i64 = 1_800_000_000; // well before the fixtures' exp claims

fn index_key() -> SecretBytes {
    SecretBytes::new(vec![42u8; 32])
}

#[test]
fn detects_the_whole_supabase_env_block() {
    let found = detect::detect_all(common::SUPABASE_ENV);
    let labels: Vec<&str> = found.iter().map(|d| d.entity.label.as_str()).collect();

    assert!(labels.contains(&"NEXT_PUBLIC_SUPABASE_URL"));
    assert!(labels.contains(&"NEXT_PUBLIC_SUPABASE_ANON_KEY"));
    assert!(labels.contains(&"SUPABASE_SERVICE_ROLE_KEY"));
    assert!(labels.contains(&"DATABASE_URL"));

    // The URL is not a secret; the three credentials are.
    let url = found
        .iter()
        .find(|d| d.entity.label == "NEXT_PUBLIC_SUPABASE_URL")
        .expect("url detected");
    assert_eq!(url.entity.kind, DetectedKind::EnvVar);
    assert!(url.secret_value.is_none());

    let secrets = found.iter().filter(|d| d.entity.is_secret()).count();
    assert_eq!(secrets, 3, "anon key, service_role key and database URL");
}

#[test]
fn jwt_role_claim_decides_the_secret_kind() {
    let found = detect::detect_all(common::SUPABASE_ENV);

    let anon = found
        .iter()
        .find(|d| d.entity.label == "NEXT_PUBLIC_SUPABASE_ANON_KEY")
        .expect("anon key");
    assert_eq!(anon.entity.secret_kind, Some(SecretKind::SupabaseAnonKey));
    assert_eq!(anon.entity.evidence.level, EvidenceLevel::Explicit);
    assert_eq!(anon.entity.evidence.rule, "jwt.role");

    let service = found
        .iter()
        .find(|d| d.entity.label == "SUPABASE_SERVICE_ROLE_KEY")
        .expect("service role key");
    assert_eq!(
        service.entity.secret_kind,
        Some(SecretKind::SupabaseServiceRoleKey)
    );
    assert_eq!(service.entity.evidence.rule, "jwt.role");
}

#[test]
fn the_value_outranks_a_misleading_variable_name() {
    // A service_role key filed under a name that claims it is the anon key.
    let text = format!(
        "SUPABASE_ANON_KEY={}",
        common::SUPABASE_ENV
            .lines()
            .find(|l| l.starts_with("SUPABASE_SERVICE_ROLE_KEY="))
            .expect("fixture line")
            .trim_start_matches("SUPABASE_SERVICE_ROLE_KEY=")
    );
    let found = detect::detect_all(&text);
    let entity = &found.first().expect("one detection").entity;
    assert_eq!(
        entity.secret_kind,
        Some(SecretKind::SupabaseServiceRoleKey),
        "the JWT payload must win over the variable name"
    );
}

#[test]
fn analysis_is_deterministic() {
    let key = index_key();
    let (first, _) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &key,
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");
    let (second, _) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &key,
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");

    // The analysis id and capture timestamp are deliberately fresh each run;
    // everything derived from the input must be byte-identical.
    assert_eq!(first.entities, second.entities);
    assert_eq!(first.recommendations, second.recommendations);
    assert_eq!(first.proposed_relations, second.proposed_relations);
    assert_eq!(first.warnings, second.warnings);
    assert_eq!(first.subscription, second.subscription);
    assert_eq!(
        first.provenance.redacted_excerpt,
        second.provenance.redacted_excerpt
    );
    assert_eq!(first.chain, second.chain);
    assert_eq!(first.questions, second.questions);
    assert_ne!(first.analysis_id, second.analysis_id);
}

#[test]
fn project_ref_is_recovered_from_url_jwt_and_connection_string() {
    // Each of the three carries the ref in a different place.
    assert_eq!(
        detect::project_ref_from_value("https://abcdefghijklmnopqrst.supabase.co"),
        Some("abcdefghijklmnopqrst".to_string())
    );
    assert_eq!(
        detect::project_ref_from_value(
            "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"
        ),
        Some("abcdefghijklmnopqrst".to_string())
    );
    assert_eq!(
        detect::project_ref_from_value(
            "postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"
        ),
        Some("abcdefghijklmnopqrst".to_string())
    );

    let (analysis, _) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");
    assert_eq!(
        analysis
            .chain
            .service_project
            .as_ref()
            .map(|n| n.label.as_str()),
        Some("abcdefghijklmnopqrst"),
        "all four lines agree on one Supabase project"
    );
}

#[test]
fn corroborated_project_refs_are_strong_evidence() {
    let (analysis, _) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");

    // Four lines name the same Supabase project, so the chain node that stands
    // for that resource is corroborated rather than merely stated once.
    let resource = analysis
        .chain
        .service_project
        .as_ref()
        .expect("a resource was inferred");
    assert_eq!(resource.evidence.level, EvidenceLevel::Strong);
    assert_eq!(resource.evidence.rule, "service_project.ref");

    // Each credential that names the ref itself is explicit about it.
    let self_declared = analysis
        .proposed_relations
        .iter()
        .filter(|r| r.evidence.rule == "secret.self_declared_ref")
        .count();
    assert!(
        self_declared >= 2,
        "the anon key, the service_role key and the database URL all name the ref"
    );
    assert!(analysis
        .proposed_relations
        .iter()
        .all(|r| r.selected_by_default));
}

#[test]
fn a_service_role_key_in_a_client_variable_is_critical() {
    let text = "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=sb_secret_abcdefghijklmnop";
    let (analysis, _) = analyze(
        text,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");

    let warning = analysis
        .warnings
        .iter()
        .find(|w| w.code == WarningCode::ServerSecretInClientVariable)
        .expect("client exposure warning");
    assert_eq!(warning.severity, Severity::Critical);
    assert!(
        analysis.blocks_save,
        "a critical finding must block the default save"
    );
}

#[test]
fn an_anon_key_in_a_client_variable_is_not_a_finding() {
    // Supabase anon keys are designed to ship to browsers; flagging them would
    // train users to click through the warning that matters.
    let (analysis, _) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");

    let exposures: Vec<_> = analysis
        .warnings
        .iter()
        .filter(|w| w.code == WarningCode::ServerSecretInClientVariable)
        .collect();
    assert!(
        exposures.is_empty(),
        "NEXT_PUBLIC_SUPABASE_ANON_KEY must not be flagged, got {exposures:?}"
    );
    assert!(!analysis.blocks_save);
}

#[test]
fn two_project_refs_in_one_paste_raise_a_mismatch() {
    let text = "\
URL_A=https://abcdefghijklmnopqrst.supabase.co
URL_B=https://zyxwvutsrqponmlkjihg.supabase.co";
    let (analysis, _) = analyze(
        text,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");

    let warning = analysis
        .warnings
        .iter()
        .find(|w| w.code == WarningCode::ProjectRefMismatch)
        .expect("mismatch warning");
    assert_eq!(warning.severity, Severity::Warning);
    assert_eq!(warning.entity_indexes.len(), 2);
    assert!(
        analysis.chain.service_project.is_none(),
        "an ambiguous paste must not silently pick one resource"
    );
}

#[test]
fn an_expired_jwt_is_reported() {
    // Same fixture, evaluated after its exp claim (2015576000).
    let (analysis, _) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        2_100_000_000,
    )
    .expect("analyze");

    let expired: Vec<_> = analysis
        .warnings
        .iter()
        .filter(|w| w.code == WarningCode::ExpiredCredential)
        .collect();
    assert_eq!(expired.len(), 2, "both JWTs in the fixture have expired");
}

#[test]
fn non_supabase_credentials_are_classified_by_prefix() {
    let cases = [
        (
            "GITHUB_TOKEN=ghp_0123456789abcdefghij0123456789abcdefgh",
            SecretKind::GitHubToken,
            Provider::GitHub,
        ),
        (
            "STRIPE_SECRET_KEY=sk_live_0123456789abcdefghij",
            SecretKind::StripeSecretKey,
            Provider::Stripe,
        ),
        (
            "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123",
            SecretKind::OpenAiApiKey,
            Provider::OpenAi,
        ),
        (
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
            SecretKind::AwsAccessKeyId,
            Provider::Aws,
        ),
    ];
    for (text, expected_kind, expected_provider) in cases {
        let found = detect::detect_all(text);
        let entity = &found
            .first()
            .unwrap_or_else(|| panic!("no detection for {text}"))
            .entity;
        assert_eq!(entity.secret_kind, Some(expected_kind), "for {text}");
        assert_eq!(entity.provider, expected_provider, "for {text}");
    }
}

#[test]
fn environment_and_client_exposure_are_read_from_the_name() {
    assert_eq!(
        detect::environment_from_name("PROD_DATABASE_URL"),
        Environment::Production
    );
    assert_eq!(
        detect::environment_from_name("STAGING_API_KEY"),
        Environment::Staging
    );
    assert_eq!(
        detect::environment_from_name("LOCAL_DB"),
        Environment::Development
    );
    assert_eq!(
        detect::environment_from_name("DATABASE_URL"),
        Environment::Unknown
    );

    for name in ["NEXT_PUBLIC_X", "VITE_X", "REACT_APP_X", "EXPO_PUBLIC_X"] {
        assert!(
            detect::is_client_exposed_name(name),
            "{name} bundles to the client"
        );
    }
    assert!(!detect::is_client_exposed_name("SUPABASE_SERVICE_ROLE_KEY"));
}

#[test]
fn secret_values_never_appear_in_the_serialized_analysis() {
    // This is the structural guarantee that keeps secrets out of JavaScript.
    let (analysis, staged) = analyze(
        common::SUPABASE_ENV,
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");

    let json = serde_json::to_string(&analysis).expect("serialize");
    assert!(
        !json.contains("s3cr3t-pw"),
        "database password leaked into the analysis"
    );
    for value in staged.values.iter().flatten() {
        assert!(
            !json.contains(value.expose()),
            "a staged secret value leaked into the serialized analysis"
        );
    }
    // The staging area really does hold the three secrets.
    assert_eq!(staged.values.iter().filter(|v| v.is_some()).count(), 3);
}

#[test]
fn subscription_parsing_extracts_plan_price_and_interval() {
    let parsed = subscription::parse("You are on the Pro Plan — $25 per month. Status: active")
        .expect("parsed");
    assert_eq!(parsed.plan, "Pro");
    assert_eq!(parsed.status, SubscriptionStatus::Active);
    assert_eq!(parsed.amount_cents, Some(2500));
    assert_eq!(parsed.currency.as_deref(), Some("USD"));
    assert_eq!(
        parsed.interval,
        Some(devledger_core::model::BillingInterval::Monthly)
    );
}

#[test]
fn subscription_parsing_handles_free_and_past_due() {
    let free = subscription::parse("Free plan").expect("parsed");
    assert_eq!(free.plan, "Free");
    assert_eq!(free.status, SubscriptionStatus::Free);
    assert_eq!(free.amount_cents, None);

    let overdue = subscription::parse("Team plan €599 / year - past due").expect("parsed");
    assert_eq!(overdue.plan, "Team");
    assert_eq!(overdue.status, SubscriptionStatus::PastDue);
    assert_eq!(overdue.amount_cents, Some(59900));
    assert_eq!(overdue.currency.as_deref(), Some("EUR"));
    assert_eq!(
        overdue.interval,
        Some(devledger_core::model::BillingInterval::Yearly)
    );

    assert!(subscription::parse("no billing information here").is_none());
}

#[test]
fn emails_are_detected_as_identities() {
    let found = detect::detect_all("signed in as dev@example.com");
    let entity = &found.first().expect("email detected").entity;
    assert_eq!(entity.kind, DetectedKind::Email);
    assert_eq!(entity.value_preview, "dev@example.com");
    assert!(found[0].secret_value.is_none());
}

#[test]
fn an_empty_paste_reports_that_nothing_was_found() {
    let (analysis, _) = analyze(
        "just some prose with no credentials in it",
        SourceKind::SmartPaste,
        &index_key(),
        &EmptyLookup,
        NOW,
    )
    .expect("analyze");
    assert!(analysis.entities.is_empty());
    assert_eq!(analysis.warnings.len(), 1);
    assert_eq!(analysis.warnings[0].code, WarningCode::NothingDetected);
    assert!(!analysis.blocks_save);
}

#[test]
fn blind_index_normalisation_matches_the_detector_cleanup() {
    // A quoted .env value and a bare one must land on the same index, which is
    // what makes duplicate detection survive a round-trip through a .env file.
    let key = index_key();
    let quoted = detect::detect_all("KEY=\"sb_secret_abcdefghijklmnop\"");
    let bare = detect::detect_all("KEY=sb_secret_abcdefghijklmnop");

    let a = quoted[0].secret_value.as_ref().expect("secret");
    let b = bare[0].secret_value.as_ref().expect("secret");
    assert_eq!(
        blind_index::blind_index(&key, blind_index::DOMAIN_SECRET_VALUE, a.expose()).unwrap(),
        blind_index::blind_index(&key, blind_index::DOMAIN_SECRET_VALUE, b.expose()).unwrap()
    );
}
