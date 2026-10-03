//! Subscriptions and what they bill.

use rusqlite::{params, OptionalExtension, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{Provider, Subscription};
use crate::paste::ParsedSubscription;

use super::enums::*;
use super::rows::*;
use super::types::*;
use super::{now_rfc3339, parse_rfc3339, Store};

impl Store {
    // ----------------------------------------------------------- subscriptions

    /// Record a parsed subscription against an account.
    pub fn create_subscription(
        &self,
        account_id: Uuid,
        parsed: &ParsedSubscription,
    ) -> Result<Subscription> {
        let id = Uuid::new_v4();
        let created_at = now_rfc3339()?;
        self.conn().execute(
            "INSERT INTO subscriptions
                (id, account_id, plan, status, amount_cents, currency, interval,
                 trial_ends_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id.to_string(),
                account_id.to_string(),
                parsed.plan,
                subscription_status_to_str(parsed.status),
                parsed.amount_cents,
                parsed.currency,
                parsed.interval.map(billing_interval_to_str),
                parsed.trial_ends_at,
                created_at
            ],
        )?;
        self.audit(
            "subscription.create",
            Some("subscription"),
            Some(id),
            &format!("Recorded {} subscription", parsed.plan),
        )?;
        Ok(Subscription {
            id,
            account_id,
            plan: parsed.plan.clone(),
            status: parsed.status,
            amount_cents: parsed.amount_cents,
            currency: parsed.currency.clone(),
            interval: parsed.interval,
            trial_ends_at: parsed.trial_ends_at.clone(),
            created_at: parse_rfc3339(&created_at)?,
        })
    }

    /// Delete a subscription.
    pub fn delete_subscription(&self, subscription_id: Uuid) -> Result<()> {
        let changed = self.conn().execute(
            "DELETE FROM subscriptions WHERE id = ?1",
            params![subscription_id.to_string()],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "subscription {subscription_id}"
            )));
        }
        self.audit(
            "subscription.delete",
            Some("subscription"),
            Some(subscription_id),
            "Deleted subscription",
        )?;
        Ok(())
    }

    pub(super) const SUBSCRIPTION_COLUMNS: &'static str =
        "id, account_id, plan, status, amount_cents, currency, interval, trial_ends_at, created_at";

    pub(super) fn subscription_from_row(
        row: &Row<'_>,
    ) -> rusqlite::Result<(Subscription, String, Option<String>, String)> {
        let status: String = row.get(3)?;
        let interval: Option<String> = row.get(6)?;
        let created: String = row.get(8)?;
        Ok((
            Subscription {
                id: uuid_from(row, 0)?,
                account_id: uuid_from(row, 1)?,
                plan: row.get(2)?,
                status: crate::model::SubscriptionStatus::Unknown,
                amount_cents: row.get(4)?,
                currency: row.get(5)?,
                interval: None,
                trial_ends_at: row.get(7)?,
                created_at: OffsetDateTime::UNIX_EPOCH,
            },
            status,
            interval,
            created,
        ))
    }

    pub(super) fn finish_subscription(
        entry: (Subscription, String, Option<String>, String),
    ) -> Result<Subscription> {
        let (mut sub, status, interval, created) = entry;
        sub.status = subscription_status_from_str(&status)?;
        sub.interval = match interval {
            Some(i) => Some(billing_interval_from_str(&i)?),
            None => None,
        };
        sub.created_at = parse_rfc3339(&created)?;
        Ok(sub)
    }

    /// Subscriptions attached to an account.
    pub fn subscriptions_for_account(&self, account_id: Uuid) -> Result<Vec<Subscription>> {
        let sql = format!(
            "SELECT {} FROM subscriptions WHERE account_id = ?1 ORDER BY created_at",
            Self::SUBSCRIPTION_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map(params![account_id.to_string()], Self::subscription_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(Self::finish_subscription).collect()
    }

    /// Every subscription in the vault, with the account behind it.
    pub fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>> {
        let sql = format!(
            "SELECT {} FROM subscriptions ORDER BY created_at DESC",
            Self::SUBSCRIPTION_COLUMNS
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let raw = stmt
            .query_map([], Self::subscription_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::with_capacity(raw.len());
        for entry in raw {
            let subscription = Self::finish_subscription(entry)?;
            let row: Option<(String, String, Option<String>)> = self
                .conn()
                .query_row(
                    "SELECT a.label, a.provider, i.email FROM accounts a
                     JOIN identities i ON i.id = a.identity_id
                     WHERE a.id = ?1",
                    params![subscription.account_id.to_string()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let (account_label, provider, identity_email) = match row {
                Some((label, provider, email)) => (label, provider_from_str(&provider)?, email),
                None => ("Unknown account".to_string(), Provider::Unknown, None),
            };
            out.push(SubscriptionSummary {
                subscription,
                provider,
                account_label,
                identity_email,
            });
        }
        Ok(out)
    }
}
