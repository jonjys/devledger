//! Several identities, accounts, organizations and projects at once.
//!
//! This is the situation DevLedger exists for: a developer who has accumulated
//! two or three provider accounts under different emails and has lost track of
//! which project sits where. The rule these tests pin down is that DevLedger
//! **keeps things apart unless there is evidence they belong together**, and
//! never merges two separate accounts because they happen to use one tool.

mod common;

use common::accept_all;

use devledger_core::model::{EntityKind, EntityRef, Provider, RelationKind};
use devledger_core::paste::{AnswerChoice, QuestionAnswer, Q_ORGANIZATION, Q_PROJECT};
use devledger_core::redact::SourceKind;
use devledger_core::store::AttentionKind;
use devledger_core::Vault;

/// Paste, then accept everything DevLedger proposed.
fn paste_and_accept(vault: &mut Vault, text: &str) {
    let analysis = vault
        .analyze_paste(text, SourceKind::SmartPaste)
        .expect("analyze");
    vault.commit_review(&accept_all(&analysis)).expect("commit");
}

#[test]
fn two_emails_produce_two_separate_accounts() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);
    paste_and_accept(&mut vault, common::SUPABASE_SECOND_ACCOUNT);

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 2, "two emails means two identities");

    let emails: Vec<&str> = graph
        .iter()
        .filter_map(|n| n.identity.email.as_deref())
        .collect();
    assert!(emails.contains(&"dev-a@example.com"));
    assert!(emails.contains(&"dev-b@example.com"));

    // Each identity holds its own Supabase account. They are not merged just
    // because both are Supabase.
    for node in &graph {
        assert_eq!(node.accounts.len(), 1);
        assert_eq!(node.accounts[0].account.provider, Provider::Supabase);
    }
    let account_ids: Vec<_> = graph.iter().map(|n| n.accounts[0].account.id).collect();
    assert_ne!(account_ids[0], account_ids[1]);
}

#[test]
fn each_account_keeps_its_own_organization_and_resources() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);
    paste_and_accept(&mut vault, common::SUPABASE_SECOND_ACCOUNT);

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 2, "two Supabase projects");

    let acme = resources
        .iter()
        .find(|r| r.service_project.provider_ref.as_deref() == Some("abcdefghijklmnopqrst"))
        .expect("first resource");
    let beta = resources
        .iter()
        .find(|r| r.service_project.provider_ref.as_deref() == Some("zyxwvutsrqponmlkjihg"))
        .expect("second resource");

    assert_eq!(acme.organization_name.as_deref(), Some("AcmeOrg"));
    assert_eq!(beta.organization_name.as_deref(), Some("BetaOrg"));
    assert_eq!(acme.identity_email.as_deref(), Some("dev-a@example.com"));
    assert_eq!(beta.identity_email.as_deref(), Some("dev-b@example.com"));
    assert_ne!(
        acme.service_project.account_id, beta.service_project.account_id,
        "the two resources hang off different accounts"
    );
    assert_ne!(
        acme.service_project.organization_id, beta.service_project.organization_id,
        "and different organizations"
    );
}

#[test]
fn two_organizations_can_live_under_one_account() {
    // The same email, but two different Supabase organizations.
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);
    paste_and_accept(
        &mut vault,
        "Acme Internal\n\
         AcmeLabs\n\
         dev-a@example.com\n\
         Supabase\n\
         https://mmmmmmmmmmmmmmmmmmmm.supabase.co\n\
         INTERNAL_ANON_KEY=sb_publishable_internalinternal\n",
    );

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 1, "one email, one identity");
    assert_eq!(graph[0].accounts.len(), 1, "one Supabase account");

    let orgs: Vec<&str> = graph[0].accounts[0]
        .organizations
        .iter()
        .map(|o| o.organization.name.as_str())
        .collect();
    assert_eq!(orgs.len(), 2, "two organizations under the one account");
    assert!(orgs.contains(&"AcmeOrg"));
    assert!(orgs.contains(&"AcmeLabs"));

    for org in &graph[0].accounts[0].organizations {
        assert_eq!(
            org.service_projects.len(),
            1,
            "{} holds exactly its own resource",
            org.organization.name
        );
    }
}

#[test]
fn one_organization_can_hold_several_resources() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);

    // A second Supabase project, same email, same organization name.
    paste_and_accept(
        &mut vault,
        "Acme Staging\n\
         AcmeOrg\n\
         dev-a@example.com\n\
         Supabase\n\
         https://ssssssssssssssssssss.supabase.co\n\
         STAGING_ANON_KEY=sb_publishable_stagingstaging\n",
    );

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(
        graph[0].accounts[0].organizations.len(),
        1,
        "one org, reused"
    );
    assert_eq!(
        graph[0].accounts[0].organizations[0].service_projects.len(),
        2,
        "both Supabase projects sit inside AcmeOrg"
    );

    // Two separate DevLedger projects, one per paste.
    let projects = vault.list_projects().expect("projects");
    let names: Vec<&str> = projects.iter().map(|p| p.project.name.as_str()).collect();
    assert!(names.contains(&"Acme Storefront"));
    assert!(names.contains(&"Acme Staging"));
}

