//! Vault operations for Connect & Discover.
//!
//! Split out of `vault.rs` to keep the connector lifecycle readable: store a
//! credential, reconcile a discovery against the graph, and apply an import the
//! user confirmed.

use uuid::Uuid;

use crate::connect::reconcile::{GraphView, MatchStatus, ReconcileReport, ReconcileScope};
use crate::connect::{
    self, check_token_shape, AuthKind, Connection, ConnectionSummary, ConnectorDescriptor,
    ConnectorId, Discovery,
};
use crate::crypto::aead;
use crate::crypto::blind_index::{self, DOMAIN_PROJECT_REF};
use crate::error::{CoreError, Result};
use crate::model::{
    EntityKind, EntityRef, Environment, Evidence, EvidenceLevel, Organization, Provider,
    RelationKind, ServiceProject,
};
use crate::secret::SecretString;
use crate::store::Store;
use crate::vault::Vault;

use serde::{Deserialize, Serialize};

/// Associated data binding a stored credential to its connection.
fn credential_aad(connection_id: Uuid) -> Vec<u8> {
    format!("devledger/connection/{connection_id}").into_bytes()
}

/// A connection plus everything the review screen needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectOutcome {
    /// The connection, new or refreshed.
    pub connection: Connection,
    /// Whether this replaced an existing connection for the same account.
    pub reconnected: bool,
    /// What importing would do.
    pub report: ReconcileReport,
}

/// What an import actually changed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ImportOutcome {
    /// Organizations created.
    pub organizations_created: usize,
    /// Organizations updated (renamed, or given a provider id).
    pub organizations_updated: usize,
    /// Resources created.
    pub resources_created: usize,
    /// Resources updated.
    pub resources_updated: usize,
    /// Rows skipped because the user left them unticked.
    pub skipped: usize,
    /// Rows refused because importing them would move a resource between
    /// accounts.
    pub conflicts_refused: usize,
}

/// Adapts [`Store`] to the reconciliation trait.
struct StoreGraph<'a> {
    store: &'a Store,
}

impl GraphView for StoreGraph<'_> {
    fn service_project_by_ref(
        &self,
        provider: Provider,
        provider_ref: &str,
    ) -> Result<Option<ServiceProject>> {
        self.store.service_project_by_ref(provider, provider_ref)
    }
    fn service_project_by_name_in_account(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> Result<Option<ServiceProject>> {
        self.store
            .service_project_by_name_in_account(account_id, name)
    }
    fn organization_by_provider_id(
        &self,
        account_id: Uuid,
        provider_org_id: &str,
    ) -> Result<Option<Organization>> {
        self.store
            .organization_by_provider_id(account_id, provider_org_id)
    }
    fn organization_by_name_in_account(
        &self,
        account_id: Uuid,
        name: &str,
    ) -> Result<Option<Organization>> {
        self.store.organization_by_name(account_id, name)
    }
}

impl Vault {
    /// The connectors this build ships.
    pub fn connectors(&self) -> Vec<ConnectorDescriptor> {
        connect::available_connectors()
    }

    /// Every connected account, with its counts.
    pub fn list_connections(&self) -> Result<Vec<ConnectionSummary>> {
        let store = self.store()?;
        store
            .list_connections()?
            .into_iter()
            .map(|c| store.connection_summary(c))
            .collect()
    }

