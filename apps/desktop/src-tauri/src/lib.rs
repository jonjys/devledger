//! The DevLedger desktop shell.
//!
//! This crate is deliberately thin: it owns a [`Vault`] behind a mutex and
//! exposes a fixed set of commands over Tauri's IPC. Every security decision
//! lives in `devledger-core`.
//!
//! Two rules govern what may cross the IPC boundary:
//!
//! 1. **No secret is returned unless the command name says so.** Only
//!    [`reveal_secret`] hands plaintext to JavaScript, and the user has to ask
//!    for it. [`copy_secret`] and [`copy_env`] exist so the common cases --
//!    pasting a key somewhere, seeding a `.env` -- never put the value in the
//!    frontend at all: Rust writes it straight to the OS clipboard.
//! 2. **Nothing reaches the network.** No HTTP client is linked, no shell or
//!    filesystem plugin is enabled, and the capability file grants only window
//!    controls plus clipboard writes.

use std::sync::Mutex;

use devledger_core::connect::reconcile::ReconcileReport;
use devledger_core::connect::{ConnectionSummary, ConnectorDescriptor, ConnectorId};
use devledger_core::connect_vault::{ConnectOutcome, ImportOutcome};
use devledger_core::manual::{NewAccount, NewResource, NewSecret, ResourceEdit};
use devledger_core::model::{
    Account, EntityKind, EntityRef, Environment, Identity, IdentityEmail, Organization, Project,
    Relation, SecretRecord, ServiceProject,
};
use devledger_core::paste::review::{CommitOutcome, ReviewSubmission};
use devledger_core::paste::PasteAnalysis;
use devledger_core::redact::{Provenance, SourceKind};
use devledger_core::secret::SecretString;
use devledger_core::store::{
    AccountDetails, AttentionItem, AuditEntry, IdentityNode, ProjectSummary, ServiceProjectSummary,
    SubscriptionSummary, VaultEntry,
};
use devledger_core::vault::{
    default_vault_dir, DeletionImpact, EnvConflict, OverviewIdentity, VaultStatus,
};
use devledger_core::{CoreError, Vault};
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use uuid::Uuid;

/// Error shape handed to the frontend.
///
/// [`CoreError`]'s `Display` is already written to be secret-free; this wrapper
/// adds a machine-readable code so the UI can react to a locked vault without
/// string matching.
#[derive(Debug, Serialize)]
pub struct IpcError {
    code: &'static str,
    message: String,
}

impl From<CoreError> for IpcError {
    fn from(error: CoreError) -> Self {
        let code = match &error {
            CoreError::VaultLocked => "vault_locked",
            CoreError::InvalidPassphrase => "invalid_passphrase",
            CoreError::AlreadyInitialized => "already_initialized",
            CoreError::NotInitialized => "not_initialized",
            CoreError::NotFound(_) => "not_found",
            CoreError::Invalid(_) => "invalid",
            CoreError::StaleAnalysis(_) => "stale_analysis",
            CoreError::Crypto(_) => "crypto",
            CoreError::Storage(_) => "storage",
            CoreError::Serde(_) => "serde",
            CoreError::Io(_) => "io",
        };
        IpcError {
            code,
            message: error.to_string(),
        }
    }
}

type IpcResult<T> = std::result::Result<T, IpcError>;

/// The vault, shared across commands.
pub struct AppState {
    vault: Mutex<Vault>,
}

impl AppState {
    fn with<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T, CoreError>) -> IpcResult<T> {
        let mut guard = self.vault.lock().map_err(|_| IpcError {
            code: "poisoned",
            message: "vault state was left inconsistent by an earlier failure".into(),
        })?;
        f(&mut guard).map_err(IpcError::from)
    }
}

// ----------------------------------------------------------------- lifecycle

/// Whether a vault exists and whether it is open.
#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> IpcResult<VaultStatus> {
    state.with(|vault| Ok(vault.status()))
}

/// Create the vault. Onboarding calls this once.
#[tauri::command]
fn vault_initialize(state: State<'_, AppState>, passphrase: String) -> IpcResult<VaultStatus> {
    state.with(|vault| {
        vault.initialize(&SecretString::new(passphrase))?;
        Ok(vault.status())
    })
}

/// Open an existing vault.
#[tauri::command]
fn vault_unlock(state: State<'_, AppState>, passphrase: String) -> IpcResult<VaultStatus> {
    state.with(|vault| {
        vault.unlock(&SecretString::new(passphrase))?;
        Ok(vault.status())
    })
}

