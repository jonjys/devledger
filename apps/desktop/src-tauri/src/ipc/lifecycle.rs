//! Creating, unlocking and locking the vault.

use devledger_core::secret::SecretString;
use devledger_core::vault::VaultStatus;
use tauri::State;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{AppState, IpcResult};

// ----------------------------------------------------------------- lifecycle

/// Whether a vault exists and whether it is open.
#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> IpcResult<VaultStatus> {
    state.with(|vault| Ok(vault.status()))
}

/// Create the vault. Onboarding calls this once.
#[tauri::command]
pub fn vault_initialize(state: State<'_, AppState>, passphrase: String) -> IpcResult<VaultStatus> {
    state.with(|vault| {
        vault.initialize(&SecretString::new(passphrase))?;
        Ok(vault.status())
    })
}

/// Open an existing vault.
#[tauri::command]
pub fn vault_unlock(state: State<'_, AppState>, passphrase: String) -> IpcResult<VaultStatus> {
    state.with(|vault| {
        vault.unlock(&SecretString::new(passphrase))?;
        Ok(vault.status())
    })
}

/// Close the vault, dropping every key.
#[tauri::command]
pub fn vault_lock(app: tauri::AppHandle, state: State<'_, AppState>) -> IpcResult<VaultStatus> {
    let status = state.with(|vault| {
        vault.lock();
        Ok(vault.status())
    })?;
    // Locking must drop secrets from both process memory and the OS clipboard.
    let _ = app.clipboard().clear();
    Ok(status)
}
