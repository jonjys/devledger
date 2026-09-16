//! The connector's real HTTP path, executed against a local server.
//!
//! The payloads below are the *shapes* the Supabase Management API actually
//! returns -- captured from a live account and then renamed, so the structure is
//! real while none of the content is anyone's. That matters: an earlier version
//! of this parser read `id` where the canonical field is `ref`, and only looking
//! at a real response caught it.

mod http_harness;

use devledger_connect::supabase::SupabaseClient;
use devledger_connect::ConnectError;
use http_harness::{Route, TestServer};

/// `GET /v1/projects`, with every field the real API includes.
const PROJECTS: &str = r#"[
  {
    "id": "aaaaaaaaaaaaaaaaaaaa",
    "ref": "aaaaaaaaaaaaaaaaaaaa",
    "organization_id": "oooooooooooooooooooo",
    "organization_slug": "oooooooooooooooooooo",
    "name": "Storefront",
    "region": "eu-west-1",
    "status": "ACTIVE_HEALTHY",
    "database": {
      "host": "db.aaaaaaaaaaaaaaaaaaaa.supabase.co",
      "version": "17.6.1.155",
      "postgres_engine": "17",
      "release_channel": "ga"
    },
    "created_at": "2026-08-15T00:48:26.005267Z"
  },
  {
    "id": "bbbbbbbbbbbbbbbbbbbb",
    "ref": "bbbbbbbbbbbbbbbbbbbb",
    "organization_id": "oooooooooooooooooooo",
    "organization_slug": "oooooooooooooooooooo",
    "name": "Archived Thing",
    "region": "eu-west-1",
    "status": "INACTIVE",
    "database": {
      "host": "db.bbbbbbbbbbbbbbbbbbbb.supabase.co",
      "version": "17.6.1.155",
      "postgres_engine": "17",
      "release_channel": "ga"
    },
    "created_at": "2026-08-06T14:03:45.969156Z"
  }
]"#;

/// `GET /v1/organizations`, with the `slug` the real API includes.
const ORGANIZATIONS: &str = r#"[
  { "id": "oooooooooooooooooooo", "slug": "oooooooooooooooooooo", "name": "Example Org" }
]"#;

const TOKEN: &str = "sbp_0000000000000000000000000000000000000001";

fn healthy_server() -> TestServer {
    TestServer::start(vec![
        ("/v1/projects", Route::ok(PROJECTS)),
        ("/v1/organizations", Route::ok(ORGANIZATIONS)),
    ])
}

#[tokio::test]
async fn discovery_runs_end_to_end_over_real_http() {
    let server = healthy_server();
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let discovery = client.discover(TOKEN).await.expect("discover");

    assert_eq!(discovery.organizations.len(), 1);
    assert_eq!(
        discovery.organizations[0].provider_org_id,
        "oooooooooooooooooooo"
    );
    assert_eq!(
        discovery.organizations[0].slug.as_deref(),
        Some("oooooooooooooooooooo")
    );
    assert_eq!(discovery.organizations[0].name, "Example Org");

    assert_eq!(discovery.projects.len(), 2);
    let storefront = &discovery.projects[0];
    assert_eq!(storefront.provider_ref, "aaaaaaaaaaaaaaaaaaaa");
    assert_eq!(storefront.provider_org_id, "oooooooooooooooooooo");
    assert_eq!(storefront.name, "Storefront");
    assert_eq!(storefront.region.as_deref(), Some("eu-west-1"));
    assert_eq!(
        storefront.database_host.as_deref(),
        Some("db.aaaaaaaaaaaaaaaaaaaa.supabase.co")
    );
    assert!(storefront.is_active());

    // A paused project is reported as such rather than silently looking live.
    assert!(!discovery.projects[1].is_active());
}

#[tokio::test]
async fn the_request_carries_the_bearer_token_and_identifies_devledger() {
    let server = healthy_server();
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");
    client.discover(TOKEN).await.expect("discover");

    let requests = server.requests();
    assert_eq!(requests.len(), 2, "exactly two requests, no more");

    for request in &requests {
        assert_eq!(request.method, "GET", "the connector must only ever read");
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {TOKEN}").as_str()),
            "the token is sent as a bearer credential"
        );
        assert_eq!(request.header("accept"), Some("application/json"));
        let agent = request.header("user-agent").unwrap_or_default();
        assert!(agent.starts_with("DevLedger/"), "got {agent:?}");
    }

    // Projects first, so a narrowly scoped token fails against the useful call.
    assert_eq!(requests[0].path, "/v1/projects");
    assert_eq!(requests[1].path, "/v1/organizations");
}