/// Close the vault, dropping every key.
#[tauri::command]
fn vault_lock(state: State<'_, AppState>) -> IpcResult<VaultStatus> {
    state.with(|vault| {
        vault.lock();
        Ok(vault.status())
    })
}

// ---------------------------------------------------------------- smart paste

/// Analyse pasted text. Writes nothing; stages the result for review.
#[tauri::command]
fn smart_paste_analyze(state: State<'_, AppState>, text: String) -> IpcResult<PasteAnalysis> {
    state.with(|vault| vault.analyze_paste(&text, SourceKind::SmartPaste))
}

/// Drop a staged analysis the user closed without saving.
#[tauri::command]
fn smart_paste_discard(state: State<'_, AppState>, analysis_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.discard_analysis(analysis_id))
}

/// Apply the review sheet.
///
/// Only the submission crosses the boundary: the analysis it answers is the one
/// staged in Rust, so a tampered copy cannot relax a warning.
#[tauri::command]
fn smart_paste_commit(
    state: State<'_, AppState>,
    submission: ReviewSubmission,
) -> IpcResult<CommitOutcome> {
    state.with(|vault| vault.commit_review(&submission))
}

// ---------------------------------------------------------------------- vault

/// Every project, with secret counts.
#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> IpcResult<Vec<ProjectSummary>> {
    state.with(|vault| vault.list_projects())
}

/// A project's secrets. Metadata and masked previews only.
#[tauri::command]
fn list_secrets(state: State<'_, AppState>, project_id: Uuid) -> IpcResult<Vec<VaultEntry>> {
    state.with(|vault| vault.list_secrets(project_id))
}

