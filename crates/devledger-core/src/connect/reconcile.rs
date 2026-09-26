//! Compare a [`Discovery`] against what is already in the graph.
//!
//! The output is a report, not a change. Every discovered organization and
//! project gets a [`MatchStatus`] explaining what importing it would do, and
//! the user confirms before anything is written.
//!
//! The statuses are deliberately blunt, because the point of this screen is to
//! let someone see at a glance whether a connector is about to do something
//! surprising.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{EntityKind, EntityRef, Organization, Provider, ServiceProject};

use super::discovery::Discovery;

/// What importing one discovered item would do.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum MatchStatus {
    /// Already in the graph, under this account, with the same identifiers.
    /// Importing changes nothing.
    Matched,
    /// Not in the graph. Importing creates it.
    Unmatched,
    /// Something with the same name exists but carries no provider id, so it
    /// may be the same thing recorded by hand or by Smart Paste. The user
    /// decides whether to adopt it.
    PossibleMatch,
    /// The provider id exists in the graph but under a different account.
    /// Importing is refused: silently moving a resource between accounts is
    /// exactly the merge this model exists to prevent.
    Conflict,
    /// In the graph under this account, but incomplete -- typically a resource
    /// with no organization. Importing fills the gap in.
    NeedsAttention,
}

impl MatchStatus {
    /// Short label for the review screen.
    pub fn label(&self) -> &'static str {
        match self {
            MatchStatus::Matched => "Matched",
            MatchStatus::Unmatched => "Unmatched",
            MatchStatus::PossibleMatch => "Possible match",
            MatchStatus::Conflict => "Conflict",
            MatchStatus::NeedsAttention => "Needs attention",
        }
    }

    /// Whether importing this item would write anything.
    pub fn writes(&self) -> bool {
        matches!(
            self,
            MatchStatus::Unmatched | MatchStatus::PossibleMatch | MatchStatus::NeedsAttention
        )
    }

    /// Whether this item is selected when the review screen opens.
    ///
    /// A conflict never is: resolving it needs a human. A possible match never
    /// is either, because adopting the wrong row is hard to undo.
    pub fn selected_by_default(&self) -> bool {
        matches!(self, MatchStatus::Unmatched | MatchStatus::NeedsAttention)
    }
}

/// Which kind of thing a report row is about.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileScope {
    /// An organization at the provider.
    Organization,
    /// A project or resource at the provider.
    Project,
}

/// One line of the review screen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReconcileItem {
    /// Organization or project.
    pub scope: ReconcileScope,
    /// Provider-side identifier: an org id or a project ref.
    pub provider_id: String,
    /// Name at the provider.
    pub name: String,
    /// The organization this belongs to, for project rows.
    pub parent_provider_org_id: Option<String>,
    /// What importing would do.
    pub status: MatchStatus,
    /// Plain-language explanation, shown verbatim.
    pub detail: String,
    /// The existing row this matched, when it matched one.
    pub existing: Option<EntityRef>,
    /// Whether the row starts ticked.
    pub selected_by_default: bool,
    /// Region the provider reports, for project rows.
    pub region: Option<String>,
    /// Lifecycle status the provider reports, for project rows.
    pub status_at_provider: Option<String>,
    /// Whether the provider reports this as running.
    ///
    /// A paused project is worth importing -- losing track of it is exactly the
    /// problem DevLedger solves -- but it should be visibly paused rather than
    /// sitting in the map looking live.
    pub active_at_provider: bool,
}

/// The whole review screen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Which connection this is for.
    pub connection_id: Uuid,
    /// Rows, organizations first, then their projects.
    pub items: Vec<ReconcileItem>,
    /// Count per status, for the summary line.
    pub matched: usize,
    /// Rows that would be created.
    pub unmatched: usize,
    /// Rows that might be an existing record.
    pub possible: usize,
    /// Rows that cannot be imported without a decision.
    pub conflicts: usize,
    /// Rows that would fill in a gap.
    pub needs_attention: usize,
    /// Rows the provider reports as not running.
    pub paused: usize,
}

impl ReconcileReport {
    /// Whether importing would write anything at all.
    pub fn has_changes(&self) -> bool {
        self.items.iter().any(|i| i.status.writes())
    }
}

