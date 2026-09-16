//! The whole Connect & Discover pipeline, end to end.
//!
//! A local HTTP server stands in for the Management API; everything after that
//! is the real code: the real connector issuing real requests, the real vault
//! sealing the credential into a real SQLCipher database, the real
//! reconciliation and the real import.
//!
//! This is the test that would have caught `id` vs `ref`, and it is the closest
//! this environment can get to the live API — outbound access to
//! `api.supabase.com` is blocked by the sandbox's egress policy.

mod http_harness;

use devledger_connect::supabase::SupabaseClient;
use devledger_core::connect::reconcile::MatchStatus;
use devledger_core::connect::ConnectorId;
use devledger_core::crypto::kdf::KdfParams;
use devledger_core::secret::SecretString;
use devledger_core::Vault;
use http_harness::{Route, TestServer};
use tempfile::TempDir;

const TOKEN: &str = "sbp_0000000000000000000000000000000000000001";
const SECOND_TOKEN: &str = "sbp_0000000000000000000000000000000000000002";

/// One organization, two projects, one of them paused.
const ACCOUNT_A_PROJECTS: &str = r#"[
  {
    "id": "aaaaaaaaaaaaaaaaaaaa", "ref": "aaaaaaaaaaaaaaaaaaaa",
    "organization_id": "oooooooooooooooooooo", "organization_slug": "oooooooooooooooooooo",
    "name": "Storefront", "region": "eu-west-1", "status": "ACTIVE_HEALTHY",
    "database": { "host": "db.aaaaaaaaaaaaaaaaaaaa.supabase.co", "version": "17.6.1.155" },
    "created_at": "2026-08-15T00:48:26.005267Z"
  },
  {
    "id": "bbbbbbbbbbbbbbbbbbbb", "ref": "bbbbbbbbbbbbbbbbbbbb",
    "organization_id": "oooooooooooooooooooo", "organization_slug": "oooooooooooooooooooo",
    "name": "Old Prototype", "region": "eu-west-1", "status": "INACTIVE",
    "database": { "host": "db.bbbbbbbbbbbbbbbbbbbb.supabase.co", "version": "17.6.1.155" },
    "created_at": "2026-08-06T14:03:45.969156Z"
  }
]"#;

const ACCOUNT_A_ORGS: &str = r#"[
  { "id": "oooooooooooooooooooo", "slug": "oooooooooooooooooooo", "name": "Example Org" }
]"#;

/// A different account entirely: different organization, different project.
const ACCOUNT_B_PROJECTS: &str = r#"[
  {
    "id": "cccccccccccccccccccc", "ref": "cccccccccccccccccccc",
    "organization_id": "pppppppppppppppppppp", "organization_slug": "pppppppppppppppppppp",
    "name": "Side Project", "region": "us-east-1", "status": "ACTIVE_HEALTHY",
    "database": { "host": "db.cccccccccccccccccccc.supabase.co", "version": "17.6.1.155" },
    "created_at": "2026-09-01T00:00:00.000000Z"
  }
]"#;

const ACCOUNT_B_ORGS: &str = r#"[
  { "id": "pppppppppppppppppppp", "slug": "pppppppppppppppppppp", "name": "Second Org" }
]"#;

fn vault() -> (TempDir, Vault) {
    let dir = TempDir::new().expect("temp dir");
    let mut vault = Vault::new(dir.path());
    vault
        .initialize_with_params(
            &SecretString::new("correct-horse-battery-staple"),
            KdfParams::weak_for_tests().expect("params"),
        )
        .expect("initialize");
    (dir, vault)
}

fn server_for(projects: &'static str, orgs: &'static str) -> TestServer {
    TestServer::start(vec![
        ("/v1/projects", Route::ok(projects)),
        ("/v1/organizations", Route::ok(orgs)),
    ])
}

