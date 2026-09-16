//! What a connector found at the provider.
//!
//! This is a plain data snapshot, not a graph change. It is produced by
//! `devledger-connect`, reconciled by [`super::reconcile`], and only becomes
//! rows when the user confirms an import.

use serde::{Deserialize, Serialize};

use crate::model::Provider;

/// One organization or team at the provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredOrganization {
    /// Provider-side id or slug. Stable across renames.
    pub provider_org_id: String,
    /// Display name at the provider.
    pub name: String,
}

/// One project or resource at the provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredProject {
    /// Provider-side reference, e.g. a Supabase project ref.
    pub provider_ref: String,
    /// The organization it sits in.
    pub provider_org_id: String,
    /// Display name at the provider.
    pub name: String,
    /// Region, when the provider reports one.
    pub region: Option<String>,
    /// Lifecycle status at the provider, e.g. `ACTIVE_HEALTHY`.
    pub status: Option<String>,
}

/// The full snapshot from one connected account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Discovery {
    /// Which provider this came from.
    pub provider: Provider,
    /// Organizations visible to the credential.
    pub organizations: Vec<DiscoveredOrganization>,
    /// Projects visible to the credential.
    pub projects: Vec<DiscoveredProject>,
    /// Account email, when the provider exposes one.
    ///
    /// Supabase's Management API does not, so this is `None` there and the user
    /// is asked to label the connection instead of DevLedger guessing.
    pub account_email: Option<String>,
}

impl Discovery {
    /// Projects belonging to one organization, in provider order.
    pub fn projects_in(&self, provider_org_id: &str) -> Vec<&DiscoveredProject> {
        self.projects
            .iter()
            .filter(|p| p.provider_org_id == provider_org_id)
            .collect()
    }

    /// Projects whose organization is not in the organization list.
    ///
    /// A scoped token can see a project without seeing its organization, so
    /// this is a normal case rather than an error.
    pub fn orphan_projects(&self) -> Vec<&DiscoveredProject> {
        self.projects
            .iter()
            .filter(|p| {
                !self
                    .organizations
                    .iter()
                    .any(|o| o.provider_org_id == p.provider_org_id)
            })
            .collect()
    }

    /// A stable, order-independent fingerprint of what this credential can see.
    ///
    /// Used to recognise that a token belongs to an account already connected,
    /// so reconnecting refreshes that connection instead of creating a second
    /// one for the same account. The caller blind-indexes the result, so the
    /// provider ids are never stored in the clear.
    pub fn fingerprint_material(&self) -> String {
        let mut ids: Vec<&str> = self
            .organizations
            .iter()
            .map(|o| o.provider_org_id.as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.is_empty() {
            // A credential that sees no organization still has to be
            // distinguishable, so fall back to the project refs.
            let mut refs: Vec<&str> = self
                .projects
                .iter()
                .map(|p| p.provider_ref.as_str())
                .collect();
            refs.sort_unstable();
            refs.dedup();
            return refs.join("|");
        }
        ids.join("|")
    }
}