/// What reconciliation needs to know about the current graph.
///
/// A trait so the logic is testable without a database, and so it is obvious
/// how little reconciliation reads.
pub trait GraphView {
    /// A resource with this provider ref, anywhere in the vault.
    fn service_project_by_ref(
        &self,
        provider: &Provider,
        provider_ref: &str,
    ) -> crate::Result<Option<ServiceProject>>;
    /// A resource with this name under this account.
    fn service_project_by_name_in_account(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> crate::Result<Option<ServiceProject>>;
    /// An organization with this provider id under this account.
    fn organization_by_provider_id(
        &self,
        account_id: Uuid,
        provider_org_id: &str,
    ) -> crate::Result<Option<Organization>>;
    /// An organization with this name under this account.
    fn organization_by_name_in_account(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> crate::Result<Option<Organization>>;
}

/// Build the review screen for one connection's discovery.
pub fn reconcile(
    connection_id: Uuid,
    account_id: Uuid,
    provider: &Provider,
    discovery: &Discovery,
    graph: &dyn GraphView,
) -> crate::Result<ReconcileReport> {
    let mut items: Vec<ReconcileItem> = Vec::new();

    for org in &discovery.organizations {
        items.push(reconcile_organization(account_id, org, graph)?);
        for project in discovery.projects_in(&org.provider_org_id) {
            items.push(reconcile_project(account_id, provider, project, graph)?);
        }
    }

    // A scoped token can expose a project whose organization it cannot read.
    for project in discovery.orphan_projects() {
        items.push(reconcile_project(account_id, provider, project, graph)?);
    }

    let mut report = ReconcileReport {
        connection_id,
        matched: 0,
        unmatched: 0,
        possible: 0,
        conflicts: 0,
        needs_attention: 0,
        paused: 0,
        items,
    };
    for item in &report.items {
        if !item.active_at_provider {
            report.paused += 1;
        }
        match item.status {
            MatchStatus::Matched => report.matched += 1,
            MatchStatus::Unmatched => report.unmatched += 1,
            MatchStatus::PossibleMatch => report.possible += 1,
            MatchStatus::Conflict => report.conflicts += 1,
            MatchStatus::NeedsAttention => report.needs_attention += 1,
        }
    }
    Ok(report)
}

fn reconcile_organization(
    account_id: Uuid,
    org: &super::DiscoveredOrganization,
    graph: &dyn GraphView,
) -> crate::Result<ReconcileItem> {
    let build = |status: MatchStatus, detail: String, existing: Option<EntityRef>| ReconcileItem {
        scope: ReconcileScope::Organization,
        provider_id: org.provider_org_id.clone(),
        name: org.name.clone(),
        parent_provider_org_id: None,
        selected_by_default: status.selected_by_default(),
        status,
        detail,
        existing,
        region: None,
        status_at_provider: None,
        active_at_provider: true,
    };

    // Same provider id under this account: already ours.
    if let Some(existing) = graph.organization_by_provider_id(account_id, &org.provider_org_id)? {
        let entity = EntityRef::new(EntityKind::Organization, existing.id);
        if existing.name == org.name {
            return Ok(build(
                MatchStatus::Matched,
                "Already recorded with the same name".to_string(),
                Some(entity),
            ));
        }
        return Ok(build(
            MatchStatus::NeedsAttention,
            format!(
                "Recorded as \"{}\" but the provider now calls it \"{}\". Importing renames it.",
                existing.name, org.name
            ),
            Some(entity),
        ));
    }

    // Same name, no provider id: probably the one Smart Paste created.
    if let Some(existing) = graph.organization_by_name_in_account(account_id, &org.name)? {
        let entity = EntityRef::new(EntityKind::Organization, existing.id);
        if existing.provider_org_id.is_none() {
            return Ok(build(
                MatchStatus::PossibleMatch,
                "An organization with this name exists but has no provider id. \
                 Importing links them."
                    .to_string(),
                Some(entity),
            ));
        }
        return Ok(build(
            MatchStatus::Conflict,
            format!(
                "\"{}\" already exists under this account with a different provider id ({}).",
                org.name,
                existing.provider_org_id.unwrap_or_default()
            ),
            Some(entity),
        ));
    }

    Ok(build(
        MatchStatus::Unmatched,
        "New. Importing adds it to your map.".to_string(),
        None,
    ))
}

fn reconcile_project(
    account_id: Uuid,
    provider: &Provider,
    project: &super::DiscoveredProject,
    graph: &dyn GraphView,
) -> crate::Result<ReconcileItem> {
    let active = project.is_active();
    let build = |status: MatchStatus, detail: String, existing: Option<EntityRef>| {
        // A paused project gets the fact appended rather than a separate
        // status, so it can still be imported while being obviously paused.
        let detail = if active {
            detail
        } else {
            format!(
                "{detail} The provider reports it as {}.",
                project.status.as_deref().unwrap_or("not running")
            )
        };
        ReconcileItem {
            scope: ReconcileScope::Project,
            provider_id: project.provider_ref.clone(),
            name: project.name.clone(),
            parent_provider_org_id: Some(project.provider_org_id.clone()),
            selected_by_default: status.selected_by_default(),
            status,
            detail,
            existing,
            region: project.region.clone(),
            status_at_provider: project.status.clone(),
            active_at_provider: active,
        }
    };

    if let Some(existing) = graph.service_project_by_ref(provider, &project.provider_ref)? {
        let entity = EntityRef::new(EntityKind::ServiceProject, existing.id);

        // The provider ref is globally unique, so finding it under a different
        // account means the graph and the provider disagree about who owns it.
        // Importing would silently move it, which is the merge this model
        // exists to prevent, so it is refused and shown to the user.
        if existing.account_id != account_id {
            return Ok(build(
                MatchStatus::Conflict,
                format!(
                    "{} is already recorded under a different connected account. \
                     DevLedger will not move it for you.",
                    project.provider_ref
                ),
                Some(entity),
            ));
        }

        if existing.organization_id.is_none() {
            return Ok(build(
                MatchStatus::NeedsAttention,
                "Recorded without an organization. Importing files it under the right one."
                    .to_string(),
                Some(entity),
            ));
        }

        if existing.name != project.name {
            return Ok(build(
                MatchStatus::NeedsAttention,
                format!(
                    "Recorded as \"{}\" but the provider now calls it \"{}\". Importing renames it.",
                    existing.name, project.name
                ),
                Some(entity),
            ));
        }

        return Ok(build(
            MatchStatus::Matched,
            "Already recorded, up to date".to_string(),
            Some(entity),
        ));
    }

    if let Some(existing) = graph.service_project_by_name_in_account(account_id, &project.name)? {
        if existing.provider_ref.is_none() {
            return Ok(build(
                MatchStatus::PossibleMatch,
                format!(
                    "A resource named \"{}\" exists with no provider reference. \
                     Importing attaches {} to it.",
                    project.name, project.provider_ref
                ),
                Some(EntityRef::new(EntityKind::ServiceProject, existing.id)),
            ));
        }
    }

    Ok(build(
        MatchStatus::Unmatched,
        "New. Importing adds it to your map.".to_string(),
        None,
    ))
}