/// Connect through the real connector, then import everything pre-selected.
async fn connect_and_import(
    vault: &mut Vault,
    server: &TestServer,
    token: &str,
    label: &str,
) -> uuid::Uuid {
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");
    let discovery = client.discover(token).await.expect("discover");

    let outcome = vault
        .connect_provider(
            &ConnectorId::supabase(),
            &SecretString::new(token),
            label,
            &discovery,
        )
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

#[tokio::test]
async fn a_real_discovery_becomes_a_real_graph() {
    let (_dir, mut vault) = vault();
    let server = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);

    connect_and_import(&mut vault, &server, TOKEN, "dev-a@example.com").await;

    // Identity -> account -> organization -> resources, built from the API.
    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 1);
    assert_eq!(
        graph[0].identity.email.as_deref(),
        Some("dev-a@example.com")
    );
    assert_eq!(graph[0].accounts.len(), 1);

    let orgs = &graph[0].accounts[0].organizations;
    assert_eq!(orgs.len(), 1);
    assert_eq!(orgs[0].organization.name, "Example Org");
    assert_eq!(
        orgs[0].organization.provider_org_id.as_deref(),
        Some("oooooooooooooooooooo")
    );
    assert_eq!(orgs[0].service_projects.len(), 2);

    // The provider's own facts came across, including the region.
    let storefront = orgs[0]
        .service_projects
        .iter()
        .find(|s| s.service_project.name == "Storefront")
        .expect("Storefront");
    assert_eq!(
        storefront.service_project.provider_ref.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(
        storefront.service_project.region.as_deref(),
        Some("eu-west-1")
    );

    // Nothing was left unassigned, and nothing needs attention.
    assert!(graph[0].accounts[0].unassigned.is_empty());
    assert!(vault
        .needs_attention()
        .expect("attention")
        .iter()
        .all(|a| a.kind != devledger_core::store::AttentionKind::UnassignedOrganization));
}

#[tokio::test]
async fn a_paused_project_is_imported_but_flagged_as_paused() {
    let (_dir, mut vault) = vault();
    let server = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);

    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");
    let discovery = client.discover(TOKEN).await.expect("discover");
    let outcome = vault
        .connect_provider(
            &ConnectorId::supabase(),
            &SecretString::new(TOKEN),
            "dev-a@example.com",
            &discovery,
        )
        .expect("connect");

    assert_eq!(outcome.report.paused, 1, "one project is INACTIVE");
    let paused = outcome
        .report
        .items
        .iter()
        .find(|i| i.name == "Old Prototype")
        .expect("the paused project");
    assert!(!paused.active_at_provider);
    assert_eq!(paused.status_at_provider.as_deref(), Some("INACTIVE"));
    assert!(paused.detail.contains("INACTIVE"), "{}", paused.detail);

    // It is still offered for import: losing track of it is the actual problem.
    assert!(paused.selected_by_default);
}

#[tokio::test]
async fn the_credential_survives_a_lock_and_still_refreshes() {
    let (dir, mut vault) = vault();
    let server = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);
    let connection_id = connect_and_import(&mut vault, &server, TOKEN, "dev-a@example.com").await;

    // Lock, drop, reopen: the sealed credential must still decrypt.
    vault.lock();
    let mut reopened = Vault::new(dir.path());
    reopened
        .unlock(&SecretString::new("correct-horse-battery-staple"))
        .expect("unlock");

    let token = reopened
        .connection_token(connection_id)
        .expect("stored credential");
    assert_eq!(token.expose(), TOKEN);

    // And it still works against the provider.
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");
    let discovery = client.discover(token.expose()).await.expect("refresh");
    let report = reopened
        .record_discovery(connection_id, &discovery)
        .expect("record");

    assert_eq!(report.unmatched, 0, "everything is already known");
    assert!(!report.has_changes());
}

#[tokio::test]
async fn two_real_accounts_stay_separate_end_to_end() {
    let (_dir, mut vault) = vault();
    let server_a = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);
    let server_b = server_for(ACCOUNT_B_PROJECTS, ACCOUNT_B_ORGS);

    connect_and_import(&mut vault, &server_a, TOKEN, "dev-a@example.com").await;
    connect_and_import(&mut vault, &server_b, SECOND_TOKEN, "dev-b@example.com").await;

    let connections = vault.list_connections().expect("connections");
    assert_eq!(connections.len(), 2);
    assert_ne!(
        connections[0].connection.account_id,
        connections[1].connection.account_id
    );

    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 2, "two identities");

    // Each account sees only its own organization and resources.
    for node in &graph {
        assert_eq!(node.accounts.len(), 1);
        assert_eq!(node.accounts[0].organizations.len(), 1);
    }
    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 3, "two from A, one from B");

    // And each credential is still individually recoverable.
    for summary in &connections {
        let token = vault
            .connection_token(summary.connection.id)
            .expect("credential");
        assert!(token.expose().starts_with("sbp_"));
    }
}

