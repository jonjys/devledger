//! The identity graph the ledger draws, and what needs the user's attention.

use rusqlite::params;
use time::{Date, Duration, Month, OffsetDateTime};

use crate::error::Result;
use crate::model::{
    BillingInterval, EntityKind, EntityRef, Provider, SecretKind, SubscriptionStatus,
};

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::Store;

impl Store {
    // ------------------------------------------------------------------- map

    /// The whole graph, for the map view.
    pub fn identity_graph(&self) -> Result<Vec<IdentityNode>> {
        let mut nodes = Vec::new();
        for identity in self.list_identities()? {
            let mut accounts = Vec::new();
            for account in self.accounts_for_identity(identity.id)? {
                let mut organizations = Vec::new();
                for organization in self.organizations_for_account(account.id)? {
                    let mut service_projects = Vec::new();
                    for sp in self.list_service_projects()? {
                        if sp.organization_id == Some(organization.id) {
                            service_projects.push(self.service_project_summary(sp)?);
                        }
                    }
                    organizations.push(OrganizationNode {
                        organization,
                        service_projects,
                    });
                }
                let mut unassigned = Vec::new();
                for sp in self.list_service_projects()? {
                    if sp.account_id == account.id && sp.organization_id.is_none() {
                        unassigned.push(self.service_project_summary(sp)?);
                    }
                }
                accounts.push(AccountNode {
                    subscriptions: self.subscriptions_for_account(account.id)?,
                    account,
                    organizations,
                    unassigned,
                });
            }
            nodes.push(IdentityNode { identity, accounts });
        }
        Ok(nodes)
    }

    /// Everything DevLedger could not work out on its own, as of now.
    pub fn needs_attention(&self) -> Result<Vec<AttentionItem>> {
        self.needs_attention_at(OffsetDateTime::now_utc())
    }