/// Create a DevLedger project by hand.
#[tauri::command]
fn create_project(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> IpcResult<Project> {
    state.with(|vault| vault.create_project(&name, description.as_deref()))
}

/// Rename a project or change its description.
#[tauri::command]
fn update_project(
    state: State<'_, AppState>,
    project_id: Uuid,
    name: String,
    description: Option<String>,
) -> IpcResult<()> {
    state.with(|vault| vault.update_project(project_id, &name, description.as_deref()))
}

/// Delete a project. Provider resources survive; only the link is lost.
#[tauri::command]
fn delete_project(state: State<'_, AppState>, project_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_project(project_id))
}

/// The whole Identity -> Account -> Organization -> resource graph.
#[tauri::command]
fn identity_graph(state: State<'_, AppState>) -> IpcResult<Vec<IdentityNode>> {
    state.with(|vault| vault.identity_graph())
}

/// Everything DevLedger could not work out on its own.
#[tauri::command]
fn needs_attention(state: State<'_, AppState>) -> IpcResult<Vec<AttentionItem>> {
    state.with(|vault| vault.needs_attention())
}

/// Every subscription and trial, with the account behind it.
#[tauri::command]
fn list_subscriptions(state: State<'_, AppState>) -> IpcResult<Vec<SubscriptionSummary>> {
    state.with(|vault| vault.list_subscriptions())
}

/// Every provider resource, with its account, organization and links.
#[tauri::command]
fn list_service_projects(state: State<'_, AppState>) -> IpcResult<Vec<ServiceProjectSummary>> {
    state.with(|vault| vault.list_service_projects())
}

/// Provider resources linked to a project.
#[tauri::command]
fn service_projects_for_project(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> IpcResult<Vec<ServiceProject>> {
    state.with(|vault| vault.service_projects_for_project(project_id))
}

/// Move a resource into an organization, or clear the assignment.
#[tauri::command]
fn assign_organization(
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
fn link_service_project(
    state: State<'_, AppState>,
    service_project_id: Uuid,
    project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.link_service_project(service_project_id, project_id))
}

/// Undo a link between a project and a provider resource.
#[tauri::command]
fn unlink_service_project(
    state: State<'_, AppState>,
    service_project_id: Uuid,
    project_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.unlink_service_project(service_project_id, project_id))
}

/// Create an organization under an account.
#[tauri::command]
fn create_organization(
    state: State<'_, AppState>,
    account_id: Uuid,
    name: String,
) -> IpcResult<Organization> {
    state.with(|vault| vault.create_organization(account_id, &name))
}

/// Organizations under an account.
#[tauri::command]
fn organizations_for_account(
    state: State<'_, AppState>,
    account_id: Uuid,
) -> IpcResult<Vec<Organization>> {
    state.with(|vault| vault.organizations_for_account(account_id))
}

/// Every identity.
#[tauri::command]
fn list_identities(state: State<'_, AppState>) -> IpcResult<Vec<Identity>> {
    state.with(|vault| vault.list_identities())
}

/// Accounts belonging to an identity.
#[tauri::command]
fn accounts_for_identity(state: State<'_, AppState>, identity_id: Uuid) -> IpcResult<Vec<Account>> {
    state.with(|vault| vault.accounts_for_identity(identity_id))
}

/// Every relation touching an entity, in either direction.
#[tauri::command]
fn relations_for(
    state: State<'_, AppState>,
    kind: EntityKind,
    id: Uuid,
) -> IpcResult<Vec<Relation>> {
    state.with(|vault| vault.relations_for(EntityRef::new(kind, id)))
}

/// Delete a secret and its ciphertext.
#[tauri::command]
fn delete_secret(state: State<'_, AppState>, secret_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_secret(secret_id))
}

/// Provenance attached to a secret.
#[tauri::command]
fn secret_provenance(state: State<'_, AppState>, secret_id: Uuid) -> IpcResult<Vec<Provenance>> {
    state.with(|vault| vault.provenance_for(EntityRef::new(EntityKind::Secret, secret_id)))
}

/// Recent audit-log lines.
#[tauri::command]
fn recent_audit(state: State<'_, AppState>, limit: i64) -> IpcResult<Vec<AuditEntry>> {
    state.with(|vault| vault.recent_audit(limit.clamp(1, 500)))
}

// -------------------------------------------------------------------- secrets

/// **The only command that returns a secret value to JavaScript.**
///
/// The user must click Reveal to reach it, and every call is written to the
/// audit log before the value is returned.
#[tauri::command]
fn reveal_secret(state: State<'_, AppState>, secret_id: Uuid) -> IpcResult<String> {
    state.with(|vault| Ok(vault.reveal_secret(secret_id)?.expose().to_string()))
}

/// Copy a secret to the clipboard without it passing through the frontend.
#[tauri::command]
fn copy_secret(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    secret_id: Uuid,
) -> IpcResult<()> {
    let value = state.with(|vault| vault.reveal_secret(secret_id))?;
    app.clipboard()
        .write_text(value.expose().to_string())
        .map_err(|e| IpcError {
            code: "clipboard",
            message: format!("could not write to the clipboard: {e}"),
        })
}

/// Copy a whole project as a `.env` file, rendered in Rust.
///
/// Returns the number of variables copied so the UI can confirm, without ever
/// seeing a value.
#[tauri::command]
fn copy_env(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: Uuid,
    environment: Option<Environment>,
) -> IpcResult<usize> {
    let rendered = state.with(|vault| vault.export_env(project_id, environment))?;
    let count = rendered.expose().lines().filter(|l| !l.is_empty()).count();
    app.clipboard()
        .write_text(rendered.expose().to_string())
        .map_err(|e| IpcError {
            code: "clipboard",
            message: format!("could not write to the clipboard: {e}"),
        })?;
    Ok(count)
}

// ---------------------------------------------------------------- manual entry
//
// The commands that make DevLedger usable without a single token. None of them
// touch the network, and the one that carries a credential takes it as an
// argument and never gives it back.

/// Create an identity, optionally with its first email address.
#[tauri::command]
fn create_identity(
    state: State<'_, AppState>,
    label: String,
    email: Option<String>,
) -> IpcResult<Identity> {
    state.with(|vault| vault.create_identity(&label, email.as_deref()))
}

/// Rename an identity.
#[tauri::command]
fn update_identity(state: State<'_, AppState>, identity_id: Uuid, label: String) -> IpcResult<()> {
    state.with(|vault| vault.update_identity(identity_id, &label))
}

/// Delete an identity and everything filed under it.
#[tauri::command]
fn delete_identity(state: State<'_, AppState>, identity_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_identity(identity_id))
}

/// Every email address attached to an identity.
#[tauri::command]
fn identity_emails(state: State<'_, AppState>, identity_id: Uuid) -> IpcResult<Vec<IdentityEmail>> {
    state.with(|vault| vault.identity_emails(identity_id))
}

/// Attach another email address to an identity.
#[tauri::command]
fn add_identity_email(
    state: State<'_, AppState>,
    identity_id: Uuid,
    address: String,
    make_primary: bool,
) -> IpcResult<IdentityEmail> {
    state.with(|vault| vault.add_identity_email(identity_id, &address, make_primary))
}

/// Choose which address an identity is shown and matched by.
#[tauri::command]
fn set_primary_email(
    state: State<'_, AppState>,
    identity_id: Uuid,
    email_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.set_primary_email(identity_id, email_id))
}

