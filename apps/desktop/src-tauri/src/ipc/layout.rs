//! The user's layout for the interface: home boxes, tab order and templates.
//!
//! An opaque JSON document the frontend owns, kept in the vault so notes in it
//! are encrypted with everything else.

use serde::Serialize;
use tauri::State;

use crate::{AppState, IpcResult};

/// The saved layout, absent until the user first changes it.
#[derive(Debug, Serialize)]
pub struct UiLayout {
    layout: Option<String>,
}

#[tauri::command]
pub fn ui_layout_get(state: State<'_, AppState>) -> IpcResult<UiLayout> {
    state
        .with(|vault| vault.ui_layout())
        .map(|layout| UiLayout { layout })
}

#[tauri::command]
pub fn ui_layout_set(state: State<'_, AppState>, layout: String) -> IpcResult<()> {
    state.with(|vault| vault.set_ui_layout(&layout))
}

#[tauri::command]
pub fn ui_layout_reset(state: State<'_, AppState>) -> IpcResult<()> {
    state.with(|vault| vault.reset_ui_layout())
}
