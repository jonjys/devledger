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
//! 2. **Network access is explicit.** Only connector commands call a provider,
//!    after a user action. The webview has no HTTP, shell or filesystem
//!    capability; provider requests stay in the Rust connector boundary.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use devledger_core::vault::default_vault_dir;
use devledger_core::{CoreError, Vault};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

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
    /// When the UI last asked for anything.
    ///
    /// The frontend never polls, so every command is the result of something
    /// the user did. That makes "time since the last command" an honest measure
    /// of whether anyone is at the keyboard.
    last_activity: Mutex<Instant>,
}

/// How long the vault stays open with nobody using it.
pub const IDLE_LOCK_AFTER: Duration = Duration::from_secs(15 * 60);

/// How often the idle check runs. Bounds how late an idle lock can be.
const IDLE_CHECK_EVERY: Duration = Duration::from_secs(30);

impl AppState {
    fn new(vault: Vault) -> Self {
        AppState {
            vault: Mutex::new(vault),
            last_activity: Mutex::new(Instant::now()),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T, CoreError>) -> IpcResult<T> {
        if let Ok(mut at) = self.last_activity.lock() {
            *at = Instant::now();
        }
        let mut guard = self.vault.lock().map_err(|_| IpcError {
            code: "poisoned",
            message: "vault state was left inconsistent by an earlier failure".into(),
        })?;
        f(&mut guard).map_err(IpcError::from)
    }

    /// Lock the vault if nothing has used it for `limit`. Returns whether this
    /// call is what locked it.
    ///
    /// The timer lives here rather than in the webview so that a frontend bug,
    /// or a compromised frontend, cannot keep the vault open by simply not
    /// running its timer. Locking drops the keys from memory, exactly like the
    /// Lock button.
    fn lock_if_idle(&self, now: Instant, limit: Duration) -> bool {
        let idle = match self.last_activity.lock() {
            Ok(at) => now.saturating_duration_since(*at),
            Err(_) => return false,
        };
        if idle < limit {
            return false;
        }
        let Ok(mut vault) = self.vault.lock() else {
            return false;
        };
        if !vault.is_unlocked() {
            return false;
        }
        vault.lock();
        true
    }
}

mod ipc;

use ipc::connectors::*;
use ipc::lifecycle::*;
use ipc::manual::*;
use ipc::paste::*;
use ipc::secrets::*;
use ipc::vault::*;

/// Build and run the application on desktop, Android, and iOS.
///
/// # Panics
///
/// Panics if the platform app-data directory cannot be resolved, which means
/// there is nowhere to put a vault.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("the platform must provide an app data directory");
            app.manage(AppState::new(Vault::new(default_vault_dir(&app_data))));

            // Idle lock. When it fires, the clipboard is cleared as the Lock
            // button does, and the UI is told at once so that a revealed value
            // does not stay on screen until the next click.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(IDLE_CHECK_EVERY);
                let state = handle.state::<AppState>();
                if state.lock_if_idle(Instant::now(), IDLE_LOCK_AFTER) {
                    let _ = handle.clipboard().clear();
                    let _ = handle.emit("vault-locked", "idle");
                }
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
            create_identity_manual,
            create_account_manual,
            create_account_for_email,
            add_account,
            create_service_project_manual,
            create_manual_secret,
            create_subscription_manual,
            move_account,
            move_organization,
            move_service_project,
            delete_account,
            delete_organization,
            rename_organization,
            link_identity_project,
            unlink_identity_project,
            identity_project_links,
            delete_service_project,
            delete_subscription,
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
            update_identity,
            delete_identity,
            identity_emails,
            add_identity_email,
            set_primary_email,
            remove_identity_email,
            update_account,
            account_secrets,
            update_resource,
            store_secret,
            update_secret_meta,
            replace_secret_value,
            project_environments,
            env_conflicts,
            project_deletion_impact,
            ledger_overview,
            custom_fields,
            list_all_secrets,
            add_custom_field,
            update_custom_field,
            delete_custom_field,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevLedger");
}

#[cfg(test)]
mod idle_lock_tests {
    use super::*;
    use devledger_core::crypto::kdf::KdfParams;
    use devledger_core::secret::SecretString;
    use uuid::Uuid;

    fn unlocked_state() -> (std::path::PathBuf, AppState) {
        let dir = std::env::temp_dir().join(format!("devledger-idle-{}", Uuid::new_v4()));
        let mut vault = Vault::new(&dir);
        vault
            .initialize_with_params(
                &SecretString::new("correct-horse-battery-staple"),
                KdfParams::weak_for_tests().expect("params"),
            )
            .expect("initialize");
        (dir, AppState::new(vault))
    }

    #[test]
    fn a_vault_in_use_stays_open() {
        let (dir, state) = unlocked_state();
        let soon = Instant::now() + Duration::from_secs(60);
        assert!(!state.lock_if_idle(soon, IDLE_LOCK_AFTER));
        assert!(state.vault.lock().unwrap().is_unlocked());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_idle_vault_locks_and_drops_its_keys() {
        let (dir, state) = unlocked_state();
        let later = Instant::now() + IDLE_LOCK_AFTER + Duration::from_secs(1);
        assert!(state.lock_if_idle(later, IDLE_LOCK_AFTER));
        assert!(!state.vault.lock().unwrap().is_unlocked());
        // A second check has nothing left to lock.
        assert!(!state.lock_if_idle(later, IDLE_LOCK_AFTER));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn any_command_resets_the_idle_clock() {
        let (dir, state) = unlocked_state();
        let start = Instant::now();
        // Something happens: the clock restarts from here.
        let _ = state.with(|vault| Ok(vault.status()));
        let almost = start + IDLE_LOCK_AFTER - Duration::from_secs(5);
        assert!(!state.lock_if_idle(almost, IDLE_LOCK_AFTER));
        let _ = std::fs::remove_dir_all(dir);
    }
}
