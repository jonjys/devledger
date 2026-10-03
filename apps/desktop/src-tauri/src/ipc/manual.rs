//! Building and editing the ledger by hand.

use devledger_core::manual::{NewSecret, ResourceEdit};
use devledger_core::model::{CustomField, EntityRef, Environment, IdentityEmail, SecretRecord};
use devledger_core::secret::SecretString;
use devledger_core::store::{AccountDetails, SecretListing, VaultEntry};
use devledger_core::vault::{DeletionImpact, EnvConflict, OverviewIdentity};
use tauri::State;
use uuid::Uuid;

use crate::{AppState, IpcResult};

// ---------------------------------------------------------------- manual entry
//
// The commands that make DevLedger usable without a single token. None of them
// touch the network, and the one that carries a credential takes it as an
// argument and never gives it back.

/// Rename an identity.
#[tauri::command]
pub fn update_identity(
    state: State<'_, AppState>,
    identity_id: Uuid,
    label: String,
) -> IpcResult<()> {
    state.with(|vault| vault.update_identity(identity_id, &label))
}

/// Delete an identity and everything filed under it.
#[tauri::command]
pub fn delete_identity(state: State<'_, AppState>, identity_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_identity(identity_id))
}

/// Every email address attached to an identity.
#[tauri::command]
pub fn identity_emails(
    state: State<'_, AppState>,
    identity_id: Uuid,
) -> IpcResult<Vec<IdentityEmail>> {
    state.with(|vault| vault.identity_emails(identity_id))
}

/// Attach another email address to an identity.
#[tauri::command]
pub fn add_identity_email(
    state: State<'_, AppState>,
    identity_id: Uuid,
    address: String,
    make_primary: bool,
) -> IpcResult<IdentityEmail> {
    state.with(|vault| vault.add_identity_email(identity_id, &address, make_primary))
}

/// Choose which address an identity is shown and matched by.
#[tauri::command]
pub fn set_primary_email(
    state: State<'_, AppState>,
    identity_id: Uuid,
    email_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.set_primary_email(identity_id, email_id))
}

/// Detach an email address from an identity.
#[tauri::command]
pub fn remove_identity_email(
    state: State<'_, AppState>,
    identity_id: Uuid,
    email_id: Uuid,
) -> IpcResult<()> {
    state.with(|vault| vault.remove_identity_email(identity_id, email_id))
}

/// Edit an account's label and login details.
#[tauri::command]
pub fn update_account(
    state: State<'_, AppState>,
    account_id: Uuid,
    label: String,
    details: AccountDetails,
) -> IpcResult<()> {
    state.with(|vault| vault.update_account(account_id, &label, &details))
}

/// Every secret filed against an account, metadata only.
#[tauri::command]
pub fn account_secrets(state: State<'_, AppState>, account_id: Uuid) -> IpcResult<Vec<VaultEntry>> {
    state.with(|vault| vault.account_secrets(account_id))
}

/// Edit a provider resource.
#[tauri::command]
pub fn update_resource(
    state: State<'_, AppState>,
    resource_id: Uuid,
    edit: ResourceEdit,
) -> IpcResult<()> {
    state.with(|vault| vault.update_resource(resource_id, &edit))
}

/// Store a secret entered by hand.
///
/// The value crosses the IPC boundary once, inbound. It is sealed in Rust and
/// never returned; the command answers with metadata only.
#[tauri::command]
pub fn store_secret(
    state: State<'_, AppState>,
    entry: NewSecret,
    value: String,
) -> IpcResult<SecretRecord> {
    state.with(|vault| vault.store_secret(&entry, &SecretString::new(value)))
}

/// Edit a secret's name, environment or note, leaving its value alone.
#[tauri::command]
pub fn update_secret_meta(
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
pub fn replace_secret_value(
    state: State<'_, AppState>,
    secret_id: Uuid,
    value: String,
) -> IpcResult<()> {
    state.with(|vault| vault.replace_secret_value(secret_id, &SecretString::new(value)))
}

/// Which environments a project's secrets use.
#[tauri::command]
pub fn project_environments(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> IpcResult<Vec<Environment>> {
    state.with(|vault| vault.project_environments(project_id))
}

/// Variable names a project defines more than once.
#[tauri::command]
pub fn env_conflicts(
    state: State<'_, AppState>,
    project_id: Uuid,
    environment: Option<Environment>,
) -> IpcResult<Vec<EnvConflict>> {
    state.with(|vault| vault.env_conflicts(project_id, environment))
}

/// What deleting a project would take with it.
#[tauri::command]
pub fn project_deletion_impact(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> IpcResult<DeletionImpact> {
    state.with(|vault| vault.project_deletion_impact(project_id))
}

/// Every secret in the vault, metadata only, with what each belongs to.
#[tauri::command]
pub fn list_all_secrets(state: State<'_, AppState>) -> IpcResult<Vec<SecretListing>> {
    state.with(|vault| vault.list_all_secrets())
}

/// Every field the user named on an entity.
#[tauri::command]
pub fn custom_fields(state: State<'_, AppState>, entity: EntityRef) -> IpcResult<Vec<CustomField>> {
    state.with(|vault| vault.custom_fields(&entity))
}

/// Attach a field with a name the user chose.
#[tauri::command]
pub fn add_custom_field(
    state: State<'_, AppState>,
    entity: EntityRef,
    label: String,
    value: String,
) -> IpcResult<CustomField> {
    state.with(|vault| vault.add_custom_field(&entity, &label, &value))
}

/// Change a field's name or value.
#[tauri::command]
pub fn update_custom_field(
    state: State<'_, AppState>,
    field_id: Uuid,
    label: String,
    value: String,
) -> IpcResult<()> {
    state.with(|vault| vault.update_custom_field(field_id, &label, &value))
}

/// Remove a field.
#[tauri::command]
pub fn delete_custom_field(state: State<'_, AppState>, field_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.delete_custom_field(field_id))
}

/// The whole chain, from each email address down to the projects it reaches.
#[tauri::command]
pub fn ledger_overview(state: State<'_, AppState>) -> IpcResult<Vec<OverviewIdentity>> {
    state.with(|vault| vault.overview())
}