#[test]
fn one_resource_can_serve_two_projects() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);

    let resource_id = vault.list_service_projects().expect("resources")[0]
        .service_project
        .id;
    let second = vault
        .create_project("Acme Admin", Some("Shares the storefront database"))
        .expect("create project");

    vault
        .link_service_project(resource_id, second.id)
        .expect("link");

    let summary = &vault.list_service_projects().expect("resources")[0];
    assert_eq!(summary.used_by.len(), 2, "one resource, two projects");

    // Both projects can now reach the same secrets.
    assert_eq!(vault.list_secrets(second.id).expect("list").len(), 3);

    // Unlinking removes only the link, not the resource or its secrets.
    vault
        .unlink_service_project(resource_id, second.id)
        .expect("unlink");
    assert_eq!(vault.list_secrets(second.id).expect("list").len(), 0);
    assert_eq!(vault.list_service_projects().expect("resources").len(), 1);
}

#[test]
fn the_same_project_ref_under_a_second_email_is_not_silently_merged() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);

    // The same Supabase project ref, pasted alongside a different email. The
    // ref is globally unique at the provider, so this is the one resource seen
    // from a second account -- DevLedger must not create a duplicate row, and
    // must not silently move it under the new identity either.
    let before = vault.list_service_projects().expect("resources")[0]
        .service_project
        .account_id;
    paste_and_accept(
        &mut vault,
        "Acme Storefront\n\
         AcmeOrg\n\
         dev-b@example.com\n\
         Supabase\n\
         https://abcdefghijklmnopqrst.supabase.co\n",
    );

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(
        resources.len(),
        1,
        "the provider ref is unique, so is the row"
    );
    assert_eq!(
        resources[0].service_project.account_id, before,
        "the resource stays with the account that first recorded it"
    );

    // But the second identity is still recorded, so the user can see both.
    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 2);
}

#[test]
fn answering_a_question_overrides_the_suggested_role() {
    // DevLedger guessed the first label is the project. The user says otherwise.
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");

    let mut submission = accept_all(&analysis);
    submission.answers = vec![
        QuestionAnswer {
            question_id: Q_PROJECT.to_string(),
            choice: AnswerChoice::NewNamed {
                name: "Something Else Entirely".to_string(),
            },
        },
        QuestionAnswer {
            question_id: Q_ORGANIZATION.to_string(),
            choice: AnswerChoice::NewNamed {
                name: "CorrectedOrg".to_string(),
            },
        },
    ];

    vault.commit_review(&submission).expect("commit");

    let projects = vault.list_projects().expect("projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].project.name, "Something Else Entirely");

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(
        resources[0].organization_name.as_deref(),
        Some("CorrectedOrg")
    );
}

#[test]
fn answering_unknown_leaves_the_organization_unassigned() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");

    let mut submission = accept_all(&analysis);
    // Keep the project answer, but say the organization is unknown.
    submission
        .answers
        .retain(|a| a.question_id != Q_ORGANIZATION);
    submission.answers.push(QuestionAnswer {
        question_id: Q_ORGANIZATION.to_string(),
        choice: AnswerChoice::Unknown,
    });

    let outcome = vault.commit_review(&submission).expect("commit");
    assert_eq!(outcome.organizations_created, 0);
    assert_eq!(outcome.left_unassigned, 1);

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources[0].organization_name, None);

    let attention = vault.needs_attention().expect("attention");
    assert!(attention
        .iter()
        .any(|a| a.kind == AttentionKind::UnassignedOrganization));
}

#[test]
fn an_unassigned_resource_can_be_filed_later() {
    let (_dir, mut vault) = common::unlocked_vault();
    // A bare .env leaves the resource with no organization.
    paste_and_accept(&mut vault, common::SUPABASE_ENV);

    let resource = vault.list_service_projects().expect("resources")[0]
        .service_project
        .clone();
    assert_eq!(resource.organization_id, None);

    let account_id = resource.account_id;
    let org = vault
        .create_organization(account_id, "FoundItLater")
        .expect("create org");
    vault
        .assign_service_project_organization(resource.id, Some(org.id))
        .expect("assign");

    let summary = &vault.list_service_projects().expect("resources")[0];
    assert_eq!(summary.organization_name.as_deref(), Some("FoundItLater"));

    let attention = vault.needs_attention().expect("attention");
    assert!(
        !attention
            .iter()
            .any(|a| a.kind == AttentionKind::UnassignedOrganization),
        "the gap is closed once the organization is assigned"
    );
}