#[tokio::test]
async fn a_project_renamed_at_the_provider_is_updated_on_refresh() {
    let (_dir, mut vault) = vault();
    let before = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);
    let connection_id = connect_and_import(&mut vault, &before, TOKEN, "dev-a@example.com").await;
    drop(before);

    // The same account, with Storefront renamed at the provider.
    const RENAMED: &str = r#"[
      {
        "id": "aaaaaaaaaaaaaaaaaaaa", "ref": "aaaaaaaaaaaaaaaaaaaa",
        "organization_id": "oooooooooooooooooooo",
        "name": "Storefront (v2)", "region": "eu-west-1", "status": "ACTIVE_HEALTHY",
        "database": { "host": "db.aaaaaaaaaaaaaaaaaaaa.supabase.co" }
      }
    ]"#;
    let after = server_for(RENAMED, ACCOUNT_A_ORGS);

    let client = SupabaseClient::for_loopback_testing(&after.base).expect("client");
    let discovery = client.discover(TOKEN).await.expect("discover");
    let report = vault
        .record_discovery(connection_id, &discovery)
        .expect("record");

    let row = report
        .items
        .iter()
        .find(|i| i.provider_id == "aaaaaaaaaaaaaaaaaaaa")
        .expect("the renamed project");
    assert_eq!(row.status, MatchStatus::NeedsAttention);
    assert!(row.detail.contains("Storefront (v2)"), "{}", row.detail);

    vault
        .import_discovery(connection_id, &["aaaaaaaaaaaaaaaaaaaa".to_string()])
        .expect("import");

    let resources = vault.list_service_projects().expect("resources");
    let renamed = resources
        .iter()
        .find(|r| r.service_project.provider_ref.as_deref() == Some("aaaaaaaaaaaaaaaaaaaa"))
        .expect("found");
    assert_eq!(renamed.service_project.name, "Storefront (v2)");
    assert_eq!(resources.len(), 2, "renamed in place, not duplicated");
}

#[tokio::test]
async fn a_revoked_token_fails_the_refresh_without_damaging_the_graph() {
    let (_dir, mut vault) = vault();
    let server = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);
    let connection_id = connect_and_import(&mut vault, &server, TOKEN, "dev-a@example.com").await;
    drop(server);

    // The provider now rejects the token.
    let revoked = TestServer::start(vec![("/v1/projects", Route::status(401))]);
    let client = SupabaseClient::for_loopback_testing(&revoked.base).expect("client");
    let error = client.discover(TOKEN).await.unwrap_err();
    assert!(matches!(
        error,
        devledger_connect::ConnectError::Unauthorized
    ));

    // The failure is upstream of the vault, so nothing was lost.
    assert_eq!(vault.list_service_projects().expect("resources").len(), 2);
    assert_eq!(vault.list_connections().expect("connections").len(), 1);
    assert!(vault.connection_token(connection_id).is_ok());
}

#[tokio::test]
async fn a_scoped_token_produces_unassigned_resources_and_says_so() {
    let (_dir, mut vault) = vault();
    // Can read projects, cannot read organizations.
    let server = TestServer::start(vec![
        ("/v1/projects", Route::ok(ACCOUNT_A_PROJECTS)),
        ("/v1/organizations", Route::status(403)),
    ]);

    connect_and_import(&mut vault, &server, TOKEN, "dev-a@example.com").await;

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 2);
    for resource in &resources {
        assert_eq!(
            resource.organization_name, None,
            "no organization is invented for a scoped token"
        );
    }

    let attention = vault.needs_attention().expect("attention");
    assert!(attention
        .iter()
        .any(|a| a.kind == devledger_core::store::AttentionKind::UnassignedOrganization));
}

#[tokio::test]
async fn the_connector_never_writes_to_the_provider() {
    let (_dir, mut vault) = vault();
    let server = server_for(ACCOUNT_A_PROJECTS, ACCOUNT_A_ORGS);

    let connection_id = connect_and_import(&mut vault, &server, TOKEN, "dev-a@example.com").await;
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");
    let discovery = client.discover(TOKEN).await.expect("refresh");
    vault
        .record_discovery(connection_id, &discovery)
        .expect("record");
    vault
        .import_discovery(connection_id, &[])
        .expect("import nothing");

    // Across connect, refresh and import, every request the provider saw was a
    // read of one of the two documented endpoints.
    let requests = server.requests();
    assert!(!requests.is_empty());
    for request in &requests {
        assert_eq!(request.method, "GET", "saw a {} request", request.method);
        assert!(
            request.path == "/v1/projects" || request.path == "/v1/organizations",
            "unexpected path {}",
            request.path
        );
    }
}
