//! The AI assistant: an Anthropic API key in the vault, and questions about the ledger.
//!
//! What is sent is built by `devledger_core::assistant` and holds no secret
//! values, no previews and no email addresses; `assistant_preview` returns it
//! verbatim so the user can read it before anything leaves the machine. The
//! request itself goes through `devledger-connect`, outside the vault lock.

use devledger_core::assistant::Task;
use devledger_core::secret::SecretString;
use devledger_core::CoreError;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::{AppState, IpcError, IpcResult};

/// Whether the assistant can be used, and with which model.
#[derive(Debug, Serialize)]
pub struct AssistantStatus {
    enabled: bool,
    model: &'static str,
}

/// Exactly what would be sent.
#[derive(Debug, Serialize)]
pub struct AssistantPreview {
    system: String,
    user: String,
    /// How many email addresses were replaced by placeholders.
    addresses_hidden: usize,
}

/// The assistant's answer, with real addresses restored.
#[derive(Debug, Serialize)]
pub struct AssistantAnswer {
    text: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    truncated: bool,
}

fn assistant_error(e: devledger_connect::ConnectError) -> IpcError {
    IpcError {
        code: "assistant",
        message: e.to_string(),
    }
}

fn task_from(
    task: &str,
    secret_id: Option<Uuid>,
    question: Option<String>,
) -> Result<Task, CoreError> {
    match task {
        "review" => Ok(Task::Review),
        "leak" => secret_id
            .map(|secret_id| Task::Leak { secret_id })
            .ok_or_else(|| CoreError::Invalid("choose the key that leaked".into())),
        "ask" => Ok(Task::Ask {
            question: question.unwrap_or_default(),
        }),
        other => Err(CoreError::Invalid(format!(
            "the assistant has no task called {other}"
        ))),
    }
}

fn status(enabled: bool) -> AssistantStatus {
    AssistantStatus {
        enabled,
        model: devledger_connect::assistant::MODEL,
    }
}

/// Whether a key is set.
#[tauri::command]
pub fn assistant_status(state: State<'_, AppState>) -> IpcResult<AssistantStatus> {
    state.with(|vault| vault.assistant_enabled()).map(status)
}

/// Check an Anthropic API key with one read, then seal it into the vault.
#[tauri::command]
pub async fn assistant_set_key(
    state: State<'_, AppState>,
    key: String,
) -> IpcResult<AssistantStatus> {
    let key = SecretString::new(key.trim().to_string());
    if !key.expose().starts_with("sk-ant-") {
        return Err(IpcError::from(CoreError::Invalid(
            "that does not look like an Anthropic API key; they start with sk-ant-".into(),
        )));
    }
    // Make sure the vault is open before spending a request.
    state.with(|vault| vault.assistant_enabled())?;
    devledger_connect::assistant::verify(key.expose())
        .await
        .map_err(assistant_error)?;
    state.with(|vault| vault.set_assistant_key(&key))?;
    Ok(status(true))
}

/// Forget the key.
#[tauri::command]
pub fn assistant_clear_key(state: State<'_, AppState>) -> IpcResult<AssistantStatus> {
    state.with(|vault| vault.clear_assistant_key())?;
    Ok(status(false))
}

/// Exactly what asking would send. Nothing leaves the machine.
#[tauri::command]
pub fn assistant_preview(
    state: State<'_, AppState>,
    task: String,
    secret_id: Option<Uuid>,
    question: Option<String>,
    language: String,
) -> IpcResult<AssistantPreview> {
    state.with(|vault| {
        let prepared =
            vault.assistant_prepare(&task_from(&task, secret_id, question)?, &language)?;
        Ok(AssistantPreview {
            addresses_hidden: prepared.placeholder_count(),
            system: prepared.system,
            user: prepared.user,
        })
    })
}

/// Ask the assistant. Sends the outline `assistant_preview` shows, nothing more.
#[tauri::command]
pub async fn assistant_ask(
    state: State<'_, AppState>,
    task: String,
    secret_id: Option<Uuid>,
    question: Option<String>,
    language: String,
) -> IpcResult<AssistantAnswer> {
    let (prepared, key) = state.with(|vault| {
        let task = task_from(&task, secret_id, question)?;
        let prepared = vault.assistant_prepare(&task, &language)?;
        let key = vault.assistant_key()?;
        vault.record_assistant_request(&task)?;
        Ok((prepared, key))
    })?;
    let answer = devledger_connect::assistant::ask(key.expose(), &prepared.system, &prepared.user)
        .await
        .map_err(assistant_error)?;
    Ok(AssistantAnswer {
        text: prepared.restore(&answer.text),
        model: answer.model,
        input_tokens: answer.input_tokens,
        output_tokens: answer.output_tokens,
        truncated: answer.truncated,
    })
}
