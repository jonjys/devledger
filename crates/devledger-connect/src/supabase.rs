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

use crate::{http_client, status_error, ConnectError};

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
    slug: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// A project as the Management API returns it.
///
/// `id` and `ref` are both present and currently identical. `ref` is the
/// canonical project reference -- the thing that appears in
/// `<ref>.supabase.co` -- so it wins when both are present.
#[derive(Debug, Clone, Deserialize)]
struct ApiProject {
    id: String,
    #[serde(default)]
    r#ref: Option<String>,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    database: Option<ApiDatabase>,
}

/// The nested database block on a project.
#[derive(Debug, Clone, Deserialize)]
struct ApiDatabase {
    #[serde(default)]
    host: Option<String>,
}

/// Accept either a bare JSON array or an object wrapping one.
///
/// The Management API returns a bare array today. Some Supabase surfaces wrap
/// the same payload as `{"projects": [...]}`, and an API that grows pagination
/// would likely do the same, so both are accepted rather than one being
/// assumed. An unexpected shape is still an error, not a silent empty list.
fn extract_array<'a>(
    value: &'a serde_json::Value,
    key: &str,
) -> Result<&'a Vec<serde_json::Value>, ConnectError> {
    if let Some(array) = value.as_array() {
        return Ok(array);
    }
    if let Some(array) = value.get(key).and_then(|v| v.as_array()) {
        return Ok(array);
    }
    Err(ConnectError::Malformed(format!(
        "{key}: expected an array, or an object containing one under \"{key}\""
    )))
}

/// Parse the `/v1/organizations` payload.
pub fn parse_organizations(body: &str) -> Result<Vec<DiscoveredOrganization>, ConnectError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| ConnectError::Malformed(format!("organizations: {e}")))?;
    let array = extract_array(&value, "organizations")?;

    let mut out = Vec::with_capacity(array.len());
    for entry in array {
        let org: ApiOrganization = serde_json::from_value(entry.clone())
            .map_err(|e| ConnectError::Malformed(format!("organizations: {e}")))?;
        out.push(DiscoveredOrganization {
            name: org.name.unwrap_or_else(|| org.id.clone()),
            slug: org.slug,
            provider_org_id: org.id,
        });
    }
    Ok(out)
}

/// Parse the `/v1/projects` payload.
///
/// A project whose `organization_id` is absent keeps an empty parent, and shows
/// up as an orphan in the review screen rather than being dropped.
pub fn parse_projects(body: &str) -> Result<Vec<DiscoveredProject>, ConnectError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| ConnectError::Malformed(format!("projects: {e}")))?;
    let array = extract_array(&value, "projects")?;

    let mut out = Vec::with_capacity(array.len());
    for entry in array {
        let project: ApiProject = serde_json::from_value(entry.clone())
            .map_err(|e| ConnectError::Malformed(format!("projects: {e}")))?;
        // `ref` is the canonical reference; `id` is the fallback.
        let provider_ref = project.r#ref.unwrap_or_else(|| project.id.clone());
        out.push(DiscoveredProject {
            name: project.name.unwrap_or_else(|| project.id.clone()),
            provider_ref,
            provider_org_id: project.organization_id.unwrap_or_default(),
            region: project.region,
            status: project.status,
            database_host: project.database.and_then(|d| d.host),
        });
    }
    Ok(out)
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

/// A configured Supabase Management API client.
///
/// Carries its own base URL and host allowlist so that the allowlist is checked
/// against the base actually in use, rather than against a constant that a test
/// build might diverge from.
pub struct SupabaseClient {
    base: String,
    allowed: Vec<String>,
    require_https: bool,
    http: reqwest::Client,
}

/// Holds no credential: a token is supplied per call, so the client itself is
/// safe to print.
impl std::fmt::Debug for SupabaseClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SupabaseClient")
            .field("base", &self.base)
            .field("allowed", &self.allowed)
            .field("require_https", &self.require_https)
            .finish_non_exhaustive()
    }
}

impl SupabaseClient {
    /// The real Management API.
    pub fn production() -> Result<Self, ConnectError> {
        Ok(SupabaseClient {
            base: API_BASE.to_string(),
            allowed: ALLOWED_HOSTS.iter().map(|h| (*h).to_string()).collect(),
            require_https: true,
            http: http_client()?,
        })
    }

    /// A client pointed at a local test server.
    ///
    /// Refuses any base that is not loopback, so this cannot be used to reach a
    /// real host with the allowlist relaxed. It exists so the integration tests
    /// exercise the same `discover` code path the product uses, rather than a
    /// parallel one that could drift.
    #[doc(hidden)]
    pub fn for_loopback_testing(base: &str) -> Result<Self, ConnectError> {
        let parsed = url::Url::parse(base)
            .map_err(|e| ConnectError::HostNotAllowed(format!("{base} ({e})")))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| ConnectError::HostNotAllowed(base.to_string()))?;
        if !crate::is_loopback(host) {
            return Err(ConnectError::HostNotAllowed(format!(
                "{host} is not loopback"
            )));
        }
        Ok(SupabaseClient {
            base: base.trim_end_matches('/').to_string(),
            allowed: vec![host.to_string()],
            require_https: false,
            http: http_client()?,
        })
    }

    async fn get(&self, token: &str, path: &str) -> Result<String, ConnectError> {
        let url = format!("{}{path}", self.base);
        let allowed: Vec<&str> = self.allowed.iter().map(String::as_str).collect();
        crate::check_host_inner(&url, &allowed, self.require_https)?;

        let response = self
            .http
            .get(&url)
            .bearer_auth(token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| ConnectError::Network(sanitize(e.to_string())))?;

        let status = response.status();

        // Redirects are disabled on the client, so a 3xx arrives here rather
        // than being followed. Treating it as an error keeps the bearer token
        // from ever being re-sent to whatever Location pointed at.
        if status.is_redirection() {
            return Err(ConnectError::Unexpected(format!(
                "the provider redirected {path}, which DevLedger does not follow"
            )));
        }
        if !status.is_success() {
            return Err(status_error(status, path));
        }
        response
            .text()
            .await
            .map_err(|e| ConnectError::Network(sanitize(e.to_string())))
    }

    /// Read the account's organizations and projects.
    ///
    /// Issues exactly two `GET` requests and writes nothing. A token that can
    /// read projects but not organizations still produces a usable discovery.
    pub async fn discover(&self, token: &str) -> Result<Discovery, ConnectError> {
        // Projects first: it is the endpoint a narrowly scoped token is most
        // likely to be allowed, so a permission problem surfaces against the
        // useful call.
        let projects_json = self.get(token, "/v1/projects").await?;

        let organizations_json = match self.get(token, "/v1/organizations").await {
            Ok(body) => body,
            // A scoped token may not be allowed to list organizations. That is
            // a partial discovery, not a failure: the projects still map, and
            // their organizations show up as unassigned for the user to fill in.
            Err(ConnectError::Forbidden(_)) => "[]".to_string(),
            Err(other) => return Err(other),
        };

        build_discovery(&organizations_json, &projects_json)
    }
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

/// Read the account's organizations and projects from the real API.
pub async fn discover(token: &str) -> Result<Discovery, ConnectError> {
    SupabaseClient::production()?.discover(token).await
}

/// Check a token works before storing it, without importing anything.
pub async fn verify(token: &str) -> Result<Discovery, ConnectError> {
    discover(token).await
}
