//! Gathering the ledger for the AI assistant.

use super::*;

use crate::assistant::{self, Ledger, Prepared, Task};

impl Vault {
    /// The exact request the assistant would send for `task`: metadata only,
    /// with every email address replaced by a placeholder.
    ///
    /// Building it performs no network I/O. The desktop layer shows it to the
    /// user on request, then hands it to `devledger-connect` to send.
    pub fn assistant_prepare(&self, task: &Task, language: &str) -> Result<Prepared> {
        let people = self.overview()?;
        let projects = self.list_projects()?;
        let resources = self.list_service_projects()?;
        let secrets = self.list_all_secrets()?;
        let subscriptions = self.list_subscriptions()?;
        let works_on = self.identity_project_links()?;
        let attention = self.needs_attention()?;
        assistant::prepare(
            &Ledger {
                people: &people,
                projects: &projects,
                resources: &resources,
                secrets: &secrets,
                subscriptions: &subscriptions,
                works_on: &works_on,
                attention: &attention,
            },
            task,
            language,
        )
    }

    /// Record that an outline left the machine, and why.
    pub fn record_assistant_request(&self, task: &Task) -> Result<()> {
        let detail = match task {
            Task::Review => "Sent a metadata-only outline to the assistant: setup review",
            Task::Leak { .. } => "Sent a metadata-only outline to the assistant: leaked-key plan",
            Task::Ask { .. } => "Sent a metadata-only outline to the assistant: question",
        };
        let secret = match task {
            Task::Leak { secret_id } => Some(*secret_id),
            _ => None,
        };
        self.store()?.audit(
            "assistant.request",
            secret.map(|_| "secret"),
            secret,
            detail,
        )
    }
}
