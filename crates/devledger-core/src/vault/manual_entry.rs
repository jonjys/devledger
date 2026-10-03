//! Building the ledger by hand, with no token and no network.

use super::*;

impl Vault {
    // ------------------------------------------------------- manual entry

    /// The shared "Unidentified" identity, created on demand.
    ///
    /// Used when the user records something by hand without naming an email, so
    /// the entry still hangs off a real identity rather than floating free.
    pub(super) fn unidentified_identity_id(&self) -> Result<Uuid> {
        const LABEL: &str = "Unidentified";
        let inner = self.unlocked()?;
        if let Some(existing) = inner
            .store
            .list_identities()?
            .into_iter()
            .find(|i| i.email.is_none() && i.label == LABEL)
        {
            return Ok(existing.id);
        }
        Ok(inner.store.create_identity(LABEL, None, None)?.id)
    }

    /// Resolve an identity from an optional email, creating it if needed.
    pub(super) fn identity_for_optional_email(&self, email: Option<&str>) -> Result<Uuid> {
        match email.map(str::trim).filter(|e| !e.is_empty()) {
            Some(email) => self.identity_id_for_email(email),
            None => self.unidentified_identity_id(),
        }
    }

    /// Create a provider account explicitly under an identity.
    ///
    /// Always inserts a new row. Use [`Self::add_account`] when an existing
    /// account for the same provider should be reused.
    pub fn create_account_manual(
        &self,
        identity_id: Uuid,
        provider: Provider,
        label: &str,
    ) -> Result<Account> {
        self.create_account_with_details(identity_id, provider, label, &AccountDetails::default())
    }

    /// Create an account together with how to sign in to it.
    ///
    /// The provider can be anything, including [`Provider::Other`] for a
    /// service DevLedger has no built-in knowledge of. The login address may
    /// differ from the identity's own: people sign in to different services
    /// with different addresses, and that is exactly what this records.
    pub fn create_account_with_details(
        &self,
        identity_id: Uuid,
        provider: Provider,
        label: &str,
        details: &AccountDetails,
    ) -> Result<Account> {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        let provider = Self::named_provider(provider, trimmed);
        let details = AccountDetails {
            login_email: match details.login_email.as_deref().map(str::trim) {
                Some(raw) if !raw.is_empty() => Some(manual::normalize_email(raw)?),
                _ => None,
            },
            username: manual::clean(details.username.as_deref()),
            url: manual::clean(details.url.as_deref()),
            notes: manual::clean(details.notes.as_deref()),
        };
        self.unlocked()?
            .store
            .create_account_full(identity_id, &provider, None, trimmed, &details)
    }

    /// Add a provider account for an identity resolved by email.
    ///
    /// This is the manual counterpart to Connect: it records that an account
    /// exists without contacting the provider. Like [`Self::add_account`] it
    /// always creates. `note` is stored as the account's external reference.
    pub fn create_account_for_email(
        &self,
        email: Option<&str>,
        provider: Provider,
        label: &str,
        note: Option<&str>,
    ) -> Result<Account> {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        let identity_id = self.identity_for_optional_email(email)?;
        self.add_account(identity_id, provider, trimmed, note)
    }

