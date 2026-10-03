//! Reading and changing what the vault holds.

use devledger_core::model::{
    Account, BillingInterval, EntityKind, EntityRef, Environment, Identity, Organization, Project,
    Provider, Relation, SecretRecord, ServiceProject, Subscription, SubscriptionStatus,
};
use devledger_core::redact::Provenance;
use devledger_core::secret::SecretString;
use devledger_core::store::{
    AccountDetails, AttentionItem, AuditEntry, IdentityNode, ProjectSummary, ServiceProjectSummary,
    SubscriptionSummary, VaultEntry,
};
use tauri::State;
use uuid::Uuid;

use crate::{AppState, IpcResult};

// ---------------------------------------------------------------------- vault

/// Every project, with secret counts.
#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> IpcResult<Vec<ProjectSummary>> {
    state.with(|vault| vault.list_projects())
}

/// A project's secrets. Metadata and masked previews only.
#[tauri::command]
pub fn list_secrets(state: State<'_, AppState>, project_id: Uuid) -> IpcResult<Vec<VaultEntry>> {
    state.with(|vault| vault.list_secrets(project_id))
}

/// Create a DevLedger project by hand.
#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> IpcResult<Project> {
    state.with(|vault| vault.create_project(&name, description.as_deref()))
}

/// Rename a project or change its description.
#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    project_id: Uuid,
    name: String,
    description: Option<String>,
) -> IpcResult<()> {
    state.with(|vault| vault.update_project(project_id, &name, description.as_deref()))
}

/// Delete a project. Provider resources survive; only the link is lost.
#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, project_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_project(project_id))
}

/// The whole Identity -> Account -> Organization -> resource graph.
#[tauri::command]
pub fn identity_graph(state: State<'_, AppState>) -> IpcResult<Vec<IdentityNode>> {
    state.with(|vault| vault.identity_graph())
}

/// Everything DevLedger could not work out on its own.
#[tauri::command]
pub fn needs_attention(state: State<'_, AppState>) -> IpcResult<Vec<AttentionItem>> {
    state.with(|vault| vault.needs_attention())
}

/// Every subscription and trial, with the account behind it.
#[tauri::command]
pub fn list_subscriptions(state: State<'_, AppState>) -> IpcResult<Vec<SubscriptionSummary>> {
    state.with(|vault| vault.list_subscriptions())
}

/// Every provider resource, with its account, organization and links.
#[tauri::command]
pub fn list_service_projects(state: State<'_, AppState>) -> IpcResult<Vec<ServiceProjectSummary>> {
    state.with(|vault| vault.list_service_projects())
}

/// Provider resources linked to a project.
#[tauri::command]
pub fn service_projects_for_project(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> IpcResult<Vec<ServiceProject>> {
    state.with(|vault| vault.service_projects_for_project(project_id))
}

/// Move a resource into an organization, or clear the assignment.
#[tauri::command]
pub fn assign_organization(
    state: State<'_, AppState>,
    service_project_id: Uuid,
    organization_id: Option<Uuid>,
) -> IpcResult<()> {
    state.with(|vault| {
        vault.assign_service_project_organization(service_project_id, organization_id)
    })
}

/// Record that a project uses a provider resource.
#[tauri::command]
pub fn link_service_project(
    state: State<'_, AppState>,
    service_project_id: Uuid,
    project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.link_service_project(service_project_id, project_id))
}

/// Undo a link between a project and a provider resource.
#[tauri::command]
pub fn unlink_service_project(
    state: State<'_, AppState>,
    service_project_id: Uuid,
    project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.unlink_service_project(service_project_id, project_id))
}

/// Create an organization under an account.
#[tauri::command]
pub fn create_organization(
    state: State<'_, AppState>,
    account_id: Uuid,
    name: String,
) -> IpcResult<Organization> {
    state.with(|vault| vault.create_organization(account_id, &name))
}

/// Organizations under an account.
#[tauri::command]
pub fn organizations_for_account(
    state: State<'_, AppState>,
    account_id: Uuid,
) -> IpcResult<Vec<Organization>> {
    state.with(|vault| vault.organizations_for_account(account_id))
}

/// Every identity.
#[tauri::command]
pub fn list_identities(state: State<'_, AppState>) -> IpcResult<Vec<Identity>> {
    state.with(|vault| vault.list_identities())
}

/// Accounts belonging to an identity.
#[tauri::command]
pub fn accounts_for_identity(
    state: State<'_, AppState>,
    identity_id: Uuid,
) -> IpcResult<Vec<Account>> {
    state.with(|vault| vault.accounts_for_identity(identity_id))
}

#[tauri::command]
pub fn create_identity_manual(
    state: State<'_, AppState>,
    label: String,
    email: Option<String>,
) -> IpcResult<Identity> {
    state.with(|vault| vault.create_identity_manual(&label, email.as_deref()))
}

#[tauri::command]
pub fn create_account_manual(
    state: State<'_, AppState>,
    identity_id: Uuid,
    provider: Provider,
    label: String,
    details: Option<AccountDetails>,
) -> IpcResult<Account> {
    // `details` is optional so callers that only name the account keep working;
    // Tauri passes None for an argument the frontend leaves out.
    state.with(|vault| {
        vault.create_account_with_details(
            identity_id,
            provider,
            &label,
            &details.unwrap_or_default(),
        )
    })
}

/// Record a provider account by hand, resolving the identity from an email.
///
/// The manual counterpart to Connect: nothing touches the network and no
/// credential is stored. `provider` deserialises from its snake_case tag, so
/// GitHub arrives as `git_hub` and OpenAI as `open_ai`.
#[tauri::command]
pub fn create_account_for_email(
    state: State<'_, AppState>,
    email: Option<String>,
    provider: Provider,
    label: String,
    note: Option<String>,
) -> IpcResult<Account> {
    state.with(|vault| {
        vault.create_account_for_email(email.as_deref(), provider, &label, note.as_deref())
    })
}