    /// Store a verified credential and reconcile what it found.
    ///
    /// `discovery` has already been fetched by `devledger-connect`, so this
    /// method performs no I/O beyond the database: the credential is only
    /// stored once it has demonstrably worked.
    ///
    /// Connecting a second account never touches the first. The account is
    /// recognised by a blind index over the provider org ids the credential can
    /// see, so reconnecting the *same* account refreshes it while a genuinely
    /// different account always gets its own connection, identity and account.
    pub fn connect_provider(
        &mut self,
        connector_id: &ConnectorId,
        token: &SecretString,
        label: &str,
        discovery: &Discovery,
    ) -> Result<ConnectOutcome> {
        let descriptor = connect::connector(connector_id)?;
        check_token_shape(&descriptor.auth, token.expose())?;

        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Invalid(
                "give this connection a label so you can tell your accounts apart".into(),
            ));
        }

        let fingerprint = self.account_fingerprint(discovery)?;
        let existing = self
            .store()?
            .connection_by_fingerprint(connector_id, &fingerprint)?;

        let (connection, reconnected) = match existing {
            Some(connection) => {
                // Same provider account: refresh it rather than creating a
                // second row that would split the same account in two.
                let sealed = self.seal_credential(connection.id, token)?;
                self.store()?
                    .update_connection_credential(connection.id, &sealed)?;
                self.store()?.rename_connection(connection.id, label)?;
                (connection, true)
            }
            None => {
                let identity_id = self.identity_for_connection(discovery, label)?;
                let account_id =
                    self.account_for_connection(identity_id, descriptor.provider, label)?;

                // The credential is sealed against the connection id, so it has
                // to exist first. A placeholder is written, then replaced.
                let created = self.store()?.create_connection(
                    connector_id,
                    identity_id,
                    account_id,
                    label,
                    &fingerprint,
                    auth_kind_tag(&descriptor.auth),
                    &[],
                )?;
                let sealed = self.seal_credential(created.id, token)?;
                self.store()?
                    .update_connection_credential(created.id, &sealed)?;
                (created, false)
            }
        };

        self.store()?.save_discovery(connection.id, discovery)?;
        self.store()?.touch_connection(connection.id)?;

        let report = self.reconcile_connection(&connection, discovery)?;
        Ok(ConnectOutcome {
            connection,
            reconnected,
            report,
        })
    }

    /// Reconcile a discovery against the graph without writing anything.
    pub fn reconcile_connection(
        &self,
        connection: &Connection,
        discovery: &Discovery,
    ) -> Result<ReconcileReport> {
        let store = self.store()?;
        let graph = StoreGraph { store };
        connect::reconcile::reconcile(
            connection.id,
            connection.account_id,
            discovery.provider,
            discovery,
            &graph,
        )
    }

    /// The review screen for a connection's most recent discovery.
    pub fn connection_report(&self, connection_id: Uuid) -> Result<ReconcileReport> {
        let connection = self
            .store()?
            .connection(connection_id)?
            .ok_or_else(|| CoreError::NotFound(format!("connection {connection_id}")))?;
        let discovery = self
            .store()?
            .latest_discovery(connection_id)?
            .ok_or_else(|| {
                CoreError::NotFound(format!("no discovery yet for connection {connection_id}"))
            })?;
        self.reconcile_connection(&connection, &discovery)
    }

    /// Hand back the stored credential so a refresh can use it.
    ///
    /// The only caller is the desktop layer's refresh command, which passes it
    /// straight to the connector. It is never returned over IPC.
    pub fn connection_token(&self, connection_id: Uuid) -> Result<SecretString> {
        let store = self.store()?;
        let sealed = store.connection_credential(connection_id)?;
        if sealed.is_empty() {
            return Err(CoreError::NotFound(format!(
                "connection {connection_id} has no stored credential"
            )));
        }
        let plaintext = aead::open(self.aead_key()?, &credential_aad(connection_id), &sealed)?;
        let text = String::from_utf8(plaintext.expose().to_vec())
            .map_err(|_| CoreError::Crypto("stored credential is not valid UTF-8".into()))?;
        store.audit(
            "connection.use_credential",
            None,
            Some(connection_id),
            "Read stored credential for a provider request",
        )?;
        Ok(SecretString::new(text))
    }

    /// Record a fresh discovery for an existing connection.
    pub fn record_discovery(
        &self,
        connection_id: Uuid,
        discovery: &Discovery,
    ) -> Result<ReconcileReport> {
        let store = self.store()?;
        let connection = store
            .connection(connection_id)?
            .ok_or_else(|| CoreError::NotFound(format!("connection {connection_id}")))?;
        store.save_discovery(connection_id, discovery)?;
        store.touch_connection(connection_id)?;
        self.reconcile_connection(&connection, discovery)
    }

    /// Apply the rows the user ticked.
    ///
    /// `accepted` holds the provider ids of the rows to import. A row DevLedger
    /// classified as a [`MatchStatus::Conflict`] is refused even if it is in
    /// the list: moving a resource between accounts is not something a checkbox
    /// should be able to do.
    pub fn import_discovery(
        &mut self,
        connection_id: Uuid,
        accepted: &[String],
    ) -> Result<ImportOutcome> {
        let (connection, discovery, report) = {
            let store = self.store()?;
            let connection = store
                .connection(connection_id)?
                .ok_or_else(|| CoreError::NotFound(format!("connection {connection_id}")))?;
            let discovery = store.latest_discovery(connection_id)?.ok_or_else(|| {
                CoreError::NotFound(format!("no discovery yet for connection {connection_id}"))
            })?;
            let report = self.reconcile_connection(&connection, &discovery)?;
            (connection, discovery, report)
        };

        let mut outcome = ImportOutcome::default();
        let provider = discovery.provider;

        // Organizations first, so a project can be filed into one in the same pass.
        for item in report
            .items
            .iter()
            .filter(|i| i.scope == ReconcileScope::Organization)
        {
            if item.status == MatchStatus::Conflict {
                if accepted.contains(&item.provider_id) {
                    outcome.conflicts_refused += 1;
                }
                continue;
            }
            if !accepted.contains(&item.provider_id) {
                if item.status.writes() {
                    outcome.skipped += 1;
                }
                continue;
            }
            match item.status {
                MatchStatus::Unmatched => {
                    self.store()?.create_organization(
                        connection.account_id,
                        Some(&item.provider_id),
                        &item.name,
                    )?;
                    outcome.organizations_created += 1;
                }
                MatchStatus::PossibleMatch | MatchStatus::NeedsAttention => {
                    if let Some(entity) = &item.existing {
                        let store = self.store()?;
                        store.set_organization_provider_id(entity.id, &item.provider_id)?;
                        store.rename_organization(entity.id, &item.name)?;
                        outcome.organizations_updated += 1;
                    }
                }
                MatchStatus::Matched | MatchStatus::Conflict => {}
            }
        }

        for item in report
            .items
            .iter()
            .filter(|i| i.scope == ReconcileScope::Project)
        {
            if item.status == MatchStatus::Conflict {
                if accepted.contains(&item.provider_id) {
                    outcome.conflicts_refused += 1;
                }
                continue;
            }
            if !accepted.contains(&item.provider_id) {
                if item.status.writes() {
                    outcome.skipped += 1;
                }
                continue;
            }

            let discovered = discovery
                .projects
                .iter()
                .find(|p| p.provider_ref == item.provider_id);
            let region = discovered.and_then(|p| p.region.as_deref());
            let organization_id = match item.parent_provider_org_id.as_deref() {
                Some(org_id) if !org_id.is_empty() => self
                    .store()?
                    .organization_by_provider_id(connection.account_id, org_id)?
                    .map(|o| o.id),
                _ => None,
            };

            match item.status {
                MatchStatus::Unmatched => {
                    // Defence in depth: reconciliation already refuses a ref
                    // owned by another account, and so does this.
                    if self.store()?.ref_belongs_to_other_account(
                        provider,
                        &item.provider_id,
                        connection.account_id,
                    )? {
                        outcome.conflicts_refused += 1;
                        continue;
                    }
                    let created = self.store()?.create_service_project(
                        connection.account_id,
                        organization_id,
                        provider,
                        Some(&item.provider_id),
                        &item.name,
                        region,
                        Environment::Unknown,
                    )?;
                    outcome.resources_created += 1;
                    if let Some(org_id) = organization_id {
                        self.store()?.create_relation(
                            EntityRef::new(EntityKind::Organization, org_id),
                            EntityRef::new(EntityKind::ServiceProject, created.id),
                            RelationKind::Contains,
                            &Evidence::new(
                                EvidenceLevel::Explicit,
                                "connector.supabase",
                                "Read directly from the provider",
                            ),
                        )?;
                    }
                }
                MatchStatus::PossibleMatch | MatchStatus::NeedsAttention => {
                    if let Some(entity) = &item.existing {
                        let store = self.store()?;
                        store.update_service_project_from_provider(
                            entity.id,
                            &item.name,
                            &item.provider_id,
                            region,
                        )?;
                        if let Some(org_id) = organization_id {
                            store.set_service_project_organization(entity.id, Some(org_id))?;
                            store.create_relation(
                                EntityRef::new(EntityKind::Organization, org_id),
                                EntityRef::new(EntityKind::ServiceProject, entity.id),
                                RelationKind::Contains,
                                &Evidence::new(
                                    EvidenceLevel::Explicit,
                                    "connector.supabase",
                                    "Read directly from the provider",
                                ),
                            )?;
                        }
                        outcome.resources_updated += 1;
                    }
                }
                MatchStatus::Matched | MatchStatus::Conflict => {}
            }
        }

        self.store()?.audit(
            "connection.import",
            None,
            Some(connection_id),
            &format!(
                "Imported {} new and {} updated resources, {} organizations",
                outcome.resources_created,
                outcome.resources_updated,
                outcome.organizations_created + outcome.organizations_updated
            ),
        )?;
        Ok(outcome)
    }

    /// Forget a connection.
    ///
    /// Deletes the stored credential. What was imported stays: disconnecting
    /// withdraws DevLedger's access, it does not erase what you learned.
    pub fn disconnect(&self, connection_id: Uuid) -> Result<()> {
        self.store()?.delete_connection(connection_id)
    }

    // --------------------------------------------------------------- helpers

    fn seal_credential(&self, connection_id: Uuid, token: &SecretString) -> Result<Vec<u8>> {
        aead::seal(
            self.aead_key()?,
            &credential_aad(connection_id),
            token.expose().as_bytes(),
        )
    }

    /// A blind index over the provider ids the credential can see.
    ///
    /// Two tokens for the same account produce the same fingerprint; tokens for
    /// different accounts do not. The raw provider ids never reach the column.
    fn account_fingerprint(&self, discovery: &Discovery) -> Result<String> {
        blind_index::blind_index(
            self.index_key()?,
            DOMAIN_PROJECT_REF,
            &discovery.fingerprint_material(),
        )
    }

    /// The identity a connection belongs to.
    ///
    /// A provider that reports the account email matches on it. Supabase does
    /// not, so the label the user typed is used when it is an email, and
    /// otherwise a dedicated identity is created for this connection rather
    /// than attaching it to an unrelated one.
    fn identity_for_connection(&self, discovery: &Discovery, label: &str) -> Result<Uuid> {
        let email = discovery.account_email.as_deref().or_else(|| {
            if label.contains('@') {
                Some(label)
            } else {
                None
            }
        });

        match email {
            Some(email) => self.identity_id_for_email(email),
            None => Ok(self.store()?.create_identity(label, None, None)?.id),
        }
    }

    fn account_for_connection(
        &self,
        identity_id: Uuid,
        provider: Provider,
        label: &str,
    ) -> Result<Uuid> {
        let store = self.store()?;
        if let Some(existing) = store.account_for(identity_id, provider)? {
            return Ok(existing.id);
        }
        Ok(store.create_account(identity_id, provider, None, label)?.id)
    }
}

/// Tag stored in the `auth_kind` column, so a future OAuth credential is
/// distinguishable from a token without reading the ciphertext.
fn auth_kind_tag(auth: &AuthKind) -> &'static str {
    match auth {
        AuthKind::PersonalAccessToken { .. } => "personal_access_token",
        AuthKind::OAuth2Pkce { .. } => "oauth2_pkce",
    }
}
