//! The Supabase connector's pure parts: host allowlisting and response parsing.
//!
//! These run without a network or a mock server, which is possible because the
//! HTTP call is a thin wrapper around functions that take strings.

use devledger_connect::supabase::{
    build_discovery, parse_organizations, parse_projects, ALLOWED_HOSTS, API_BASE,
};
use devledger_connect::{check_host, ConnectError};

/// A response shaped like the Management API's, including fields DevLedger
/// ignores, to prove unknown fields do not break discovery.
const PROJECTS_JSON: &str = r#"[
  {
    "id": "abcdefghijklmnopqrst",
    "organization_id": "org_a",
    "name": "Storefront",
    "region": "eu-west-1",
    "created_at": "2026-01-01T00:00:00Z",
    "status": "ACTIVE_HEALTHY",
    "database": { "host": "db.abcdefghijklmnopqrst.supabase.co", "version": "15" }
  },
  {
    "id": "zyxwvutsrqponmlkjihg",
    "organization_id": "org_b",
    "name": "Internal",
    "region": "us-east-1",
    "status": "INACTIVE"
  }
]"#;

const ORGS_JSON: &str = r#"[
  { "id": "org_a", "name": "Acme", "billing_email": "billing@example.com" },
  { "id": "org_b", "name": "Acme Labs" }
]"#;

#[test]
fn the_allowlist_admits_only_the_management_api_over_https() {
    assert!(check_host(&format!("{API_BASE}/v1/projects"), ALLOWED_HOSTS).is_ok());

    // A different host, however plausible.
    assert!(matches!(
        check_host(
            "https://api.supabase.com.evil.test/v1/projects",
            ALLOWED_HOSTS
        )
        .unwrap_err(),
        ConnectError::HostNotAllowed(_)
    ));
    assert!(matches!(
        check_host("https://supabase.com/v1/projects", ALLOWED_HOSTS).unwrap_err(),
        ConnectError::HostNotAllowed(_)
    ));

    // Plain HTTP is refused outright: a bearer token must never go out in the clear.
    assert!(matches!(
        check_host("http://api.supabase.com/v1/projects", ALLOWED_HOSTS).unwrap_err(),
        ConnectError::HostNotAllowed(_)
    ));

    // And anything that is not a URL.
    assert!(check_host("not a url", ALLOWED_HOSTS).is_err());
}

#[test]
fn organizations_parse_and_ignore_unknown_fields() {
    let orgs = parse_organizations(ORGS_JSON).expect("parse");
    assert_eq!(orgs.len(), 2);
    assert_eq!(orgs[0].provider_org_id, "org_a");
    assert_eq!(orgs[0].name, "Acme");
}

#[test]
fn a_nameless_organization_falls_back_to_its_id() {
    let orgs = parse_organizations(r#"[{ "id": "org_x" }]"#).expect("parse");
    assert_eq!(orgs[0].name, "org_x", "never renders an empty name");
}

#[test]
fn projects_parse_with_region_and_status() {
    let projects = parse_projects(PROJECTS_JSON).expect("parse");
    assert_eq!(projects.len(), 2);

    let storefront = &projects[0];
    assert_eq!(storefront.provider_ref, "abcdefghijklmnopqrst");
    assert_eq!(storefront.provider_org_id, "org_a");
    assert_eq!(storefront.name, "Storefront");
    assert_eq!(storefront.region.as_deref(), Some("eu-west-1"));
    assert_eq!(storefront.status.as_deref(), Some("ACTIVE_HEALTHY"));
}

#[test]
fn a_project_with_no_organization_is_kept_rather_than_dropped() {
    let projects =
        parse_projects(r#"[{ "id": "aaaaaaaaaaaaaaaaaaaa", "name": "Orphan" }]"#).expect("parse");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].provider_org_id, "");
}

#[test]
fn a_malformed_body_is_an_error_not_a_panic() {
    assert!(matches!(
        parse_projects("not json").unwrap_err(),
        ConnectError::Malformed(_)
    ));
    assert!(matches!(
        parse_organizations(r#"{"unexpected":"object"}"#).unwrap_err(),
        ConnectError::Malformed(_)
    ));
}

#[test]
fn a_discovery_is_stable_regardless_of_the_order_the_api_replied_in() {
    let forward = build_discovery(ORGS_JSON, PROJECTS_JSON).expect("build");

    let reversed_orgs = r#"[
      { "id": "org_b", "name": "Acme Labs" },
      { "id": "org_a", "name": "Acme" }
    ]"#;
    let reversed_projects = r#"[
      { "id": "zyxwvutsrqponmlkjihg", "organization_id": "org_b", "name": "Internal", "region": "us-east-1", "status": "INACTIVE" },
      { "id": "abcdefghijklmnopqrst", "organization_id": "org_a", "name": "Storefront", "region": "eu-west-1", "status": "ACTIVE_HEALTHY" }
    ]"#;
    let backward = build_discovery(reversed_orgs, reversed_projects).expect("build");

    assert_eq!(
        forward, backward,
        "discovery must not depend on reply order"
    );
}

#[test]
fn a_discovery_groups_projects_under_their_organization() {
    let discovery = build_discovery(ORGS_JSON, PROJECTS_JSON).expect("build");
    assert_eq!(discovery.projects_in("org_a").len(), 1);
    assert_eq!(discovery.projects_in("org_b").len(), 1);
    assert!(discovery.orphan_projects().is_empty());
}

#[test]
fn a_project_whose_organization_is_invisible_is_reported_as_an_orphan() {
    // What a narrowly scoped token sees: projects, but no organizations.
    let discovery = build_discovery("[]", PROJECTS_JSON).expect("build");
    assert!(discovery.organizations.is_empty());
    assert_eq!(discovery.orphan_projects().len(), 2);
}

#[test]
fn the_account_fingerprint_identifies_the_account_not_the_token() {
    let a = build_discovery(ORGS_JSON, PROJECTS_JSON).expect("build");

    // The same account seen through a token with different project visibility
    // still fingerprints the same, because the organizations are the same.
    let fewer_projects =
        r#"[{ "id": "abcdefghijklmnopqrst", "organization_id": "org_a", "name": "Storefront" }]"#;
    let b = build_discovery(ORGS_JSON, fewer_projects).expect("build");
    assert_eq!(a.fingerprint_material(), b.fingerprint_material());

    // A different account fingerprints differently.
    let other = build_discovery(r#"[{ "id": "org_z", "name": "Other" }]"#, "[]").expect("build");
    assert_ne!(a.fingerprint_material(), other.fingerprint_material());
}

#[test]
fn a_credential_that_sees_no_organization_still_fingerprints_distinctly() {
    let a = build_discovery("[]", PROJECTS_JSON).expect("build");
    let b = build_discovery(
        "[]",
        r#"[{ "id": "ffffffffffffffffffff", "organization_id": "", "name": "Other" }]"#,
    )
    .expect("build");
    assert!(!a.fingerprint_material().is_empty());
    assert_ne!(a.fingerprint_material(), b.fingerprint_material());
}

#[test]
fn error_messages_never_contain_the_token() {
    // Every variant's Display is user-facing, so none may echo a credential.
    let errors = [
        ConnectError::Unauthorized,
        ConnectError::Forbidden("/v1/projects".into()),
        ConnectError::RateLimited,
        ConnectError::HostNotAllowed("evil.test".into()),
        ConnectError::Malformed("projects: expected array".into()),
    ];
    for error in errors {
        let rendered = error.to_string();
        assert!(!rendered.contains("sbp_"), "{rendered}");
        assert!(!rendered.is_empty());
    }
}
