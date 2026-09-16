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

use devledger_core::model::{EntityKind, EntityRef, Environment, Project};
use devledger_core::paste::review::{CommitOutcome, ReviewSubmission};
use devledger_core::paste::PasteAnalysis;
use devledger_core::redact::{Provenance, SourceKind};
use devledger_core::secret::SecretString;
use devledger_core::store::{AuditEntry, ProjectSummary, VaultEntry};
use devledger_core::vault::{default_vault_dir, VaultStatus};
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

/// Create a project by hand.
#[tauri::command]
fn create_project(
    state: State<'_, AppState>,
    name: String,
    project_ref: Option<String>,
    environment: Environment,
) -> IpcResult<Project> {
    state.with(|vault| vault.create_project(&name, project_ref.as_deref(), environment))
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
) -> IpcResult<usize> {
    let rendered = state.with(|vault| vault.export_env(project_id))?;
    let count = rendered.expose().lines().filter(|l| !l.is_empty()).count();
    app.clipboard()
        .write_text(rendered.expose().to_string())
        .map_err(|e| IpcError {
            code: "clipboard",
            message: format!("could not write to the clipboard: {e}"),
        })?;
    Ok(count)
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
            delete_secret,
            secret_provenance,
            recent_audit,
            reveal_secret,
            copy_secret,
            copy_env,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevLedger");
}
