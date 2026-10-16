//! The checks on Needs attention that need a calendar: keys left unchanged for
//! a year, trials about to bill, and paying one provider twice.

mod common;

use devledger_core::manual::NewSecret;
use devledger_core::model::{
    BillingInterval, Environment, Provider, SecretKind, SubscriptionStatus,
};
use devledger_core::secret::SecretString;
use devledger_core::store::{AttentionKind, SecretOwner};
use devledger_core::Vault;
use time::{Duration, OffsetDateTime};

fn store(vault: &mut Vault, project: uuid::Uuid, kind: SecretKind, name: &str) {
    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    project_id: Some(project),
                    service_project_id: None,
                    account_id: None,
                },
                kind,
                name: name.into(),
                environment: Environment::Production,
                notes: None,
            },
            &SecretString::new("value-not-real-0000000000"),
        )
        .expect("store");
}

fn of(vault: &Vault, at: OffsetDateTime, kind: AttentionKind) -> Vec<String> {
    vault
        .needs_attention_at(at)
        .expect("attention")
        .into_iter()
        .filter(|i| i.kind == kind)
        .map(|i| i.title)
        .collect()
}

#[test]
fn a_credential_unchanged_for_a_year_is_flagged_and_a_plain_variable_is_not() {
    let (_dir, mut vault) = common::unlocked_vault();
    let project = vault.create_project("Shop", None).expect("project").id;
    store(
        &mut vault,
        project,
        SecretKind::StripeSecretKey,
        "STRIPE_SECRET_KEY",
    );
    store(
        &mut vault,
        project,
        SecretKind::EnvVar,
        "NEXT_PUBLIC_SITE_URL",
    );
    store(
        &mut vault,
        project,
        SecretKind::SupabaseAnonKey,
        "SUPABASE_ANON_KEY",
    );

    let now = OffsetDateTime::now_utc();
    assert!(
        of(&vault, now, AttentionKind::StaleSecret).is_empty(),
        "new keys are fine"
    );

    let later = now + Duration::days(400);
    assert_eq!(
        of(&vault, later, AttentionKind::StaleSecret),
        vec!["STRIPE_SECRET_KEY has not changed in 13 months".to_string()]
    );
}

#[test]
fn a_trial_is_flagged_in_its_last_week_and_after_it_ends() {
    let (_dir, vault) = common::unlocked_vault();
    let now = OffsetDateTime::now_utc();
    let day = |d: i64| (now + Duration::days(d)).date().to_string();
    for (plan, ends) in [
        ("Far", day(30)),
        ("Soon", day(3)),
        ("Today", day(0)),
        ("Over", day(-2)),
    ] {
        vault
            .create_subscription_manual(
                Some("me@example.com"),
                Provider::Vercel,
                plan,
                SubscriptionStatus::Trialing,
                Some(2000),
                Some("USD"),
                Some(BillingInterval::Monthly),
                Some(&ends),
            )
            .expect("subscription");
    }
    let mut titles = of(&vault, now, AttentionKind::TrialEndingSoon);
    titles.sort();
    assert_eq!(
        titles,
        vec![
            "Over trial on Vercel ended 2 days ago".to_string(),
            "Soon trial on Vercel ends in 3 days".to_string(),
            "Today trial on Vercel ends today".to_string(),
        ]
    );
    let detail = vault
        .needs_attention_at(now)
        .unwrap()
        .into_iter()
        .find(|i| i.title.starts_with("Soon"))
        .unwrap()
        .detail;
    assert!(detail.contains("20.00 USD/month"), "{detail}");
    assert!(detail.contains("does not cancel it"), "{detail}");
}

#[test]
fn two_paid_plans_with_one_provider_are_questioned_free_and_cancelled_ones_are_not() {
    let (_dir, vault) = common::unlocked_vault();
    let now = OffsetDateTime::now_utc();
    let add = |email: &str,
               provider: Provider,
               plan: &str,
               status: SubscriptionStatus,
               cents: Option<i64>| {
        vault
            .create_subscription_manual(
                Some(email),
                provider,
                plan,
                status,
                cents,
                Some("USD"),
                Some(BillingInterval::Monthly),
                None,
            )
            .expect("subscription");
    };
    add(
        "me@example.com",
        Provider::Vercel,
        "Pro",
        SubscriptionStatus::Active,
        Some(2000),
    );
    add(
        "work@example.com",
        Provider::Vercel,
        "Team",
        SubscriptionStatus::Active,
        Some(4000),
    );
    add(
        "me@example.com",
        Provider::Supabase,
        "Pro",
        SubscriptionStatus::Active,
        Some(2500),
    );
    add(
        "work@example.com",
        Provider::Supabase,
        "Free",
        SubscriptionStatus::Free,
        None,
    );
    add(
        "old@example.com",
        Provider::Supabase,
        "Pro",
        SubscriptionStatus::Canceled,
        Some(2500),
    );

    let items: Vec<_> = vault
        .needs_attention_at(now)
        .unwrap()
        .into_iter()
        .filter(|i| i.kind == AttentionKind::PayingTwice)
        .collect();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "You pay for Vercel 2 times");
    assert!(items[0].detail.contains("Pro on me@example.com"));
    assert!(items[0].detail.contains("Team on work@example.com"));
}
