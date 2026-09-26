//! DevLedger connectors.
//!
//! This is the only crate in the workspace that opens a socket. Keeping it
//! separate from `devledger-core` means the crate that holds key material has
//! no HTTP client at all, which `scripts/security-check.sh` verifies.
//!
//! Everything here is read-only and explicit:
//!
//! - Only `GET` requests are issued. There is no code path that writes to a
//!   provider.
//! - Every request is checked against a per-connector host allowlist before a
//!   connection is opened, so a malformed or tampered base URL cannot redirect
//!   a credential somewhere else.
//! - Redirects are refused, for the same reason.
//! - A request only happens because the user pressed Connect, Refresh or
//!   Discover. Nothing polls, and nothing is sent anywhere on startup.
//!
//! The network-facing surface is deliberately thin: a fetch, then pure parsing
//! functions that the tests exercise directly without a mock server.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod supabase;

use std::time::Duration;

use devledger_core::connect::Discovery;

use thiserror::Error;

/// How long a single provider request may take.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// The User-Agent DevLedger identifies itself with.
pub const USER_AGENT: &str = concat!("DevLedger/", env!("CARGO_PKG_VERSION"), " (+local-first)");

/// What can go wrong talking to a provider.
///
/// Messages are written to be shown to a user, and never contain the
/// credential.
#[derive(Debug, Error)]
pub enum ConnectError {
    /// The credential was rejected.
    #[error("the provider rejected this token. It may have been revoked, or it may lack the permissions DevLedger needs.")]
    Unauthorized,

    /// The credential is valid but lacks permission for something.
    #[error("this token does not have permission to read {0}. Create one with read access and try again.")]
    Forbidden(String),

    /// The provider asked us to slow down.
    #[error("the provider is rate limiting this token. Wait a minute and try again.")]
    RateLimited,

    /// The provider returned something unexpected.
    #[error("the provider returned an unexpected response: {0}")]
    Unexpected(String),

    /// The response did not parse.
    #[error("could not read the provider's response: {0}")]
    Malformed(String),

    /// The request never reached the provider.
    #[error("could not reach the provider: {0}")]
    Network(String),

    /// A URL outside the connector's allowlist was constructed.
    #[error("refused to contact {0}: it is not an allowed host for this connector")]
    HostNotAllowed(String),

    /// A connector id with no implementation behind it.
    ///
    /// Refusing beats falling back to a default: a credential meant for one
    /// provider must never be sent to another.
    #[error("no connector named {0} is built into this version of DevLedger")]
    UnknownConnector(String),
}

impl From<ConnectError> for devledger_core::CoreError {
    fn from(error: ConnectError) -> Self {
        devledger_core::CoreError::Invalid(error.to_string())
    }
}

/// Route a request to the connector the caller asked for.
///
/// The dispatch lives here, next to the implementations, rather than at the IPC
/// boundary. When it lived there, both commands called the Supabase client
/// directly and ignored the connector id they were given -- harmless while
/// Supabase was the only connector, and a credential sent to the wrong provider
/// the moment a second one shipped. An unknown id is refused rather than
/// defaulted, so the failure mode of adding a connector and forgetting to wire
/// it up is an error message, not a leak.
pub async fn discover_with(connector: &str, token: &str) -> Result<Discovery, ConnectError> {
    match connector {
        "supabase" => supabase::discover(token).await,
        other => Err(ConnectError::UnknownConnector(other.to_string())),
    }
}

/// Check a credential against its provider before storing it.
pub async fn verify_with(connector: &str, token: &str) -> Result<Discovery, ConnectError> {
    match connector {
        "supabase" => supabase::verify(token).await,
        other => Err(ConnectError::UnknownConnector(other.to_string())),
    }
}

/// Refuse any URL whose host is not on the connector's allowlist.
///
/// Called before every request. The allowlist is a property of the connector,
/// not of the call site, so a new endpoint cannot quietly widen it.
pub fn check_host(url: &str, allowed: &[&str]) -> Result<(), ConnectError> {
    check_host_inner(url, allowed, true)
}

/// Whether a host is the loopback interface.
///
/// Used for the one case where plaintext is acceptable: a test harness talking
/// to a server on this machine, where there is no network to protect.
pub fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// The allowlist check, with the https requirement made explicit.
pub(crate) fn check_host_inner(
    url: &str,
    allowed: &[&str],
    require_https: bool,
) -> Result<(), ConnectError> {
    let parsed =
        url::Url::parse(url).map_err(|e| ConnectError::HostNotAllowed(format!("{url} ({e})")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ConnectError::HostNotAllowed(url.to_string()))?;

    // Plaintext is refused everywhere except loopback, and even there only when
    // the caller has already established it is talking to a local test server.
    if parsed.scheme() != "https" && (require_https || !is_loopback(host)) {
        return Err(ConnectError::HostNotAllowed(format!(
            "{url} (only https is allowed)"
        )));
    }
    if allowed.contains(&host) {
        Ok(())
    } else {
        Err(ConnectError::HostNotAllowed(host.to_string()))
    }
}

/// Build the shared HTTP client.
///
/// Redirects are disabled on purpose: following one could send the
/// `Authorization` header to a host that is not on the allowlist.
pub(crate) fn http_client() -> Result<reqwest::Client, ConnectError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ConnectError::Network(e.to_string()))
}

/// Turn an HTTP status into a typed error.
pub(crate) fn status_error(status: reqwest::StatusCode, what: &str) -> ConnectError {
    match status.as_u16() {
        401 => ConnectError::Unauthorized,
        403 => ConnectError::Forbidden(what.to_string()),
        429 => ConnectError::RateLimited,
        other => ConnectError::Unexpected(format!("HTTP {other} while reading {what}")),
    }
}
