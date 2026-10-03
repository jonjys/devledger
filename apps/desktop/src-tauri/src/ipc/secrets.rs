//! The commands that touch a secret value. Only `reveal_secret` hands plaintext
//! to the frontend; copying goes from Rust straight to the OS clipboard.

use std::time::Duration;

use devledger_core::model::Environment;
use devledger_core::secret::SecretString;
use tauri::State;
use tauri_plugin_clipboard_manager::ClipboardExt;
use uuid::Uuid;

use crate::{AppState, IpcError, IpcResult};

// -------------------------------------------------------------------- secrets

/// **The only command that returns a secret value to JavaScript.**
///
/// The user must click Reveal to reach it, and every call is written to the
/// audit log before the value is returned.
#[tauri::command]
pub fn reveal_secret(state: State<'_, AppState>, secret_id: Uuid) -> IpcResult<String> {
    state.with(|vault| Ok(vault.reveal_secret(secret_id)?.expose().to_string()))
}

/// Write sensitive text and remove it after 30 seconds if it is still current.
fn write_sensitive_clipboard(app: &tauri::AppHandle, value: &SecretString) -> IpcResult<()> {
    let expected = value.clone();
    app.clipboard()
        .write_text(expected.expose().to_owned())
        .map_err(|e| IpcError {
            code: "clipboard",
            message: format!("could not write to the clipboard: {e}"),
        })?;

    // Clear only if our value is still there. This avoids erasing something
    // the user copied after the credential.
    let cleanup_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        if cleanup_app.clipboard().read_text().ok().as_deref() == Some(expected.expose()) {
            let _ = cleanup_app.clipboard().clear();
        }
    });
    Ok(())
}

/// Copy a secret to the clipboard without it passing through the frontend.
#[tauri::command]
pub fn copy_secret(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    secret_id: Uuid,
) -> IpcResult<()> {
    let value = state.with(|vault| vault.reveal_secret(secret_id))?;
    write_sensitive_clipboard(&app, &value)
}

/// Copy a whole project as a `.env` file, rendered in Rust.
///
/// Returns the number of variables copied so the UI can confirm, without ever
/// seeing a value.
#[tauri::command]
pub fn copy_env(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: Uuid,
    environment: Option<Environment>,
) -> IpcResult<usize> {
    let rendered = state.with(|vault| vault.export_env_for_environment(project_id, environment))?;
    let count = rendered.expose().lines().filter(|l| !l.is_empty()).count();
    write_sensitive_clipboard(&app, &rendered)?;
    Ok(count)
}