/// Detach an email address from an identity.
#[tauri::command]
fn remove_identity_email(
    state: State<'_, AppState>,
    identity_id: Uuid,
    email_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.remove_identity_email(identity_id, email_id))
}

/// Create an account with any service the user can name.
#[tauri::command]
fn create_account(state: State<'_, AppState>, entry: NewAccount) -> IpcResult<Account> {
    state.with(|vault| vault.create_account(&entry))
}

/// Edit an account's label and login details.
#[tauri::command]
fn update_account(
    state: State<'_, AppState>,
    account_id: Uuid,
    label: String,
    details: AccountDetails,
) -> IpcResult<()> {
    state.with(|vault| vault.update_account(account_id, &label, &details))
}

/// Delete an account and everything filed under it.
#[tauri::command]
fn delete_account(state: State<'_, AppState>, account_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_account(account_id))
}

/// Every secret filed against an account, metadata only.
#[tauri::command]
fn account_secrets(state: State<'_, AppState>, account_id: Uuid) -> IpcResult<Vec<VaultEntry>> {
    state.with(|vault| vault.account_secrets(account_id))
}

/// Create a provider resource by hand.
#[tauri::command]
fn create_resource(state: State<'_, AppState>, entry: NewResource) -> IpcResult<ServiceProject> {
    state.with(|vault| vault.create_resource(&entry))
}

/// Edit a provider resource.
#[tauri::command]
fn update_resource(
    state: State<'_, AppState>,
    resource_id: Uuid,
    edit: ResourceEdit,
) -> IpcResult<()> {
    state.with(|vault| vault.update_resource(resource_id, &edit))
}

/// Delete a provider resource and the secrets filed against it.
#[tauri::command]
fn delete_resource(state: State<'_, AppState>, resource_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_resource(resource_id))
}

/// Store a secret entered by hand.
///
/// The value crosses the IPC boundary once, inbound. It is sealed in Rust and
/// never returned; the command answers with metadata only.
#[tauri::command]
fn store_secret(
    state: State<'_, AppState>,
    entry: NewSecret,
    value: String,
) -> IpcResult<SecretRecord> {
    state.with(|vault| vault.store_secret(&entry, &SecretString::new(value)))
}

/// Edit a secret's name, environment or note, leaving its value alone.
#[tauri::command]
fn update_secret_meta(
    state: State<'_, AppState>,
    secret_id: Uuid,
    name: String,
    environment: Environment,
    notes: Option<String>,
) -> IpcResult<()> {
    state.with(|vault| vault.update_secret_meta(secret_id, &name, environment, notes.as_deref()))
}

/// Replace a secret's value, keeping its identity and history.
#[tauri::command]
fn replace_secret_value(
    state: State<'_, AppState>,
    secret_id: Uuid,
    value: String,
) -> IpcResult<()> {
    state.with(|vault| vault.replace_secret_value(secret_id, &SecretString::new(value)))
}