#[test]
fn needs_attention_reports_a_resource_no_project_uses() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_ENV);

    let attention = vault.needs_attention().expect("attention");
    assert!(attention
        .iter()
        .any(|a| a.kind == AttentionKind::UnlinkedServiceProject));

    // Linking it to a project resolves that item.
    let resource_id = vault.list_service_projects().expect("resources")[0]
        .service_project
        .id;
    let project = vault.create_project("Adopted", None).expect("create");
    vault
        .link_service_project(resource_id, project.id)
        .expect("link");

    let attention = vault.needs_attention().expect("attention");
    assert!(!attention
        .iter()
        .any(|a| a.kind == AttentionKind::UnlinkedServiceProject));
}

#[test]
fn secrets_stay_with_their_own_resource_across_accounts() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);
    paste_and_accept(&mut vault, common::SUPABASE_SECOND_ACCOUNT);

    let projects = vault.list_projects().expect("projects");
    let storefront = projects
        .iter()
        .find(|p| p.project.name == "Acme Storefront")
        .expect("first project");
    let dashboard = projects
        .iter()
        .find(|p| p.project.name == "Beta Dashboard")
        .expect("second project");

    let storefront_secrets = vault.list_secrets(storefront.project.id).expect("list");
    let dashboard_secrets = vault.list_secrets(dashboard.project.id).expect("list");

    assert_eq!(storefront_secrets.len(), 3);
    assert_eq!(dashboard_secrets.len(), 1);

    // No secret appears under both projects.
    for a in &storefront_secrets {
        assert!(
            !dashboard_secrets.iter().any(|b| b.secret.id == a.secret.id),
            "{} leaked across accounts",
            a.secret.name
        );
    }

    // And the .env export for one account never contains the other's values.
    let env = vault.export_env(dashboard.project.id).expect("export");
    assert!(env.expose().contains("BETA_SUPABASE_ANON_KEY"));
    assert!(!env.expose().contains("s3cr3t-pw"));
}

#[test]
fn a_subscription_is_recorded_against_the_right_account() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);
    paste_and_accept(
        &mut vault,
        "Beta Dashboard\n\
         BetaOrg\n\
         dev-b@example.com\n\
         Supabase\n\
         https://zyxwvutsrqponmlkjihg.supabase.co\n\
         Pro plan $25 per month, active\n",
    );

    let subscriptions = vault.list_subscriptions().expect("subscriptions");
    assert_eq!(subscriptions.len(), 1);
    assert_eq!(subscriptions[0].subscription.plan, "Pro");
    assert_eq!(subscriptions[0].subscription.amount_cents, Some(2500));
    assert_eq!(
        subscriptions[0].identity_email.as_deref(),
        Some("dev-b@example.com"),
        "billed to the account the paste was about, not the first one in the vault"
    );
    assert_eq!(subscriptions[0].provider, Provider::Supabase);
}

#[test]
fn a_trial_end_date_is_captured() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(
        &mut vault,
        "Acme Storefront\n\
         AcmeOrg\n\
         dev-a@example.com\n\
         Supabase\n\
         https://abcdefghijklmnopqrst.supabase.co\n\
         Team plan, trial ends 2026-12-01\n",
    );

    let subscriptions = vault.list_subscriptions().expect("subscriptions");
    assert_eq!(subscriptions.len(), 1);
    assert_eq!(subscriptions[0].subscription.plan, "Team");
    assert_eq!(
        subscriptions[0].subscription.trial_ends_at.as_deref(),
        Some("2026-12-01")
    );
    assert_eq!(
        subscriptions[0].subscription.status,
        devledger_core::model::SubscriptionStatus::Trialing,
        "a stated trial end date is itself evidence of a trial"
    );
}

#[test]
fn the_chain_relations_are_all_recorded() {
    let (_dir, mut vault) = common::unlocked_vault();
    paste_and_accept(&mut vault, common::SUPABASE_FULL);

    let graph = vault.identity_graph().expect("graph");
    let identity_id = graph[0].identity.id;
    let account_id = graph[0].accounts[0].account.id;
    let org_id = graph[0].accounts[0].organizations[0].organization.id;

    let from_identity = vault
        .relations_for(EntityRef::new(EntityKind::Identity, identity_id))
        .expect("relations");
    assert!(
        from_identity.iter().any(|r| r.kind == RelationKind::Owns
            && r.to == EntityRef::new(EntityKind::Account, account_id)),
        "identity owns the account"
    );

    let from_account = vault
        .relations_for(EntityRef::new(EntityKind::Account, account_id))
        .expect("relations");
    assert!(
        from_account.iter().any(|r| r.kind == RelationKind::MemberOf
            && r.to == EntityRef::new(EntityKind::Organization, org_id)),
        "account is a member of the organization"
    );

    let from_org = vault
        .relations_for(EntityRef::new(EntityKind::Organization, org_id))
        .expect("relations");
    assert!(
        from_org.iter().any(|r| r.kind == RelationKind::Contains),
        "organization contains the resource"
    );
}
