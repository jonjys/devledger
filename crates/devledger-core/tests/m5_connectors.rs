//! M3.5: Connect & Discover.
//!
//! The properties that matter here are about *not* doing things: not merging
//! two provider accounts, not moving a resource between them, not writing
//! anything before the user confirms, and not letting a credential out of the
//! vault.

mod common;

use common::{discovery, unlocked_vault, FAKE_TOKEN_A, FAKE_TOKEN_B};

use devledger_core::connect::reconcile::{MatchStatus, ReconcileScope};
use devledger_core::connect::{check_token_shape, AuthKind, ConnectorId};
use devledger_core::model::Provider;
use devledger_core::secret::SecretString;
use devledger_core::{CoreError, Vault};

fn supabase() -> ConnectorId {
    ConnectorId::supabase()
}

/// Connect an account and import everything the report proposes.
fn connect_and_import(
    vault: &mut Vault,
    token: &str,
    label: &str,
    disco: &devledger_core::connect::Discovery,
) -> uuid::Uuid {
    let outcome = vault
        .connect_provider(&supabase(), &SecretString::new(token), label, disco)
        .expect("connect");
    let accepted: Vec<String> = outcome
        .report
        .items
        .iter()
        .filter(|i| i.selected_by_default)
        .map(|i| i.provider_id.clone())
        .collect();
    vault
        .import_discovery(outcome.connection.id, &accepted)
        .expect("import");
    outcome.connection.id
}

#[test]
fn the_supabase_connector_is_declared_read_only_with_a_host_allowlist() {
    let (_dir, vault) = unlocked_vault();
    let connectors = vault.connectors();
    assert_eq!(connectors.len(), 1, "Supabase is the only connector so far");

    let supabase = &connectors[0];
    assert_eq!(supabase.id, ConnectorId::supabase());
    assert_eq!(supabase.provider, Provider::Supabase);
    assert!(supabase.read_only, "the connector must never write");
    assert_eq!(supabase.allowed_hosts, vec!["api.supabase.com".to_string()]);

    // It authenticates with a token the user creates, not a password.
    match &supabase.auth {
        AuthKind::PersonalAccessToken {
            create_url,
            expected_prefix,
            ..
        } => {
            assert!(create_url.starts_with("https://supabase.com/dashboard"));
            assert_eq!(expected_prefix, "sbp_");
        }
        other => panic!("expected a personal access token, got {other:?}"),
    }
}

#[test]
fn a_token_of_the_wrong_shape_is_refused_before_any_request() {
    let auth = AuthKind::PersonalAccessToken {
        create_url: "https://example.com".to_string(),
        expected_prefix: "sbp_".to_string(),
        guidance: String::new(),
    };
    assert!(check_token_shape(&auth, "sbp_abc").is_ok());
    assert!(matches!(
        check_token_shape(&auth, "").unwrap_err(),
        CoreError::Invalid(_)
    ));
    // A password, or anything else pasted by mistake, never leaves the machine.
    assert!(matches!(
        check_token_shape(&auth, "hunter2").unwrap_err(),
        CoreError::Invalid(_)
    ));
}

#[test]
fn connecting_stores_the_credential_encrypted_and_round_trips_it() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );

    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_A),
            "dev-a@example.com",
            &disco,
        )
        .expect("connect");
    assert!(!outcome.reconnected);

    let token = vault
        .connection_token(outcome.connection.id)
        .expect("read credential");
    assert_eq!(token.expose(), FAKE_TOKEN_A);

    // Reading it is audited.
    let audit = vault.recent_audit(20).expect("audit");
    assert!(audit
        .iter()
        .any(|e| e.action == "connection.use_credential"));
}

#[test]
fn the_credential_is_not_recoverable_from_the_database_file() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_A),
            "dev-a@example.com",
            &disco,
        )
        .expect("connect");
    let db_path = vault.db_path();
    vault.lock();

    let bytes = std::fs::read(&db_path).expect("read db");
    let needle = FAKE_TOKEN_A.as_bytes();
    assert!(
        !bytes.windows(needle.len()).any(|w| w == needle),
        "the connector token must not be readable in the vault file"
    );
}