/// Which environments a project's secrets use.
#[tauri::command]
fn project_environments(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> IpcResult<Vec<Environment>> {
    state.with(|vault| vault.project_environments(project_id))
}

/// Variable names a project defines more than once.
#[tauri::command]
fn env_conflicts(
    state: State<'_, AppState>,
    project_id: Uuid,
    environment: Option<Environment>,
) -> IpcResult<Vec<EnvConflict>> {
    state.with(|vault| vault.env_conflicts(project_id, environment))
}

/// What deleting a project would take with it.
#[tauri::command]
fn project_deletion_impact(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> IpcResult<DeletionImpact> {
    state.with(|vault| vault.project_deletion_impact(project_id))
}

/// The whole chain, from each email address down to the projects it reaches.
#[tauri::command]
fn ledger_overview(state: State<'_, AppState>) -> IpcResult<Vec<OverviewIdentity>> {
    state.with(|vault| vault.overview())
}

// ------------------------------------------------------------------ connectors
//
// These are the only commands that touch the network, and each one runs because
// the user pressed a button. The fetch happens in `devledger-connect`, outside
// the vault lock, so the mutex is never held across an await.

/// The connectors this build ships.
#[tauri::command]
fn list_connectors(state: State<'_, AppState>) -> IpcResult<Vec<ConnectorDescriptor>> {
    state.with(|vault| Ok(vault.connectors()))
}

/// Every connected provider account.
#[tauri::command]
fn list_connections(state: State<'_, AppState>) -> IpcResult<Vec<ConnectionSummary>> {
    state.with(|vault| vault.list_connections())
}

/// Connect a provider account.
///
/// The token is verified against the provider *before* it is stored, so a
/// mistyped or revoked credential never reaches the database. Nothing is
/// imported: the returned report is what the user reviews.
#[tauri::command]
async fn connector_connect(
    state: State<'_, AppState>,
    connector: String,
    token: String,
    label: String,
) -> IpcResult<ConnectOutcome> {
    let connector_id = ConnectorId(connector);

    // Fail fast on an obviously wrong token, before opening a socket.
    {
        let descriptor = state.with(|_| devledger_core::connect::connector(&connector_id))?;
        state.with(|_| devledger_core::connect::check_token_shape(&descriptor.auth, &token))?;
    }

    let discovery = devledger_connect::verify_with(&connector_id.0, &token)
        .await
        .map_err(|e| IpcError {
            code: "connector",
            message: e.to_string(),
        })?;

    state.with(|vault| {
        vault.connect_provider(
            &connector_id,
            &SecretString::new(token.clone()),
            &label,
            &discovery,
        )
    })
}

/// Re-read a connected account using its stored credential.
#[tauri::command]
async fn connector_refresh(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> IpcResult<ReconcileReport> {
    let (connector, token) = state.with(|vault| {
        let summary = vault
            .list_connections()?
            .into_iter()
            .find(|c| c.connection.id == connection_id)
            .ok_or_else(|| {
                devledger_core::CoreError::NotFound(format!("connection {connection_id}"))
            })?;
        Ok((
            summary.connection.connector_id.0.clone(),
            vault.connection_token(connection_id)?,
        ))
    })?;

    // Routed by the connection's own connector id. Reading the credential and
    // then handing it to a hard-coded client would send it wherever that client
    // happens to point.
    let discovery = devledger_connect::discover_with(&connector, token.expose())
        .await
        .map_err(|e| IpcError {
            code: "connector",
            message: e.to_string(),
        })?;

    state.with(|vault| vault.record_discovery(connection_id, &discovery))
}

/// The review screen for the most recent discovery, without re-fetching.
#[tauri::command]
fn connector_report(state: State<'_, AppState>, connection_id: Uuid) -> IpcResult<ReconcileReport> {
    state.with(|vault| vault.connection_report(connection_id))
}

/// Apply the rows the user ticked.
#[tauri::command]
fn connector_import(
    state: State<'_, AppState>,
    connection_id: Uuid,
    accepted: Vec<String>,
) -> IpcResult<ImportOutcome> {
    state.with(|vault| vault.import_discovery(connection_id, &accepted))
}

/// Forget a connection. Imported data is kept.
#[tauri::command]
fn connector_disconnect(state: State<'_, AppState>, connection_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.disconnect(connection_id))
}

/// Build and run the desktop application.
///
/// # Panics
///
/// Panics if the platform app-data directory cannot be resolved, which means
/// there is nowhere to put a vault.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("the platform must provide an app data directory");
            app.manage(AppState {
                vault: Mutex::new(Vault::new(default_vault_dir(&app_data))),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_initialize,
            vault_unlock,
            vault_lock,
            smart_paste_analyze,
            smart_paste_discard,
            smart_paste_commit,
            list_projects,
            list_secrets,
            create_project,
            update_project,
            delete_project,
            identity_graph,
            needs_attention,
            list_subscriptions,
            list_service_projects,
            service_projects_for_project,
            assign_organization,
            link_service_project,
            unlink_service_project,
            create_organization,
            organizations_for_account,
            list_identities,
            accounts_for_identity,
            relations_for,
            delete_secret,
            secret_provenance,
            recent_audit,
            reveal_secret,
            copy_secret,
            copy_env,
            list_connectors,
            list_connections,
            connector_connect,
            connector_refresh,
            connector_report,
            connector_import,
            connector_disconnect,
            create_identity,
            update_identity,
            delete_identity,
            identity_emails,
            add_identity_email,
            set_primary_email,
            remove_identity_email,
            create_account,
            update_account,
            delete_account,
            account_secrets,
            create_resource,
            update_resource,
            delete_resource,
            store_secret,
            update_secret_meta,
            replace_secret_value,
            project_environments,
            env_conflicts,
            project_deletion_impact,
            ledger_overview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevLedger");
}