#[tokio::test]
async fn a_rejected_token_is_reported_as_unauthorized() {
    let server = TestServer::start(vec![("/v1/projects", Route::status(401))]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    assert!(matches!(error, ConnectError::Unauthorized), "got {error:?}");
    assert!(error.to_string().contains("revoked"));

    // It gave up after the first failure rather than spending a second request.
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn a_scoped_token_that_cannot_list_organizations_still_discovers_projects() {
    // Exactly what a read-only token scoped to project settings looks like.
    let server = TestServer::start(vec![
        ("/v1/projects", Route::ok(PROJECTS)),
        ("/v1/organizations", Route::status(403)),
    ]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let discovery = client.discover(TOKEN).await.expect("partial discovery");
    assert!(discovery.organizations.is_empty());
    assert_eq!(discovery.projects.len(), 2);

    // The projects are still usable; their organization is simply unknown.
    assert_eq!(discovery.orphan_projects().len(), 2);
}

#[tokio::test]
async fn a_forbidden_projects_call_is_a_real_failure() {
    // Being unable to read projects at all is not a partial success.
    let server = TestServer::start(vec![("/v1/projects", Route::status(403))]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    assert!(matches!(error, ConnectError::Forbidden(_)), "got {error:?}");
    assert!(error.to_string().contains("permission"));
}

#[tokio::test]
async fn rate_limiting_is_reported_as_itself() {
    let server = TestServer::start(vec![("/v1/projects", Route::status(429))]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    assert!(matches!(error, ConnectError::RateLimited));
    assert!(error.to_string().contains("Wait"));
}

#[tokio::test]
async fn a_server_error_is_surfaced_with_its_status() {
    let server = TestServer::start(vec![("/v1/projects", Route::status(500))]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    match error {
        ConnectError::Unexpected(message) => assert!(message.contains("500"), "{message}"),
        other => panic!("expected an unexpected-status error, got {other:?}"),
    }
}

#[tokio::test]
async fn a_redirect_is_refused_rather_than_followed() {
    // The important case: if the token followed this, it would be sent to
    // evil.test. The client must refuse instead.
    let server = TestServer::start(vec![(
        "/v1/projects",
        Route::redirect("https://evil.test/v1/projects"),
    )]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    match error {
        ConnectError::Unexpected(message) => {
            assert!(message.contains("redirect"), "{message}");
        }
        other => panic!("expected a redirect refusal, got {other:?}"),
    }

    // Only the original request was made; nothing was re-sent.
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn a_malformed_body_is_an_error_not_a_panic() {
    // Both endpoints answer, so the failure is genuinely the parse and not a
    // missing route masking it.
    let server = TestServer::start(vec![
        (
            "/v1/projects",
            Route::ok("<html>a login page, not JSON</html>"),
        ),
        ("/v1/organizations", Route::ok(ORGANIZATIONS)),
    ]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    match error {
        ConnectError::Malformed(message) => assert!(message.contains("projects"), "{message}"),
        other => panic!("expected a malformed-body error, got {other:?}"),
    }
}

#[tokio::test]
async fn a_json_body_of_the_wrong_shape_is_rejected_rather_than_read_as_empty() {
    // An object that is not an envelope must not silently become "no projects":
    // that would look like a successful discovery of nothing.
    let server = TestServer::start(vec![
        ("/v1/projects", Route::ok(r#"{"message":"Not found"}"#)),
        ("/v1/organizations", Route::ok(ORGANIZATIONS)),
    ]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    assert!(matches!(error, ConnectError::Malformed(_)), "got {error:?}");
}

#[tokio::test]
async fn an_unknown_endpoint_is_not_mistaken_for_a_permission_problem() {
    // 403 on organizations is a scoped token and degrades gracefully. A 404 is
    // the API having changed, which should be loud.
    let server = TestServer::start(vec![("/v1/projects", Route::ok(PROJECTS))]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let error = client.discover(TOKEN).await.unwrap_err();
    match error {
        ConnectError::Unexpected(message) => assert!(message.contains("404"), "{message}"),
        other => panic!("expected an unexpected-status error, got {other:?}"),
    }
}

#[tokio::test]
async fn an_enveloped_response_is_accepted_too() {
    // The bare array is what the API returns today; an object wrapping it is
    // what a paginated version would most likely look like.
    let server = TestServer::start(vec![
        (
            "/v1/projects",
            Route::ok(&format!(r#"{{"projects": {PROJECTS}}}"#)),
        ),
        (
            "/v1/organizations",
            Route::ok(&format!(r#"{{"organizations": {ORGANIZATIONS}}}"#)),
        ),
    ]);
    let client = SupabaseClient::for_loopback_testing(&server.base).expect("client");

    let discovery = client.discover(TOKEN).await.expect("discover");
    assert_eq!(discovery.projects.len(), 2);
    assert_eq!(discovery.organizations.len(), 1);
}

#[tokio::test]
async fn the_test_client_cannot_be_pointed_at_a_remote_host() {
    // The loopback constructor is the only way to relax the allowlist, and it
    // refuses anything that is not this machine.
    for base in [
        "https://api.supabase.com",
        "http://evil.test",
        "https://127.0.0.1.evil.test",
    ] {
        let error = SupabaseClient::for_loopback_testing(base).unwrap_err();
        assert!(
            matches!(error, ConnectError::HostNotAllowed(_)),
            "{base} should be refused, got {error:?}"
        );
    }

    assert!(SupabaseClient::for_loopback_testing("http://127.0.0.1:1234").is_ok());
    assert!(SupabaseClient::for_loopback_testing("http://localhost:1234").is_ok());
}

#[tokio::test]
async fn the_production_client_targets_only_the_management_api() {
    let client = SupabaseClient::production().expect("client");
    // Nothing is sent: constructing it is enough to prove the base and
    // allowlist agree, since `get` checks the base against the allowlist.
    drop(client);

    assert!(devledger_connect::check_host(
        "https://api.supabase.com/v1/projects",
        devledger_connect::supabase::ALLOWED_HOSTS
    )
    .is_ok());
    assert!(devledger_connect::check_host(
        "http://api.supabase.com/v1/projects",
        devledger_connect::supabase::ALLOWED_HOSTS
    )
    .is_err());
}