/// Add a provider account under a known identity, reusing one that already exists.
#[tauri::command]
pub fn add_account(
    state: State<'_, AppState>,
    identity_id: Uuid,
    provider: Provider,
    label: String,
    note: Option<String>,
) -> IpcResult<Account> {
    state.with(|vault| vault.add_account(identity_id, provider, &label, note.as_deref()))
}

#[tauri::command]
pub fn create_service_project_manual(
    state: State<'_, AppState>,
    account_id: Uuid,
    organization_id: Option<Uuid>,
    provider: Provider,
    name: String,
    provider_ref: Option<String>,
    environment: Environment,
) -> IpcResult<ServiceProject> {
    state.with(|vault| {
        vault.create_service_project_manual(
            account_id,
            organization_id,
            provider,
            &name,
            provider_ref.as_deref(),
            environment,
        )
    })
}

#[tauri::command]
pub fn create_manual_secret(
    state: State<'_, AppState>,
    project_id: Option<Uuid>,
    service_project_id: Option<Uuid>,
    name: String,
    environment: Environment,
    value: String,
) -> IpcResult<SecretRecord> {
    state.with(|vault| {
        vault.create_manual_secret(
            project_id,
            service_project_id,
            &name,
            environment,
            &SecretString::new(value),
        )
    })
}

/// Record a subscription by hand, without a paste.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn create_subscription_manual(
    state: State<'_, AppState>,
    email: Option<String>,
    provider: Provider,
    plan: String,
    status: SubscriptionStatus,
    amount_cents: Option<i64>,
    currency: Option<String>,
    interval: Option<BillingInterval>,
    renews_at: Option<String>,
) -> IpcResult<Subscription> {
    state.with(|vault| {
        vault.create_subscription_manual(
            email.as_deref(),
            provider,
            &plan,
            status,
            amount_cents,
            currency.as_deref(),
            interval,
            renews_at.as_deref(),
        )
    })
}

/// Move an account under a different identity.
#[tauri::command]
pub fn move_account(
    state: State<'_, AppState>,
    account_id: Uuid,
    identity_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.move_account(account_id, identity_id))
}

/// Move an organization under a different account.
#[tauri::command]
pub fn move_organization(
    state: State<'_, AppState>,
    organization_id: Uuid,
    account_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.move_organization(organization_id, account_id))
}

/// Move a resource under a different account, clearing its organization.
#[tauri::command]
pub fn move_service_project(
    state: State<'_, AppState>,
    service_project_id: Uuid,
    account_id: Uuid,
    organization_id: Option<Uuid>,
) -> IpcResult<()> {
    state.with(|vault| vault.move_service_project(service_project_id, account_id, organization_id))
}

/// Delete an account and everything under it.
#[tauri::command]
pub fn delete_account(state: State<'_, AppState>, account_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_account(account_id))
}

/// Record that a person works on a project.
#[tauri::command]
pub fn link_identity_project(
    state: State<'_, AppState>,
    identity_id: Uuid,
    project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.link_identity_project(identity_id, project_id))
}

/// Undo `link_identity_project`.
#[tauri::command]
pub fn unlink_identity_project(
    state: State<'_, AppState>,
    identity_id: Uuid,
    project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.unlink_identity_project(identity_id, project_id))
}

/// Every person–project pair, as `[identityId, projectId]`.
#[tauri::command]
pub fn identity_project_links(state: State<'_, AppState>) -> IpcResult<Vec<(Uuid, Uuid)>> {
    state.with(|vault| vault.identity_project_links())
}

/// Rename an organization.
#[tauri::command]
pub fn rename_organization(
    state: State<'_, AppState>,
    organization_id: Uuid,
    name: String,
) -> IpcResult<()> {
    state.with(|vault| vault.rename_organization(organization_id, &name))
}

/// Delete an organization. Its resources survive, unassigned.
#[tauri::command]
pub fn delete_organization(state: State<'_, AppState>, organization_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_organization(organization_id))
}

/// Delete a provider resource and its secrets.
#[tauri::command]
pub fn delete_service_project(
    state: State<'_, AppState>,
    service_project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.delete_service_project(service_project_id))
}

/// Delete a subscription.
#[tauri::command]
pub fn delete_subscription(state: State<'_, AppState>, subscription_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_subscription(subscription_id))
}

/// Every relation touching an entity, in either direction.
#[tauri::command]
pub fn relations_for(
    state: State<'_, AppState>,
    kind: EntityKind,
    id: Uuid,
) -> IpcResult<Vec<Relation>> {
    state.with(|vault| vault.relations_for(EntityRef::new(kind, id)))
}

/// Delete a secret and its ciphertext.
#[tauri::command]
pub fn delete_secret(state: State<'_, AppState>, secret_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_secret(secret_id))
}

/// Provenance attached to a secret.
#[tauri::command]
pub fn secret_provenance(
    state: State<'_, AppState>,
    secret_id: Uuid,
) -> IpcResult<Vec<Provenance>> {
    state.with(|vault| vault.provenance_for(EntityRef::new(EntityKind::Secret, secret_id)))
}

/// Recent audit-log lines.
#[tauri::command]
pub fn recent_audit(state: State<'_, AppState>, limit: i64) -> IpcResult<Vec<AuditEntry>> {
    state.with(|vault| vault.recent_audit(limit.clamp(1, 500)))
}
