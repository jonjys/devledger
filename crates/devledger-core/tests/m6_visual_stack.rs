//! Visual stack editor: manual entry must build the same semantic graph as discovery.

mod common;

use devledger_core::model::{Environment, Provider};
use devledger_core::secret::SecretString;

#[test]
fn manual_stack_entries_round_trip_through_the_graph() {
    let (_dir, mut vault) = common::unlocked_vault();

    let identity = vault
        .create_identity_manual("Work", Some("Dev@Example.com"))
        .expect("identity");
    assert_eq!(identity.email.as_deref(), Some("dev@example.com"));

    let account = vault
        .create_account_manual(identity.id, Provider::Vercel, "Vercel · Work")
        .expect("account");
    let org = vault
        .create_organization(account.id, "Nytto Labs")
        .expect("organization");
    let resource = vault
        .create_service_project_manual(
            account.id,
            Some(org.id),
            Provider::Vercel,
            "example-app",
            Some("prj_example"),
            Environment::Production,
        )
        .expect("resource");
    let project = vault.create_project("Example", None).expect("project");
    vault
        .link_service_project(resource.id, project.id)
        .expect("link");

    let secret = vault
        .create_manual_secret(
            None,
            Some(resource.id),
            "EXAMPLE_API_KEY",
            Environment::Production,
            &SecretString::new("secret-test-value-123"),
        )
        .expect("secret");
    assert_eq!(secret.service_project_id, Some(resource.id));

    let graph = vault.identity_graph().expect("graph");
    let node = graph
        .iter()
        .find(|node| node.identity.id == identity.id)
        .expect("identity in graph");
    let account_node = node
        .accounts
        .iter()
        .find(|node| node.account.id == account.id)
        .expect("account in graph");
    let resource_summary = account_node
        .organizations
        .iter()
        .flat_map(|node| &node.service_projects)
        .find(|summary| summary.service_project.id == resource.id)
        .expect("resource in graph");

    assert_eq!(resource_summary.secret_count, 1);
    assert_eq!(resource_summary.used_by.len(), 1);
    assert_eq!(resource_summary.used_by[0].id, project.id);
}

#[test]
fn env_export_separates_environments_and_rejects_conflicts() {
    let (_dir, mut vault) = common::unlocked_vault();
    let identity = vault
        .create_identity_manual("Work", Some("dev@example.com"))
        .unwrap();
    let account = vault
        .create_account_manual(identity.id, Provider::Vercel, "Vercel")
        .unwrap();
    let project = vault.create_project("App", None).unwrap();

    for (name, environment, value) in [
        ("production", Environment::Production, "prod-value"),
        ("staging", Environment::Staging, "stage-value"),
    ] {
        let resource = vault
            .create_service_project_manual(
                account.id,
                None,
                Provider::Vercel,
                name,
                None,
                environment,
            )
            .unwrap();
        vault.link_service_project(resource.id, project.id).unwrap();
        vault
            .create_manual_secret(
                None,
                Some(resource.id),
                "SHARED_KEY",
                environment,
                &SecretString::new(value),
            )
            .unwrap();
    }

    let error = vault.export_env(project.id).unwrap_err().to_string();
    assert!(error.contains("SHARED_KEY has conflicting values"));

    let production = vault
        .export_env_for_environment(project.id, Some(Environment::Production))
        .unwrap();
    assert_eq!(production.expose(), "SHARED_KEY=prod-value\n");
    assert!(!production.expose().contains("stage-value"));
}

#[test]
fn manual_email_entry_deduplicates_case_insensitively() {
    let (_dir, vault) = common::unlocked_vault();

    let first = vault
        .create_identity_manual("", Some("Dev@Example.com"))
        .expect("first");
    let second = vault
        .create_identity_manual("Different label", Some("dev@example.com"))
        .expect("second");

    assert_eq!(first.id, second.id);
}

#[test]
fn a_resource_cannot_be_assigned_to_another_accounts_organization() {
    let (_dir, vault) = common::unlocked_vault();

    let a = vault
        .create_identity_manual("", Some("a@example.com"))
        .expect("identity a");
    let b = vault
        .create_identity_manual("", Some("b@example.com"))
        .expect("identity b");
    let account_a = vault
        .create_account_manual(a.id, Provider::Supabase, "Supabase A")
        .expect("account a");
    let account_b = vault
        .create_account_manual(b.id, Provider::Supabase, "Supabase B")
        .expect("account b");
    let org_a = vault
        .create_organization(account_a.id, "Org A")
        .expect("org a");

    let error = vault
        .create_service_project_manual(
            account_b.id,
            Some(org_a.id),
            Provider::Supabase,
            "wrong-home",
            None,
            Environment::Unknown,
        )
        .expect_err("cross-account organization must be rejected");

    assert!(error.to_string().contains("does not belong"));
}