    /// Add a provider account under a known identity.
    ///
    /// Always creates. This is what the map's "Add account" and the service
    /// catalog call, and both are explicit requests for a new account. It used
    /// to hand back the identity's existing account for the same provider
    /// instead, which folded a second Supabase account into the first while the
    /// UI still reported "Account added" -- the silent merge DevLedger must never
    /// make. A duplicate added by mistake is visible and can be deleted; a merge
    /// nobody saw cannot be undone.
    pub fn add_account(
        &self,
        identity_id: Uuid,
        provider: Provider,
        label: &str,
        note: Option<&str>,
    ) -> Result<Account> {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("an account needs a label".into()));
        }
        let note = note.map(str::trim).filter(|n| !n.is_empty());
        let provider = Self::named_provider(provider, trimmed);
        self.unlocked()?
            .store
            .create_account(identity_id, &provider, note, trimmed)
    }

    /// The provider an explicit "add account" really means.
    ///
    /// The quick-add dialog's "Custom / other" choice sends `unknown` with the
    /// service's name as the label. That is not an unattributable credential,
    /// it is a service DevLedger has no built-in knowledge of -- so it becomes
    /// [`Provider::Other`] named after the label, which also keeps Cloudflare
    /// and Netlify apart instead of both filed as "unknown".
    pub(super) fn named_provider(provider: Provider, label: &str) -> Provider {
        match provider {
            Provider::Unknown if !label.trim().is_empty() => {
                Provider::Other(label.trim().to_string())
            }
            other => other,
        }
    }

    /// The account something implicit should be filed under, if that is knowable.
    ///
    /// For callers that are *not* an explicit "add account" -- a subscription
    /// entered by email and provider, for instance. No account: create one.
    /// Exactly one: that is the answer. Several: refuse, naming them, because
    /// picking one would file a bill under an account the user never chose.
    pub(super) fn resolve_account(
        &self,
        identity_id: Uuid,
        provider: &Provider,
        label: &str,
    ) -> Result<Account> {
        let inner = self.unlocked()?;
        let mut existing = inner.store.accounts_for(identity_id, provider)?;
        match existing.len() {
            0 => inner
                .store
                .create_account(identity_id, provider, None, label),
            1 => Ok(existing.remove(0)),
            _ => Err(CoreError::Invalid(format!(
                "this identity holds {} {} accounts ({}); add it from the right account in the map",
                existing.len(),
                provider.label(),
                existing
                    .iter()
                    .map(|a| a.label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// Record a provider resource by hand, under an account.
    pub fn create_service_project_manual(
        &self,
        account_id: Uuid,
        organization_id: Option<Uuid>,
        provider: Provider,
        name: &str,
        provider_ref: Option<&str>,
        environment: Environment,
    ) -> Result<ServiceProject> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(CoreError::Invalid("a resource needs a name".into()));
        }
        if let Some(org_id) = organization_id {
            let belongs = self
                .unlocked()?
                .store
                .organizations_for_account(account_id)?
                .iter()
                .any(|org| org.id == org_id);
            if !belongs {
                return Err(CoreError::Invalid(
                    "organization does not belong to this account".into(),
                ));
            }
        }
        let provider_ref = provider_ref.map(str::trim).filter(|r| !r.is_empty());
        self.unlocked()?.store.create_service_project(
            account_id,
            organization_id,
            &provider,
            provider_ref,
            trimmed,
            None,
            environment,
        )
    }

    /// Store a manually entered API key/secret against a project or provider resource.
    ///
    /// The plaintext crosses IPC only on the explicit Add API/Secret action and is
    /// immediately sealed by the same vault primitive used by Smart Paste.
    pub fn create_manual_secret(
        &mut self,
        project_id: Option<Uuid>,
        service_project_id: Option<Uuid>,
        name: &str,
        environment: Environment,
        value: &SecretString,
    ) -> Result<SecretRecord> {
        self.store_secret(
            &manual::NewSecret {
                owner: SecretOwner {
                    project_id,
                    service_project_id,
                    account_id: None,
                },
                kind: SecretKind::GenericApiKey,
                name: name.to_string(),
                environment,
                notes: None,
            },
            value,
        )
    }

    /// Record a subscription by hand, without a paste.
    ///
    /// The subscription hangs off an account for the resolved identity. When no
    /// provider is given it is filed under a generic account, which is enough to
    /// track "what am I paying for" without pretending to know the provider.
    #[allow(clippy::too_many_arguments)]
    pub fn create_subscription_manual(
        &self,
        email: Option<&str>,
        provider: Provider,
        plan: &str,
        status: SubscriptionStatus,
        amount_cents: Option<i64>,
        currency: Option<&str>,
        interval: Option<BillingInterval>,
        renews_at: Option<&str>,
    ) -> Result<Subscription> {
        let plan = plan.trim();
        if plan.is_empty() {
            return Err(CoreError::Invalid(
                "a subscription needs a plan name".into(),
            ));
        }
        let identity_id = self.identity_for_optional_email(email)?;
        let label = email
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| provider.label())
            .to_string();
        let account = self.resolve_account(identity_id, &provider, &label)?;
        let parsed = ParsedSubscription {
            plan: plan.to_string(),
            status,
            amount_cents,
            currency: currency
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            interval,
            trial_ends_at: renews_at
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string),
        };
        self.unlocked()?
            .store
            .create_subscription(account.id, &parsed)
    }

    /// Move an account under a different identity.
    pub fn move_account(&self, account_id: Uuid, identity_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .set_account_identity(account_id, identity_id)
    }

    /// Move an organization under a different account.
    pub fn move_organization(&self, organization_id: Uuid, account_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .set_organization_account(organization_id, account_id)
    }

    /// Move a resource under a different account, clearing its organization.
    pub fn move_service_project(
        &self,
        service_project_id: Uuid,
        account_id: Uuid,
        organization_id: Option<Uuid>,
    ) -> Result<()> {
        self.unlocked()?.store.set_service_project_account(
            service_project_id,
            account_id,
            organization_id,
        )
    }

    /// Delete an account and everything under it.
    pub fn delete_account(&self, account_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_account(account_id)
    }

    /// Rename an organization.
    pub fn rename_organization(&self, organization_id: Uuid, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CoreError::Invalid("an organization needs a name".into()));
        }
        self.unlocked()?
            .store
            .rename_organization(organization_id, name)
    }

    /// Delete an organization. Its resources survive, unassigned.
    pub fn delete_organization(&self, organization_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_organization(organization_id)
    }

    /// Delete a provider resource and its secrets.
    pub fn delete_service_project(&self, service_project_id: Uuid) -> Result<()> {
        self.unlocked()?
            .store
            .delete_service_project(service_project_id)
    }

    /// Delete a subscription.
    pub fn delete_subscription(&self, subscription_id: Uuid) -> Result<()> {
        self.unlocked()?.store.delete_subscription(subscription_id)
    }

    /// Every relation touching an entity.
    pub fn relations_for(&self, entity: EntityRef) -> Result<Vec<Relation>> {
        self.unlocked()?.store.relations_for(entity)
    }

    /// Recent audit-log lines.
    pub fn recent_audit(&self, limit: i64) -> Result<Vec<AuditEntry>> {
        self.unlocked()?.store.recent_audit(limit)
    }

    /// Provenance attached to an entity.
    pub fn provenance_for(&self, entity: EntityRef) -> Result<Vec<Provenance>> {
        self.unlocked()?.store.provenance_for(entity)
    }
}