#[test]
fn nothing_is_written_until_the_import_is_confirmed() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );

    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_A),
            "dev-a@example.com",
            &disco,
        )
        .expect("connect");

    // The report describes what would happen; the graph is still empty.
    assert_eq!(outcome.report.unmatched, 2, "one organization, one project");
    assert!(outcome.report.has_changes());
    assert!(
        vault.list_service_projects().expect("resources").is_empty(),
        "connecting must not import"
    );

    // Importing nothing writes nothing.
    let imported = vault
        .import_discovery(outcome.connection.id, &[])
        .expect("import none");
    assert_eq!(imported.resources_created, 0);
    assert_eq!(imported.organizations_created, 0);
    assert_eq!(imported.skipped, 2);
    assert!(vault.list_service_projects().expect("resources").is_empty());
}

#[test]
fn importing_builds_the_discovered_structure() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme"), ("org_b", "Acme Labs")],
        &[
            ("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront"),
            ("bbbbbbbbbbbbbbbbbbbb", "org_a", "Storefront Staging"),
            ("cccccccccccccccccccc", "org_b", "Internal"),
        ],
    );
    connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &disco);

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 1);
    assert_eq!(graph[0].accounts.len(), 1);

    let orgs = &graph[0].accounts[0].organizations;
    assert_eq!(orgs.len(), 2);
    let acme = orgs
        .iter()
        .find(|o| o.organization.name == "Acme")
        .expect("Acme");
    let labs = orgs
        .iter()
        .find(|o| o.organization.name == "Acme Labs")
        .expect("Acme Labs");
    assert_eq!(acme.service_projects.len(), 2);
    assert_eq!(labs.service_projects.len(), 1);

    // Provider ids are recorded, so a later discovery matches rather than duplicates.
    assert_eq!(acme.organization.provider_org_id.as_deref(), Some("org_a"));
    assert!(graph[0].accounts[0].unassigned.is_empty());
}

#[test]
fn a_second_discovery_of_the_same_account_matches_instead_of_duplicating() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    let connection_id = connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &disco);

    let report = vault
        .record_discovery(connection_id, &disco)
        .expect("refresh");
    assert_eq!(report.matched, 2, "both rows already exist");
    assert_eq!(report.unmatched, 0);
    assert!(!report.has_changes());

    let again = vault.import_discovery(connection_id, &[]).expect("import");
    assert_eq!(again.resources_created, 0);
    assert_eq!(vault.list_service_projects().expect("resources").len(), 1);
}

#[test]
fn connecting_a_second_account_does_not_touch_the_first() {
    let (_dir, mut vault) = unlocked_vault();

    let first = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    let second = discovery(
        &[("org_b", "Beta")],
        &[("bbbbbbbbbbbbbbbbbbbb", "org_b", "Dashboard")],
    );

    connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &first);
    connect_and_import(&mut vault, FAKE_TOKEN_B, "dev-b@example.com", &second);

    let connections = vault.list_connections().expect("connections");
    assert_eq!(connections.len(), 2, "two separate connections");
    assert_ne!(
        connections[0].connection.account_id, connections[1].connection.account_id,
        "each connection has its own provider account"
    );
    assert_ne!(
        connections[0].connection.identity_id, connections[1].connection.identity_id,
        "and its own identity"
    );

    // Each connection reports only its own contents.
    for summary in &connections {
        assert_eq!(summary.organization_count, 1);
        assert_eq!(summary.resource_count, 1);
    }

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 2);
    let emails: Vec<&str> = graph
        .iter()
        .filter_map(|n| n.identity.email.as_deref())
        .collect();
    assert!(emails.contains(&"dev-a@example.com"));
    assert!(emails.contains(&"dev-b@example.com"));
}