    /// [`Store::needs_attention`] as of `now`, so the checks that depend on
    /// the date (old keys, trials ending) can be tested.
    pub fn needs_attention_at(&self, now: OffsetDateTime) -> Result<Vec<AttentionItem>> {
        let mut items = Vec::new();

        for sp in self.list_service_projects()? {
            // A missing organization is only a gap where there is one to name:
            // every Supabase project sits in an organization, and an account
            // that already has organizations should say which. A GitHub repo
            // or Vercel project on a personal account has none, and drawing
            // that a project uses it must not raise an alarm.
            let expected = matches!(sp.provider, Provider::Supabase)
                || !self.organizations_for_account(sp.account_id)?.is_empty();
            if sp.organization_id.is_none() && expected {
                items.push(AttentionItem {
                    kind: AttentionKind::UnassignedOrganization,
                    title: format!("{} has no organization", sp.name),
                    detail: format!(
                        "DevLedger does not know which {} organization owns this resource. \
                         Assign it so the map is accurate.",
                        sp.provider.label()
                    ),
                    entity: EntityRef::new(EntityKind::ServiceProject, sp.id),
                });
            }
            // Unused is only a gap when it holds keys: they belong in some
            // project's vault. A resource written down by hand -- a paused
            // Supabase project, a repo nothing builds from -- is just a record.
            let holds_keys: i64 = self.conn().query_row(
                "SELECT count(*) FROM secrets WHERE service_project_id = ?1",
                params![sp.id.to_string()],
                |r| r.get(0),
            )?;
            if holds_keys > 0 && self.projects_using(sp.id)?.is_empty() {
                items.push(AttentionItem {
                    kind: AttentionKind::UnlinkedServiceProject,
                    title: format!("{} is not used by any project", sp.name),
                    detail: "Link it to the project that uses it, so its secrets appear in that \
                         project's vault."
                        .to_string(),
                    entity: EntityRef::new(EntityKind::ServiceProject, sp.id),
                });
            }
        }

        for identity in self.list_identities()? {
            if identity.email.is_none() {
                items.push(AttentionItem {
                    kind: AttentionKind::IdentityWithoutEmail,
                    title: format!("{} has no email", identity.label),
                    detail: "Without an email, DevLedger cannot match future pastes to this \
                             identity."
                        .to_string(),
                    entity: EntityRef::new(EntityKind::Identity, identity.id),
                });
            }
        }

        let orphan_sql = format!(
            "SELECT {} FROM secrets
              WHERE project_id IS NULL AND service_project_id IS NULL AND account_id IS NULL",
            Self::SECRET_COLUMNS
        );
        let mut stmt = self.conn().prepare(&orphan_sql)?;
        let raw = stmt
            .query_map([], Self::secret_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for entry in raw {
            let secret = Self::finish_secret(entry)?;
            items.push(AttentionItem {
                kind: AttentionKind::OrphanSecret,
                title: format!("{} is filed against nothing", secret.name),
                detail: "Attach it to a project, a resource or an account.".to_string(),
                entity: EntityRef::new(EntityKind::Secret, secret.id),
            });
        }

        let mut stmt = self.conn().prepare(
            "SELECT id, name FROM secrets s
              WHERE NOT EXISTS (SELECT 1 FROM secret_values v WHERE v.secret_id = s.id)",
        )?;
        let missing = stmt
            .query_map([], |row| Ok((uuid_from(row, 0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name) in missing {
            items.push(AttentionItem {
                kind: AttentionKind::SecretValueMissing,
                title: format!("{name} has no stored value"),
                detail: "This entry lost its encrypted value, which a DevLedger build before \
                         0.6.0 could do while upgrading a 0.3.0 vault. The value cannot be \
                         recovered. Delete the entry and store the credential again."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Secret, id),
            });
        }

        let mut stmt = self.conn().prepare(
            "SELECT a.identity_id, a.provider, count(*) FROM accounts a
              GROUP BY a.identity_id, a.provider HAVING count(*) > 1",
        )?;
        let ambiguous = stmt
            .query_map([], |row| {
                Ok((
                    uuid_from(row, 0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (identity_id, provider, count) in ambiguous {
            let provider = provider_from_str(&provider)?;
            let label = self
                .identity(identity_id)?
                .map(|i| i.label)
                .unwrap_or_else(|| "an identity".to_string());
            items.push(AttentionItem {
                kind: AttentionKind::AmbiguousProviderAccount,
                title: format!("{label} holds {count} {} accounts", provider.label()),
                detail: "That is fine, but a paste naming only the provider cannot say which \
                         account it belongs to. DevLedger will file it under the oldest one and \
                         tell you; move it from the map if it guessed wrong."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Identity, identity_id),
            });
        }

        items.extend(stale_secrets(&self.list_all_secrets()?, now));
        let subscriptions = self.list_subscriptions()?;
        items.extend(trials_ending(&subscriptions, now));
        items.extend(paying_twice(&subscriptions));

        Ok(items)
    }
}

/// How long a credential may go unchanged before DevLedger suggests rotating it.
pub const STALE_AFTER_DAYS: i64 = 365;

/// How many days before a trial ends DevLedger starts saying so.
pub const TRIAL_WARNING_DAYS: i64 = 7;

fn stale_secrets(secrets: &[SecretListing], now: OffsetDateTime) -> Vec<AttentionItem> {
    let cutoff = now - Duration::days(STALE_AFTER_DAYS);
    secrets
        .iter()
        .map(|l| &l.entry.secret)
        .filter(|s| s.kind != SecretKind::EnvVar && s.kind.is_client_unsafe())
        .filter(|s| s.updated_at < cutoff)
        .map(|s| {
            let days = (now - s.updated_at).whole_days();
            AttentionItem {
                kind: AttentionKind::StaleSecret,
                title: format!("{} has not changed in {} months", s.name, days / 30),
                detail: "Keys that live for years end up in old laptops, chat logs and former \
                         colleagues' .env files. Create a new one with the provider, press Replace \
                         value, then revoke the old one."
                    .to_string(),
                entity: EntityRef::new(EntityKind::Secret, s.id),
            }
        })
        .collect()
}

/// The date a trial ends, from an ISO date or a full RFC 3339 timestamp.
fn trial_end(raw: &str) -> Option<Date> {
    let day = raw.get(..10)?;
    let mut parts = day.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let date: u8 = parts.next()?.parse().ok()?;
    Date::from_calendar_date(year, Month::try_from(month).ok()?, date).ok()
}

fn trials_ending(subscriptions: &[SubscriptionSummary], now: OffsetDateTime) -> Vec<AttentionItem> {
    let today = now.date();
    let mut items = Vec::new();
    for s in subscriptions {
        let sub = &s.subscription;
        if sub.status != SubscriptionStatus::Trialing {
            continue;
        }
        let Some(end) = sub.trial_ends_at.as_deref().and_then(trial_end) else {
            continue;
        };
        let days = (end - today).whole_days();
        if days > TRIAL_WARNING_DAYS {
            continue;
        }
        let when = match days {
            d if d < 0 => format!("ended {} ago", plural_days(-d)),
            0 => "ends today".to_string(),
            1 => "ends tomorrow".to_string(),
            d => format!("ends in {d} days"),
        };
        let price = match (sub.amount_cents, sub.currency.as_deref()) {
            (Some(cents), Some(currency)) => {
                let per = match sub.interval {
                    Some(BillingInterval::Monthly) => "/month",
                    Some(BillingInterval::Yearly) => "/year",
                    None => "",
                };
                format!(
                    " It turns into {}.{:02} {currency}{per}",
                    cents / 100,
                    cents % 100
                )
            }
            _ => " It turns into a paid plan".to_string(),
        };
        items.push(AttentionItem {
            kind: AttentionKind::TrialEndingSoon,
            title: format!("{} trial on {} {when}", sub.plan, s.provider.label()),
            detail: format!(
                "{price} unless you cancel it with {}. Removing it here does not cancel it.",
                s.provider.label()
            )
            .trim_start()
            .to_string(),
            entity: EntityRef::new(EntityKind::Subscription, sub.id),
        });
    }
    items
}

fn plural_days(n: i64) -> String {
    if n == 1 {
        "1 day".to_string()
    } else {
        format!("{n} days")
    }
}

fn paying_twice(subscriptions: &[SubscriptionSummary]) -> Vec<AttentionItem> {
    let paid = |s: &&SubscriptionSummary| {
        matches!(
            s.subscription.status,
            SubscriptionStatus::Active | SubscriptionStatus::PastDue
        ) && s.subscription.amount_cents.unwrap_or(0) > 0
            && s.provider != Provider::Unknown
    };
    let mut by_provider: Vec<(Provider, Vec<&SubscriptionSummary>)> = Vec::new();
    for s in subscriptions.iter().filter(paid) {
        match by_provider.iter_mut().find(|(p, _)| *p == s.provider) {
            Some((_, list)) => list.push(s),
            None => by_provider.push((s.provider.clone(), vec![s])),
        }
    }
    by_provider
        .into_iter()
        .filter(|(_, list)| list.len() > 1)
        .map(|(provider, list)| {
            let plans: Vec<String> = list
                .iter()
                .map(|s| {
                    format!(
                        "{} on {}",
                        s.subscription.plan,
                        s.identity_email.as_deref().unwrap_or(&s.account_label)
                    )
                })
                .collect();
            AttentionItem {
                kind: AttentionKind::PayingTwice,
                title: format!("You pay for {} {} times", provider.label(), list.len()),
                detail: format!(
                    "{}. Fine if each is needed; otherwise one of them could go.",
                    plans.join(", ")
                ),
                entity: EntityRef::new(EntityKind::Subscription, list[0].subscription.id),
            }
        })
        .collect()
}
