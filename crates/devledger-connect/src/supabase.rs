//! The Supabase connector: read-only Management API discovery.
//!
//! Authentication is a Personal Access Token the user creates in their own
//! Supabase dashboard. DevLedger is never in the authentication path and never
//! sees a password. See `docs/decisions/0001-supabase-connector-auth.md` for
//! why this rather than the Management API's OAuth2 flow.
//!
//! Two endpoints are used, both documented and both `GET`:
//!
//! - `GET /v1/organizations` -- organizations the token can see
//! - `GET /v1/projects` -- projects the token can see
//!
//! A scoped token may legitimately see one and not the other; that is handled
//! rather than treated as failure.

use devledger_core::connect::{DiscoveredOrganization, DiscoveredProject, Discovery};
use devledger_core::model::Provider;
use serde::Deserialize;

use crate::{check_host, http_client, status_error, ConnectError};

/// The Management API base. Requests are built only from this constant.
pub const API_BASE: &str = "https://api.supabase.com";

/// The only host this connector may contact.
pub const ALLOWED_HOSTS: &[&str] = &["api.supabase.com"];

/// An organization as the Management API returns it.
///
/// Deserialized permissively: unknown fields are ignored so a provider-side
/// addition cannot break discovery.
#[derive(Debug, Clone, Deserialize)]
struct ApiOrganization {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

/// A project as the Management API returns it.
#[derive(Debug, Clone, Deserialize)]
struct ApiProject {
    id: String,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

/// Parse the `/v1/organizations` payload.
pub fn parse_organizations(body: &str) -> Result<Vec<DiscoveredOrganization>, ConnectError> {
    let raw: Vec<ApiOrganization> = serde_json::from_str(body)
        .map_err(|e| ConnectError::Malformed(format!("organizations: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|o| DiscoveredOrganization {
            name: o.name.unwrap_or_else(|| o.id.clone()),
            provider_org_id: o.id,
        })
        .collect())
}

/// Parse the `/v1/projects` payload.
///
/// A project whose `organization_id` is absent keeps an empty parent, and shows
/// up as an orphan in the review screen rather than being dropped.
pub fn parse_projects(body: &str) -> Result<Vec<DiscoveredProject>, ConnectError> {
    let raw: Vec<ApiProject> = serde_json::from_str(body)
        .map_err(|e| ConnectError::Malformed(format!("projects: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|p| DiscoveredProject {
            name: p.name.unwrap_or_else(|| p.id.clone()),
            provider_ref: p.id,
            provider_org_id: p.organization_id.unwrap_or_default(),
            region: p.region,
            status: p.status,
        })
        .collect())
}

/// Assemble a discovery from the two payloads.
///
/// Kept separate from the fetching so the tests can exercise it against real
/// response shapes without a mock server.
pub fn build_discovery(
    organizations_json: &str,
    projects_json: &str,
) -> Result<Discovery, ConnectError> {
    let mut organizations = parse_organizations(organizations_json)?;
    let mut projects = parse_projects(projects_json)?;

    // Sort so a discovery is stable regardless of the order the API replied in.
    organizations.sort_by(|a, b| a.provider_org_id.cmp(&b.provider_org_id));
    projects.sort_by(|a, b| a.provider_ref.cmp(&b.provider_ref));

    Ok(Discovery {
        provider: Provider::Supabase,
        organizations,
        projects,
        // The Management API exposes no "current user" endpoint, so DevLedger
        // does not know the account's email. It asks the user to label the
        // connection rather than inventing one.
        account_email: None,
    })
}

async fn get(client: &reqwest::Client, token: &str, path: &str) -> Result<String, ConnectError> {
    let url = format!("{API_BASE}{path}");
    check_host(&url, ALLOWED_HOSTS)?;

    let response = client
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ConnectError::Network(sanitize(e.to_string())))?;

    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status, path));
    }
    response
        .text()
        .await
        .map_err(|e| ConnectError::Network(sanitize(e.to_string())))
}

/// Strip anything token-shaped out of an error string before it is shown.
///
/// `reqwest` does not put headers in its messages, but a URL or a proxy error
/// could carry something, and an error message is the easiest place for a
/// credential to escape by accident.
fn sanitize(message: String) -> String {
    message
        .split_whitespace()
        .map(|word| {
            if word.contains("sbp_") || word.len() > 60 {
                "[redacted]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Read the account's organizations and projects.
///
/// Issues exactly two `GET` requests and writes nothing. A token that can read
/// projects but not organizations still produces a usable discovery.
pub async fn discover(token: &str) -> Result<Discovery, ConnectError> {
    let client = http_client()?;

    // Projects first: it is the endpoint a narrowly scoped token is most likely
    // to be allowed, so a permission problem surfaces against the useful call.
    let projects_json = get(&client, token, "/v1/projects").await?;

    let organizations_json = match get(&client, token, "/v1/organizations").await {
        Ok(body) => body,
        // A scoped token may not be allowed to list organizations. That is a
        // partial discovery, not a failure: the projects still map, and their
        // organizations show up as unassigned for the user to fill in.
        Err(ConnectError::Forbidden(_)) => "[]".to_string(),
        Err(other) => return Err(other),
    };

    build_discovery(&organizations_json, &projects_json)
}

/// Check a token works before storing it, without importing anything.
pub async fn verify(token: &str) -> Result<Discovery, ConnectError> {
    discover(token).await
}