#[test]
fn reconnecting_the_same_account_refreshes_rather_than_duplicating() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &disco);

    // A newly issued token for the same account: same organizations, so the
    // same account fingerprint.
    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_B),
            "dev-a@example.com (rotated)",
            &disco,
        )
        .expect("reconnect");
    assert!(outcome.reconnected, "recognised as the same account");

    let connections = vault.list_connections().expect("connections");
    assert_eq!(connections.len(), 1, "no second connection was created");
    assert_eq!(
        connections[0].connection.label,
        "dev-a@example.com (rotated)"
    );

    // And the credential really was replaced.
    let token = vault
        .connection_token(connections[0].connection.id)
        .expect("credential");
    assert_eq!(token.expose(), FAKE_TOKEN_B);
    assert_eq!(vault.identity_graph().expect("graph").len(), 1);
}

#[test]
fn a_resource_owned_by_another_connected_account_is_a_conflict_and_is_refused() {
    let (_dir, mut vault) = unlocked_vault();

    let first = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &first);

    // A second account that can somehow see the same project ref.
    let second = discovery(
        &[("org_b", "Beta")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_b", "Storefront")],
    );
    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_B),
            "dev-b@example.com",
            &second,
        )
        .expect("connect");

    let project_row = outcome
        .report
        .items
        .iter()
        .find(|i| i.scope == ReconcileScope::Project)
        .expect("a project row");
    assert_eq!(project_row.status, MatchStatus::Conflict);
    assert!(
        !project_row.selected_by_default,
        "a conflict is never pre-ticked"
    );
    assert_eq!(outcome.report.conflicts, 1);

    // Even if the frontend sends it anyway, the import refuses it.
    let imported = vault
        .import_discovery(
            outcome.connection.id,
            &["aaaaaaaaaaaaaaaaaaaa".to_string(), "org_b".to_string()],
        )
        .expect("import");
    assert_eq!(imported.conflicts_refused, 1);
    assert_eq!(imported.resources_created, 0);

    // The resource still belongs to the first account.
    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1, "no duplicate row was created");
    let connections = vault.list_connections().expect("connections");
    let first_account = connections
        .iter()
        .find(|c| c.connection.label == "dev-a@example.com")
        .expect("first connection")
        .connection
        .account_id;
    assert_eq!(resources[0].service_project.account_id, first_account);
}

#[test]
fn connecting_the_account_smart_paste_already_knows_adopts_its_rows() {
    let (_dir, mut vault) = unlocked_vault();

    // Smart Paste records the project first, from a paste that names the email.
    let analysis = vault
        .analyze_paste(
            common::SUPABASE_FULL,
            devledger_core::redact::SourceKind::SmartPaste,
        )
        .expect("analyze");
    vault
        .commit_review(&common::accept_all(&analysis))
        .expect("commit");
    let existing_id = vault.list_service_projects().expect("resources")[0]
        .service_project
        .id;

    // Connecting with the same email reuses that identity and its Supabase
    // account, so the connector recognises the rows instead of fighting them.
    let disco = discovery(
        &[("org_a", "AcmeOrg")],
        &[("abcdefghijklmnopqrst", "org_a", "Acme Storefront")],
    );
    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_A),
            "dev-a@example.com",
            &disco,
        )
        .expect("connect");

    assert_eq!(outcome.report.conflicts, 0, "same account, so no conflict");

    let project_row = outcome
        .report
        .items
        .iter()
        .find(|i| i.scope == ReconcileScope::Project)
        .expect("a project row");
    assert_eq!(
        project_row.status,
        MatchStatus::NeedsAttention,
        "the row exists but Smart Paste could not name its organization"
    );

    let accepted: Vec<String> = outcome
        .report
        .items
        .iter()
        .filter(|i| i.selected_by_default)
        .map(|i| i.provider_id.clone())
        .collect();
    vault
        .import_discovery(outcome.connection.id, &accepted)
        .expect("import");

    // The same row was completed, not duplicated.
    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].service_project.id, existing_id);
    assert_eq!(resources[0].organization_name.as_deref(), Some("AcmeOrg"));

    // And the secrets Smart Paste stored are still reachable from the project.
    let projects = vault.list_projects().expect("projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].secret_count, 3);
}

