//! Smart Paste: analyse a paste, then commit or discard what the review sheet shows.

use devledger_core::paste::review::{CommitOutcome, ReviewSubmission};
use devledger_core::paste::PasteAnalysis;
use devledger_core::redact::SourceKind;
use tauri::State;
use uuid::Uuid;

use crate::{AppState, IpcResult};

// ---------------------------------------------------------------- smart paste

/// Analyse pasted text. Writes nothing; stages the result for review.
#[tauri::command]
pub fn smart_paste_analyze(state: State<'_, AppState>, text: String) -> IpcResult<PasteAnalysis> {
    state.with(|vault| vault.analyze_paste(&text, SourceKind::SmartPaste))
}

/// Drop a staged analysis the user closed without saving.
#[tauri::command]
pub fn smart_paste_discard(state: State<'_, AppState>, analysis_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.discard_analysis(analysis_id))
}

/// Apply the review sheet.
///
/// Only the submission crosses the boundary: the analysis it answers is the one
/// staged in Rust, so a tampered copy cannot relax a warning.
#[tauri::command]
pub fn smart_paste_commit(
    state: State<'_, AppState>,
    submission: ReviewSubmission,
) -> IpcResult<CommitOutcome> {
    state.with(|vault| vault.commit_review(&submission))
}
