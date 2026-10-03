//! Connectors: the only commands that touch the network.

use devledger_core::connect::reconcile::ReconcileReport;
use devledger_core::connect::{ConnectionSummary, ConnectorDescriptor, ConnectorId};
use devledger_core::connect_vault::{ConnectOutcome, ImportOutcome};
use devledger_core::secret::SecretString;
use tauri::State;
use uuid::Uuid;

use crate::{AppState, IpcError, IpcResult};

// ------------------------------------------------------------------ connectors
//
// These are the only commands that touch the network, and each one runs because
// the user pressed a button. The fetch happens in `devledger-connect`, outside
// the vault lock, so the mutex is never held across an await.

/// The connectors this build ships.
#[tauri::command]
pub fn list_connectors(state: State<'_, AppState>) -> IpcResult<Vec<ConnectorDescriptor>> {
    state.with(|vault| Ok(vault.connectors()))
}

/// Every connected provider account.
#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> IpcResult<Vec<ConnectionSummary>> {
    state.with(|vault| vault.list_connections())
}

/// Connect a provider account.
///
/// The token is verified against the provider *before* it is stored, so a
/// mistyped or revoked credential never reaches the database. Nothing is
/// imported: the returned report is what the user reviews.
#[tauri::command]
pub async fn connector_connect(
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
pub async fn connector_refresh(
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
pub fn connector_report(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> IpcResult<ReconcileReport> {
    state.with(|vault| vault.connection_report(connection_id))
}

/// Apply the rows the user ticked.
#[tauri::command]
pub fn connector_import(
    state: State<'_, AppState>,
    connection_id: Uuid,
    accepted: Vec<String>,
) -> IpcResult<ImportOutcome> {
    state.with(|vault| vault.import_discovery(connection_id, &accepted))
}

/// Forget a connection. Imported data is kept.
#[tauri::command]
pub fn connector_disconnect(state: State<'_, AppState>, connection_id: Uuid) -> IpcResult<()> {
    state.with(|vault| vault.disconnect(connection_id))
}
