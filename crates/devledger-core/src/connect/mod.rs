//! Connect & Discover: the second way information reaches DevLedger.
//!
//! Smart Paste is for whatever happens to be on your clipboard. This module is
//! for the other case: you explicitly connect a provider account and DevLedger
//! reads its structure directly.
//!
//! The layering matters. This module defines *what a connector is* and what a
//! discovery looks like, but performs no I/O -- `devledger-core` has no HTTP
//! client and never opens a socket. Fetching lives in the separate
//! `devledger-connect` crate, which hands back a [`Discovery`] for this module
//! to reconcile and import.
//!
//! That split keeps the crate holding key material free of networking, which is
//! the invariant `scripts/security-check.sh` enforces.

pub mod discovery;
pub mod reconcile;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::Provider;

pub use discovery::{DiscoveredOrganization, DiscoveredProject, Discovery};
pub use reconcile::{MatchStatus, ReconcileItem, ReconcileReport, ReconcileScope};

/// Which connector a connection belongs to.
///
/// A newtype rather than an enum so a connector can be added without touching
/// the storage layer or the IPC surface.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConnectorId(pub String);

impl ConnectorId {
    /// The Supabase connector.
    pub fn supabase() -> Self {
        ConnectorId("supabase".to_string())
    }

    /// The underlying string, as stored.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ConnectorId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// How a connector authenticates.
///
/// Today every connector uses [`AuthKind::PersonalAccessToken`]. The enum
/// exists so that adding an OAuth flow later is a new variant rather than a
/// reshaping of the connection model: see
/// `docs/decisions/0001-supabase-connector-auth.md` for why Supabase is not
/// OAuth today.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "sort", rename_all = "snake_case")]
pub enum AuthKind {
    /// A long-lived token the user creates in the provider's own dashboard.
    PersonalAccessToken {
        /// Where the user goes to create one.
        create_url: String,
        /// Prefix a valid token starts with, used for a pre-flight check.
        expected_prefix: String,
        /// What to tell the user about scoping it.
        guidance: String,
    },
    /// Authorization-code flow with PKCE against a public client.
    ///
    /// Not used yet. Present so the shape of the model does not have to change
    /// when a provider supports it.
    OAuth2Pkce {
        /// Authorization endpoint.
        authorize_url: String,
        /// Token endpoint.
        token_url: String,
        /// Scopes to request.
        scopes: Vec<String>,
    },
}

/// Everything the UI needs to render a connector before anything is connected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectorDescriptor {
    /// Stable id.
    pub id: ConnectorId,
    /// Name to show, e.g. "Supabase".
    pub display_name: String,
    /// One line describing what connecting will read.
    pub summary: String,
    /// How to authenticate.
    pub auth: AuthKind,
    /// Which provider in the graph this connector populates.
    pub provider: Provider,
    /// Whether the connector can only read.
    pub read_only: bool,
    /// Hosts the connector is permitted to reach.
    pub allowed_hosts: Vec<String>,
}

/// The connectors this build ships.
///
/// Supabase is the only real one. The list is the single place the UI reads, so
/// adding a connector means adding an entry here and an implementation in
/// `devledger-connect`.
pub fn available_connectors() -> Vec<ConnectorDescriptor> {
    vec![ConnectorDescriptor {
        id: ConnectorId::supabase(),
        display_name: "Supabase".to_string(),
        summary: "Read your organizations and projects so DevLedger can map them.".to_string(),
        auth: AuthKind::PersonalAccessToken {
            create_url: "https://supabase.com/dashboard/account/tokens".to_string(),
            expected_prefix: "sbp_".to_string(),
            guidance: "Create a token with read-only permissions. DevLedger only ever \
                       issues GET requests, and you can revoke the token from the same \
                       page at any time."
                .to_string(),
        },
        provider: Provider::Supabase,
        read_only: true,
        allowed_hosts: vec!["api.supabase.com".to_string()],
    }]
}

/// Look up a connector by id.
pub fn connector(id: &ConnectorId) -> Result<ConnectorDescriptor> {
    available_connectors()
        .into_iter()
        .find(|c| &c.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("connector {id}")))
}

/// A connected provider account, as stored.
///
/// One row per *account*, not per provider: connecting a second Supabase
/// account adds a second connection and must never overwrite the first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Connection {
    /// Stable local id.
    pub id: Uuid,
    /// Which connector.
    pub connector_id: ConnectorId,
    /// The identity this account belongs to.
    pub identity_id: Uuid,
    /// The provider account in the graph.
    pub account_id: Uuid,
    /// What the user calls this connection, usually the account email.
    pub label: String,
    /// A stable provider-side fingerprint, used to recognise a reconnect.
    ///
    /// Supabase's Management API exposes no "current user" endpoint, so this is
    /// derived from the set of organization ids the token can see. It is a
    /// blind index, not the raw ids.
    pub account_fingerprint: String,
    /// When it was connected.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// When discovery last ran.
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_checked_at: Option<OffsetDateTime>,
}

/// A connection plus the counts the Connections screen shows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionSummary {
    /// The connection.
    pub connection: Connection,
    /// Email of the owning identity, when known.
    pub identity_email: Option<String>,
    /// How many organizations are recorded under this account.
    pub organization_count: i64,
    /// How many provider resources are recorded under this account.
    pub resource_count: i64,
}

/// Reject a credential that cannot possibly be valid before spending a request.
pub fn check_token_shape(auth: &AuthKind, token: &str) -> Result<()> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(CoreError::Invalid("the token is empty".into()));
    }
    if let AuthKind::PersonalAccessToken {
        expected_prefix, ..
    } = auth
    {
        if !trimmed.starts_with(expected_prefix) {
            return Err(CoreError::Invalid(format!(
                "a Supabase access token starts with {expected_prefix}"
            )));
        }
    }
    Ok(())
}