#[test]
fn an_unassigned_resource_under_the_same_account_is_filled_in_by_import() {
    let (_dir, mut vault) = unlocked_vault();

    // Connect, but import only the project, leaving it with no organization.
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_A),
            "dev-a@example.com",
            &disco,
        )
        .expect("connect");
    vault
        .import_discovery(outcome.connection.id, &["aaaaaaaaaaaaaaaaaaaa".to_string()])
        .expect("import project only");

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    assert_eq!(
        resources[0].organization_name, None,
        "organization was skipped"
    );

    // Re-reconciling now offers to fill the gap in.
    let report = vault
        .record_discovery(outcome.connection.id, &disco)
        .expect("refresh");
    let project_row = report
        .items
        .iter()
        .find(|i| i.scope == ReconcileScope::Project)
        .expect("project row");
    assert_eq!(project_row.status, MatchStatus::NeedsAttention);
    assert!(project_row.selected_by_default);

    let accepted: Vec<String> = report
        .items
        .iter()
        .filter(|i| i.selected_by_default)
        .map(|i| i.provider_id.clone())
        .collect();
    let imported = vault
        .import_discovery(outcome.connection.id, &accepted)
        .expect("import");
    assert_eq!(imported.organizations_created, 1);
    assert_eq!(imported.resources_updated, 1);

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources[0].organization_name.as_deref(), Some("Acme"));
}

#[test]
fn a_renamed_project_is_reported_and_updated_not_duplicated() {
    let (_dir, mut vault) = unlocked_vault();
    let before = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    let connection_id = connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &before);

    let after = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront v2")],
    );
    let report = vault
        .record_discovery(connection_id, &after)
        .expect("refresh");
    let project_row = report
        .items
        .iter()
        .find(|i| i.scope == ReconcileScope::Project)
        .expect("project row");
    assert_eq!(project_row.status, MatchStatus::NeedsAttention);
    assert!(project_row.detail.contains("Storefront v2"));

    vault
        .import_discovery(connection_id, &["aaaaaaaaaaaaaaaaaaaa".to_string()])
        .expect("import");

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1, "renamed, not duplicated");
    assert_eq!(resources[0].service_project.name, "Storefront v2");
}

#[test]
fn disconnecting_removes_the_credential_but_keeps_what_was_imported() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    let connection_id = connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &disco);

    vault.disconnect(connection_id).expect("disconnect");

    assert!(vault.list_connections().expect("connections").is_empty());
    assert!(matches!(
        vault.connection_token(connection_id).unwrap_err(),
        CoreError::NotFound(_)
    ));

    // The map keeps what was learned.
    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].organization_name.as_deref(), Some("Acme"));
}

#[test]
fn a_locked_vault_refuses_every_connector_operation() {
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(
        &[("org_a", "Acme")],
        &[("aaaaaaaaaaaaaaaaaaaa", "org_a", "Storefront")],
    );
    let connection_id = connect_and_import(&mut vault, FAKE_TOKEN_A, "dev-a@example.com", &disco);
    vault.lock();

    assert!(matches!(
        vault.list_connections().unwrap_err(),
        CoreError::VaultLocked
    ));
    assert!(matches!(
        vault.connection_token(connection_id).unwrap_err(),
        CoreError::VaultLocked
    ));
    assert!(matches!(
        vault.import_discovery(connection_id, &[]).unwrap_err(),
        CoreError::VaultLocked
    ));
}

#[test]
fn a_project_whose_organization_is_not_visible_is_still_discovered() {
    // A scoped token that can read projects but not organizations.
    let (_dir, mut vault) = unlocked_vault();
    let disco = discovery(&[], &[("aaaaaaaaaaaaaaaaaaaa", "", "Storefront")]);

    let outcome = vault
        .connect_provider(
            &supabase(),
            &SecretString::new(FAKE_TOKEN_A),
            "dev-a@example.com",
            &disco,
        )
        .expect("connect");

    assert_eq!(outcome.report.items.len(), 1, "the project still shows up");
    assert_eq!(outcome.report.items[0].status, MatchStatus::Unmatched);

    vault
        .import_discovery(outcome.connection.id, &["aaaaaaaaaaaaaaaaaaaa".to_string()])
        .expect("import");

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    assert_eq!(
        resources[0].organization_name, None,
        "no organization is invented for it"
    );
}
