//! Manual entry, re-parenting and deletion.
//!
//! Everything Smart Paste and Connect produce can also be created, moved and
//! removed by hand. These tests pin down that the manual paths write the same
//! graph the automatic ones do, that a `git_hub` account really lands as
//! [`Provider::GitHub`], and that deletes cascade rather than orphaning.

mod common;

use devledger_core::model::{BillingInterval, Provider, SubscriptionStatus};
use devledger_core::Vault;

fn identity_email_ids(vault: &Vault) -> Vec<Option<String>> {
    vault
        .identity_graph()
        .expect("graph")
        .into_iter()
        .map(|n| n.identity.email)
        .collect()
}

#[test]
fn manual_account_lands_under_the_right_provider_and_identity() {
    let (_dir, vault) = common::unlocked_vault();

    let account = vault
        .create_account_manual(
            Some("fkornelind@hotmail.com"),
            Provider::GitHub,
            "fkornelind",
            Some("github.com/fkornelind"),
        )
        .expect("create account");

    assert_eq!(account.provider, Provider::GitHub);
    assert_eq!(
        account.external_ref.as_deref(),
        Some("github.com/fkornelind")
    );

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 1);
    assert_eq!(
        graph[0].identity.email.as_deref(),
        Some("fkornelind@hotmail.com")
    );
    assert_eq!(graph[0].accounts.len(), 1);
    assert_eq!(graph[0].accounts[0].account.provider, Provider::GitHub);
}

#[test]
fn re_adding_the_same_provider_reuses_the_account() {
    let (_dir, vault) = common::unlocked_vault();

    let first = vault
        .create_account_manual(Some("a@example.com"), Provider::Vercel, "a", None)
        .expect("first");
    let second = vault
        .create_account_manual(Some("a@example.com"), Provider::Vercel, "a again", None)
        .expect("second");

    assert_eq!(first.id, second.id, "one account per provider per identity");
}

#[test]
fn a_manual_account_without_an_email_hangs_off_the_unidentified_identity() {
    let (_dir, vault) = common::unlocked_vault();

    vault
        .create_account_manual(None, Provider::Stripe, "personal stripe", None)
        .expect("create");

    let emails = identity_email_ids(&vault);
    assert_eq!(
        emails,
        vec![None],
        "no email means the Unidentified identity"
    );
}

#[test]
fn a_manual_resource_shows_up_under_its_account() {
    let (_dir, vault) = common::unlocked_vault();
    let account = vault
        .create_account_manual(Some("a@example.com"), Provider::GitHub, "a", None)
        .expect("account");

    let resource = vault
        .create_service_project_manual(
            account.id,
            None,
            Provider::GitHub,
            "liveproof",
            Some("github.com/a/liveproof"),
        )
        .expect("resource");

    let all = vault.list_service_projects().expect("list");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].service_project.id, resource.id);
    assert_eq!(all[0].service_project.name, "liveproof");
}

#[test]
fn a_manual_subscription_is_recorded_and_can_be_deleted() {
    let (_dir, vault) = common::unlocked_vault();

    let sub = vault
        .create_subscription_manual(
            Some("fkornelind@hotmail.com"),
            Provider::Unknown,
            "Pro Plan",
            SubscriptionStatus::Active,
            Some(1200),
            Some("USD"),
            Some(BillingInterval::Monthly),
            Some("12/26"),
        )
        .expect("create subscription");

    let rows = vault.list_subscriptions().expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].subscription.plan, "Pro Plan");
    assert_eq!(rows[0].subscription.amount_cents, Some(1200));
    assert_eq!(rows[0].subscription.trial_ends_at.as_deref(), Some("12/26"));

    vault.delete_subscription(sub.id).expect("delete");
    assert!(vault.list_subscriptions().expect("list again").is_empty());
}

#[test]
fn an_account_can_be_moved_to_another_identity() {
    let (_dir, vault) = common::unlocked_vault();
    let account = vault
        .create_account_manual(Some("a@example.com"), Provider::GitHub, "a", None)
        .expect("account");
    // A second identity, created by recording an account for a different email.
    vault
        .create_account_manual(Some("b@example.com"), Provider::Stripe, "b", None)
        .expect("second identity");

    let target = vault
        .list_identities()
        .expect("identities")
        .into_iter()
        .find(|i| i.email.as_deref() == Some("b@example.com"))
        .expect("b identity");

    vault.move_account(account.id, target.id).expect("move");

    let graph = vault.identity_graph().expect("graph");
    let b_node = graph
        .iter()
        .find(|n| n.identity.email.as_deref() == Some("b@example.com"))
        .expect("b node");
    assert!(
        b_node.accounts.iter().any(|a| a.account.id == account.id),
        "the moved account now sits under b@example.com"
    );
}

#[test]
fn a_resource_can_be_re_parented_to_another_account() {
    let (_dir, vault) = common::unlocked_vault();
    let from = vault
        .create_account_manual(Some("a@example.com"), Provider::GitHub, "a", None)
        .expect("from");
    let to = vault
        .create_account_manual(Some("b@example.com"), Provider::GitHub, "b", None)
        .expect("to");
    let resource = vault
        .create_service_project_manual(from.id, None, Provider::GitHub, "repo", None)
        .expect("resource");

    vault
        .move_service_project(resource.id, to.id, None)
        .expect("move");

    let moved = vault
        .list_service_projects()
        .expect("list")
        .into_iter()
        .find(|s| s.service_project.id == resource.id)
        .expect("resource still there");
    assert_eq!(moved.service_project.account_id, to.id);
}

#[test]
fn deleting_an_account_removes_the_resources_under_it() {
    let (_dir, vault) = common::unlocked_vault();
    let account = vault
        .create_account_manual(Some("a@example.com"), Provider::GitHub, "a", None)
        .expect("account");
    vault
        .create_service_project_manual(account.id, None, Provider::GitHub, "repo", None)
        .expect("resource");

    assert_eq!(vault.list_service_projects().expect("before").len(), 1);

    vault.delete_account(account.id).expect("delete");

    assert!(
        vault.list_service_projects().expect("after").is_empty(),
        "resources cascade when their account is deleted"
    );
}

#[test]
fn deleting_a_resource_leaves_the_account_intact() {
    let (_dir, vault) = common::unlocked_vault();
    let account = vault
        .create_account_manual(Some("a@example.com"), Provider::GitHub, "a", None)
        .expect("account");
    let resource = vault
        .create_service_project_manual(account.id, None, Provider::GitHub, "repo", None)
        .expect("resource");

    vault
        .delete_service_project(resource.id)
        .expect("delete resource");

    assert!(vault.list_service_projects().expect("list").is_empty());
    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 1, "the account and identity survive");
    assert_eq!(graph[0].accounts.len(), 1);
}
